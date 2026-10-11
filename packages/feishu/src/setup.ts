import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import QRCode from "qrcode";
import { registerApp } from "@larksuiteoapi/node-sdk";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  requiredCallbacks,
  requiredEvents,
  requiredScopes,
  type Credentials,
} from "./transport.js";
import type { Bridge } from "./bridge.js";
import { identifier, text, safeError, type MaintenanceAgent } from "./types.js";

interface Job {
  id: string;
  channel_id: string;
  label: string;
  state: "preparing" | "awaiting_scan" | "needs_user" | "completed" | "failed" | "cancelled";
  controller: AbortController;
  url?: string;
  qr_path?: string;
  expires_at?: string;
  error?: string;
  open_id?: string;
  app_id_ref: string;
  app_secret_ref: string;
  channel_revision?: number;
  promise?: Promise<void>;
}

/** Split flow: no tool holds an Agent turn open while waiting for a human to scan. */
export class Setup<A extends MaintenanceAgent> {
  private readonly jobs = new Map<string, Job>();
  private stopped = false;
  constructor(
    readonly bridge: Bridge<A>,
    readonly credentials: Credentials,
    readonly onConfigured: () => Promise<void>,
    readonly register = registerApp,
  ) {}

  async qr(url: string, id: string = randomUUID()) {
    const directory = join(this.bridge.store.directory, "qrcodes");
    await mkdir(directory, { recursive: true });
    const file = join(directory, `${id}.png`);
    await QRCode.toFile(file, url, { width: 360, margin: 3, errorCorrectionLevel: "M" });
    return {
      verification_url: url,
      qr_path: file,
      display_markdown: `[打开飞书配置页面](${url})\n\n![飞书配置二维码](${file.replaceAll("\\", "/")})`,
    };
  }

  async start(input: {
    mode: string;
    channel_id?: string;
    existing_app_id?: string;
    label?: string;
    authorized_open_id?: string;
    additional_scopes?: string[];
  }) {
    if (this.stopped) throw new Error("插件正在停止。");
    if (!["create", "existing", "update"].includes(input.mode))
      throw new Error("mode 必须为 create、existing 或 update。");
    const channel = input.channel_id ? this.bridge.channel(input.channel_id) : undefined;
    if (input.mode === "update" && !channel) throw new Error("更新配置必须指定现有 channel_id。");
    let appId = input.existing_app_id;
    if (channel) appId = (await this.credentials.resolve(credentialRef(channel.app_id_ref)))?.value;
    if (input.mode !== "create") identifier(appId, "cli_");
    const openId = input.authorized_open_id ?? channel?.authorized_open_id;
    if (openId) identifier(openId, "ou_");
    const additionalScopes = input.additional_scopes ?? [];
    if (
      additionalScopes.length > 100 ||
      additionalScopes.some((s) => !/^[A-Za-z0-9_:.-]{1,150}$/.test(s))
    )
      throw new Error("additional_scopes 格式无效。");
    const channelId = channel?.id ?? randomUUID();
    if (
      [...this.jobs.values()].some(
        (j) =>
          j.channel_id === channelId &&
          ["preparing", "awaiting_scan", "needs_user"].includes(j.state),
      )
    )
      throw new Error("该通道已有进行中的扫码流程，请查看结果或先取消。");
    if (this.jobs.size >= 50) {
      for (const [id, job] of this.jobs)
        if (["completed", "failed", "cancelled"].includes(job.state)) this.jobs.delete(id);
      if (this.jobs.size >= 50) throw new Error("扫码流程过多，请先取消旧流程。");
    }
    const suffix = channelId.replaceAll("-", "_").toUpperCase();
    const job: Job = {
      id: randomUUID(),
      channel_id: channelId,
      label: input.label ?? channel?.label ?? "飞书机器人",
      state: "preparing",
      ...(channel ? { channel_revision: channel.revision } : {}),
      controller: new AbortController(),
      app_id_ref: channel?.app_id_ref ?? `COSINE_FEISHU_${suffix}_APP_ID`,
      app_secret_ref: channel?.app_secret_ref ?? `COSINE_FEISHU_${suffix}_APP_SECRET`,
      ...(openId ? { open_id: openId } : {}),
    };
    text(job.label, "通道名称", 100);
    this.jobs.set(job.id, job);
    let ready!: () => void;
    const qrReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const timeout = setTimeout(ready, 15000);
    job.promise = this.register({
      source: "cosine-dsh-feishu",
      signal: job.controller.signal,
      createOnly: input.mode === "create",
      ...(input.mode === "create" ? {} : { appId }),
      appPreset: { name: job.label, desc: "DeepSeek Harness 个人双向消息通道" },
      addons: {
        preset: false,
        scopes: { tenant: [...new Set([...requiredScopes, ...additionalScopes])] },
        events: { items: { tenant: requiredEvents } },
        callbacks: { items: requiredCallbacks },
      },
      onQRCodeReady: (info) => {
        if (this.stopped || job.controller.signal.aborted) return;
        job.url = info.url;
        job.expires_at = new Date(Date.now() + info.expireIn * 1000).toISOString();
        job.state = "awaiting_scan";
        void this.qr(info.url, job.id)
          .then((qr) => {
            job.qr_path = qr.qr_path;
            ready();
          })
          .catch(() => {
            job.error = "二维码图片生成失败，请使用返回的原始配置链接。";
            ready();
          });
      },
    })
      .then(async (result) => {
        if (this.stopped || job.controller.signal.aborted) return;
        if (input.mode !== "create" && result.client_id !== appId)
          throw new Error("扫码返回了不同的应用，未接入。");
        identifier(result.client_id, "cli_");
        text(result.client_secret, "应用凭据", 4096);
        const duplicate = this.bridge.store.data.channels.find(
          (c) => c.id !== channelId && c.app_id_ref !== job.app_id_ref,
        );
        // Compare actual app identities, even if users supplied different ref names.
        if (duplicate) {
          for (const candidate of this.bridge.store.data.channels.filter(
            (c) => c.id !== channelId,
          )) {
            if (
              (await this.credentials.resolve(credentialRef(candidate.app_id_ref)))?.value ===
              result.client_id
            )
              throw new Error("该应用已有通道，请在原通道上更新配置。");
          }
        }
        await this.credentials.set(credentialRef(job.app_id_ref), result.client_id);
        await this.credentials.set(credentialRef(job.app_secret_ref), result.client_secret);
        if (this.stopped || job.controller.signal.aborted) return;
        job.open_id ??= result.user_info?.open_id;
        if (!job.open_id) {
          job.state = "needs_user";
          return;
        }
        await this.complete(job);
      })
      .catch((error) => {
        job.state = job.controller.signal.aborted ? "cancelled" : "failed";
        job.error = safeError(error);
        ready();
      })
      .finally(() => {
        clearTimeout(timeout);
        ready();
      });
    await qrReady;
    return this.view(job);
  }

  private async complete(job: Job) {
    if (this.stopped || job.controller.signal.aborted) return;
    this.bridge.configure({
      id: job.channel_id,
      revision: job.channel_revision,
      label: job.label,
      appIdRef: job.app_id_ref,
      appSecretRef: job.app_secret_ref,
      openId: job.open_id!,
    });
    job.state = "completed";
    await this.onConfigured();
  }
  async status(id?: string, openId?: string) {
    if (!id) return [...this.jobs.values()].map((j) => this.view(j));
    const job = this.jobs.get(id);
    if (!job) throw new Error("扫码流程不存在；重启后请重新发起。");
    if (openId) {
      if (job.state !== "needs_user") throw new Error("只有 needs_user 状态需要补充授权用户。");
      identifier(openId, "ou_");
      job.open_id = openId;
      await this.complete(job);
    }
    return this.view(job);
  }
  cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("扫码流程不存在。");
    if (["completed", "failed", "cancelled"].includes(job.state)) return this.view(job);
    job.controller.abort();
    job.state = "cancelled";
    return this.view(job);
  }
  private view(job: Job) {
    return {
      job_id: job.id,
      channel_id: job.channel_id,
      state: job.state,
      ...(job.url && ["awaiting_scan", "preparing"].includes(job.state)
        ? {
            verification_url: job.url,
            ...(job.qr_path
              ? {
                  qr_path: job.qr_path,
                  display_markdown: `[打开飞书配置页面](${job.url})\n\n![飞书配置二维码](${job.qr_path.replaceAll("\\", "/")})`,
                }
              : {}),
            expires_at: job.expires_at,
          }
        : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.state === "completed"
        ? { next: "调用 feishu_check 验证配置，再由目标 Session 主动调用 feishu_subscribe。" }
        : {}),
      ...(job.state === "needs_user"
        ? {
            next: "扫码结果未包含用户 open_id；确认授权用户后，通过 feishu_setup_status 补充 authorized_open_id。",
          }
        : {}),
    };
  }
  async close() {
    this.stopped = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled(
      [...this.jobs.values()].flatMap((j) => (j.promise ? [j.promise] : [])),
    );
  }
}
