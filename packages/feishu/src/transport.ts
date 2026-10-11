import { randomUUID } from "node:crypto";
import * as lark from "@larksuiteoapi/node-sdk";
import { credentialRef, type CredentialProvider } from "@deepseek-ai/dsh-credentials";
import type { Bridge } from "./bridge.js";
import { renderCard } from "./cards.js";
import {
  record,
  text,
  safeError,
  type Channel,
  type IncomingAction,
  type IncomingMessage,
  type MaintenanceAgent,
} from "./types.js";

export const requiredScopes = ["im:message:send_as_bot", "im:message.p2p_msg:readonly"];
export const requiredEvents = ["im.message.receive_v1"];
export const requiredCallbacks = ["card.action.trigger"];

// SDK token acquisition and all API calls share a bounded HTTP transport.
const httpInstance = new Proxy(lark.defaultHttpInstance, {
  get(target, property) {
    const method = Reflect.get(target, property);
    if (
      typeof method !== "function" ||
      !["request", "get", "delete", "head", "options", "post", "put", "patch"].includes(
        String(property),
      )
    )
      return method;
    return (...args: unknown[]) => {
      const index =
        property === "request" ? 0 : ["post", "put", "patch"].includes(String(property)) ? 2 : 1;
      args[index] = { timeout: 30000, ...(record(args[index]) ? args[index] : {}) };
      return Reflect.apply(method, target, args);
    };
  },
}) as unknown as NonNullable<ConstructorParameters<typeof lark.Client>[0]["httpInstance"]>;

interface Runtime {
  appId: string;
  secret: string;
  client: lark.Client;
  ws?: lark.WSClient;
  last_message_at?: number;
  last_action_at?: number;
  error?: string;
}
export type Credentials = Pick<CredentialProvider, "resolve" | "set" | "describe">;
const field = (value: unknown) => (typeof value === "string" ? value : "");

/** Narrow parsing keeps callback tokens and SDK/Axios objects out of durable data and logs. */
export function parseMessage(raw: unknown): IncomingMessage | undefined {
  if (!record(raw)) return;
  const event = record(raw.event) ? raw.event : raw;
  if (!record(event.message) || !record(event.sender)) return;
  const message = event.message;
  const sender = event.sender;
  if (
    !record(sender.sender_id) ||
    message.message_type !== "text" ||
    typeof message.content !== "string"
  )
    return;
  let content: unknown;
  try {
    content = JSON.parse(message.content);
  } catch {
    return;
  }
  if (!record(content) || typeof content.text !== "string") return;
  return {
    messageId: field(message.message_id),
    chatId: field(message.chat_id),
    chatType: field(message.chat_type),
    openId: field(sender.sender_id.open_id),
    senderType: field(sender.sender_type),
    text: content.text,
    ...(typeof message.create_time === "string" ? { sourceTime: message.create_time } : {}),
  };
}
export function parseAction(raw: unknown): IncomingAction | undefined {
  if (!record(raw)) return;
  const event = record(raw.event) ? raw.event : raw;
  if (
    !record(event.operator) ||
    !record(event.action) ||
    !record(event.action.value) ||
    !record(event.context)
  )
    return;
  const value = event.action.value;
  if (typeof value.dsh_card_id !== "string" || typeof value.action_id !== "string") return;
  return {
    eventId: record(raw.header) ? field(raw.header.event_id) : "",
    messageId: field(event.context.open_message_id),
    chatId: field(event.context.open_chat_id),
    openId: field(event.operator.open_id),
    cardId: value.dsh_card_id,
    actionId: value.action_id,
    ...(record(raw.header) && typeof raw.header.create_time === "string"
      ? { sourceTime: raw.header.create_time }
      : {}),
  };
}

export class Transport<A extends MaintenanceAgent> {
  readonly runtimes = new Map<string, Runtime>();
  private stopped = false;
  private syncing?: Promise<void>;
  private reconcileChain: Promise<void> = Promise.resolve();
  private reconnectTimer?: NodeJS.Timeout;
  private cardRetry?: NodeJS.Timeout;
  private readonly cardSends = new Map<string, Promise<unknown>>();

  constructor(
    readonly bridge: Bridge<A>,
    readonly credentials: Credentials,
  ) {
    bridge.onCardsChanged = () => this.syncCards();
  }
  private readonly logger: lark.Logger = {
    debug() {},
    info() {},
    trace() {},
    warn() {},
    error() {},
  };

  private async values(channel: Channel) {
    const id = await this.credentials.resolve(credentialRef(channel.app_id_ref));
    const secret = await this.credentials.resolve(credentialRef(channel.app_secret_ref));
    if (!id?.value || !secret?.value) throw new Error("应用凭据尚未配置，请完成扫码接入。");
    if (!/^cli_[A-Za-z0-9]+$/.test(id.value)) throw new Error("应用 ID 凭据格式无效。");
    return { appId: id.value, secret: secret.value };
  }

  private async ensure(channel: Channel): Promise<Runtime> {
    if (this.stopped || !channel.enabled) throw new Error("通道已停用。");
    const values = await this.values(channel);
    if (this.stopped) throw new Error("插件已停止。");
    const prior = this.runtimes.get(channel.id);
    if (prior && prior.appId === values.appId && prior.secret === values.secret) return prior;
    for (const [id, runtime] of this.runtimes) {
      if (id !== channel.id && runtime.appId === values.appId)
        throw new Error("同一个应用已由另一个通道连接，不能建立第二条竞争连接。");
    }
    prior?.ws?.close({ force: true });
    const runtime: Runtime = {
      ...values,
      client: new lark.Client({
        appId: values.appId,
        appSecret: values.secret,
        appType: lark.AppType.SelfBuild,
        domain: lark.Domain.Feishu,
        httpInstance,
        logger: this.logger,
        loggerLevel: lark.LoggerLevel.error,
      }),
    };
    this.runtimes.set(channel.id, runtime);
    return runtime;
  }

  async connect(id: string) {
    const channel = this.bridge.channel(id);
    const runtime = await this.ensure(channel);
    if (runtime.ws) return;
    const dispatcher = new lark.EventDispatcher({
      logger: this.logger,
      loggerLevel: lark.LoggerLevel.error,
    });
    dispatcher.register({
      "im.message.receive_v1": async (data: unknown) => {
        if (this.stopped || this.runtimes.get(id) !== runtime) return;
        const message = parseMessage(data);
        if (message && this.bridge.receiveMessage(id, message))
          runtime.last_message_at = Date.now();
      },
      "card.action.trigger": async (data: unknown) => {
        if (this.stopped || this.runtimes.get(id) !== runtime) return {};
        const action = parseAction(data);
        if (!action) return {};
        try {
          const response = this.bridge.receiveAction(id, action);
          if (Object.keys(response).length) runtime.last_action_at = Date.now();
          return response;
        } catch {
          runtime.error = "卡片事件保存失败，未确认接收。";
          // Failing the protocol response lets Feishu retry instead of losing the action.
          throw new Error("Feishu event persistence failed");
        }
      },
    });
    runtime.ws = new lark.WSClient({
      appId: runtime.appId,
      appSecret: runtime.secret,
      domain: lark.Domain.Feishu,
      autoReconnect: true,
      httpInstance,
      logger: this.logger,
      loggerLevel: lark.LoggerLevel.error,
      wsConfig: { pingTimeout: 90 },
      onReady: () => {
        delete runtime.error;
        this.syncCards();
      },
      onReconnected: () => {
        delete runtime.error;
        this.syncCards();
      },
      onError: () => {
        runtime.error = "长连接出现错误，请检查网络和飞书长连接配置。";
      },
    });
    await runtime.ws.start({ eventDispatcher: dispatcher });
  }
  reconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      void this.reconcile(true);
    }, 150);
    this.reconnectTimer.unref();
  }
  reconcile(force = false): Promise<void> {
    this.reconcileChain = this.reconcileChain
      .then(async () => {
        if (this.stopped) return;
        for (const channel of this.bridge.store.data.channels) {
          const runtime = this.runtimes.get(channel.id);
          if (force || !channel.enabled) {
            runtime?.ws?.close({ force: true });
            this.runtimes.delete(channel.id);
          }
          if (channel.enabled) {
            try {
              await this.connect(channel.id);
            } catch {
              this.bridge.host.warn(
                `feishu: 通道 ${channel.label} 尚未连接，请运行 feishu_check。`,
              );
            }
          }
        }
      })
      .catch(() => {
        this.bridge.host.warn("feishu: 通道连接检查失败。");
      });
    return this.reconcileChain;
  }
  status(id: string): Record<string, unknown> {
    const runtime = this.runtimes.get(id);
    const channel = this.bridge.channel(id);
    return {
      state: channel.enabled
        ? (runtime?.ws?.getConnectionStatus().state ?? "not_connected")
        : "disabled",
      ...(runtime?.last_message_at
        ? { last_message_at: new Date(runtime.last_message_at).toISOString() }
        : {}),
      ...(runtime?.last_action_at
        ? { last_action_at: new Date(runtime.last_action_at).toISOString() }
        : {}),
      ...(runtime?.error ? { error: runtime.error } : {}),
    };
  }

  async check(id: string) {
    const channel = this.bridge.channel(id);
    const credentials = {
      app_id: await this.credentials.describe(credentialRef(channel.app_id_ref)),
      app_secret: await this.credentials.describe(credentialRef(channel.app_secret_ref)),
    };
    const result: Record<string, unknown> = {
      channel_id: id,
      credentials,
      connection: this.status(id),
      required_scopes: requiredScopes,
      required_events: requiredEvents,
      required_callbacks: requiredCallbacks,
      event_verification:
        "长连接成功不代表事件订阅正确；请实际发送文字和点击测试卡片，再检查接收记录。",
    };
    try {
      const runtime = await this.ensure(channel);
      result.console_url = `https://open.feishu.cn/app/${runtime.appId}`;
      const bot = await runtime.client.request<{
        code?: number;
        bot?: { open_id?: string; app_name?: string };
      }>({ method: "GET", url: "/open-apis/bot/v3/info" });
      checkResponse(bot);
      result.bot = {
        verified: true,
        open_id: bot.bot?.open_id ?? "",
        name: bot.bot?.app_name ?? "",
      };
      try {
        const scopes = await runtime.client.application.scope.list();
        checkResponse(scopes);
        result.scope_status = (scopes.data?.scopes ?? []).map((s) => ({
          name: s.scope_name,
          type: s.scope_type ?? "tenant",
          grant_status: s.grant_status ?? "unknown",
        }));
      } catch {
        result.scope_status = "查询不可用，请通过配置入口核对权限。";
      }
    } catch (error) {
      result.error = safeError(error);
    }
    return result;
  }

  async send(id: string, sessionId: string, content: string, requestId?: string, cardId?: string) {
    this.bridge.requireOwner(id, sessionId);
    text(content, "消息内容", 30000);
    const uuid = requestId ?? randomUUID();
    if (!/^[A-Za-z0-9_-]{1,50}$/.test(uuid))
      throw new Error("request_id 必须是 1–50 个英文字母、数字、连字符或下划线。");
    const existing = this.bridge.store.data.outbound.find((o) => o.id === uuid);
    if (existing) {
      if (existing.channel_id !== id || existing.content !== content || existing.card_id !== cardId)
        throw new Error("request_id 已用于其他消息。");
      return structuredClone(existing);
    }
    const runtime = await this.ensure(this.bridge.channel(id));
    const channel = this.bridge.requireOwner(id, sessionId);
    const raced = this.bridge.store.data.outbound.find((o) => o.id === uuid);
    if (raced) {
      if (raced.channel_id !== id || raced.content !== content || raced.card_id !== cardId)
        throw new Error("request_id 已用于其他消息。");
      return structuredClone(raced);
    }
    if (cardId && Buffer.byteLength(content, "utf8") > 28000)
      throw new Error("卡片内容过大，请缩短内容后重新创建。");
    this.bridge.store.transaction((data) => {
      data.outbound.push({
        id: uuid,
        channel_id: id,
        origin_session_id: sessionId,
        content,
        ...(cardId ? { card_id: cardId } : {}),
        created_at: Date.now(),
        state: "sending",
      });
    });
    try {
      const response = await runtime.client.im.message.create({
        params: { receive_id_type: "open_id" },
        data: {
          receive_id: channel.authorized_open_id,
          msg_type: cardId ? "interactive" : "text",
          content: cardId ? content : JSON.stringify({ text: content }),
          uuid,
        },
      });
      checkResponse(response);
      if (!response.data?.message_id) throw new Error("消息 ID 缺失。");
      const messageId = response.data.message_id;
      this.bridge.store.transaction((data) => {
        const item = data.outbound.find((o) => o.id === uuid)!;
        item.state = "sent";
        item.message_id = messageId;
        if (cardId) this.bridge.card(cardId).message_id = messageId;
      });
      return structuredClone(this.bridge.store.data.outbound.find((o) => o.id === uuid)!);
    } catch (error) {
      this.bridge.store.transaction((data) => {
        const item = data.outbound.find((o) => o.id === uuid);
        if (item) item.state = "uncertain";
      });
      throw new Error(
        `${safeError(error)} 发送结果不确定，请检查飞书记录，不要更换 request_id 重发。`,
      );
    }
  }

  async sendCard(
    id: string,
    sessionId: string,
    input: { title: unknown; content: unknown; choices: unknown; expires_at: unknown },
    requestId?: string,
  ) {
    const previous = requestId ? this.cardSends.get(requestId) : undefined;
    if (previous) await previous.catch(() => {});
    const operation = this.sendCardOnce(id, sessionId, input, requestId);
    if (requestId) this.cardSends.set(requestId, operation);
    try {
      return await operation;
    } finally {
      if (requestId && this.cardSends.get(requestId) === operation)
        this.cardSends.delete(requestId);
    }
  }
  private async sendCardOnce(
    id: string,
    sessionId: string,
    input: { title: unknown; content: unknown; choices: unknown; expires_at: unknown },
    requestId?: string,
  ) {
    if (requestId) {
      const existing = this.bridge.store.data.outbound.find((o) => o.id === requestId);
      if (existing) {
        this.bridge.requireOwner(id, sessionId);
        if (existing.channel_id !== id || !existing.card_id)
          throw new Error("request_id 已用于其他消息。");
        const card = this.bridge.card(existing.card_id);
        if (
          card.title !== input.title ||
          card.content !== input.content ||
          JSON.stringify(card.choices) !== JSON.stringify(input.choices) ||
          card.expires_at !== Date.parse(String(input.expires_at))
        )
          throw new Error("request_id 已用于其他卡片。");
        return { card: structuredClone(card), send: structuredClone(existing) };
      }
    }
    const card = this.bridge.createCard(id, sessionId, input);
    const send = await this.send(
      id,
      sessionId,
      JSON.stringify(renderCard(card)),
      requestId,
      card.id,
    );
    return { card: structuredClone(this.bridge.card(card.id)), send };
  }

  syncCards() {
    if (this.stopped || this.syncing) return;
    this.syncing = this.updateDirtyCards()
      .catch(() => {
        this.bridge.host.warn("feishu: 卡片状态更新失败，将保留更新意图重试。");
      })
      .finally(() => {
        this.syncing = undefined;
        if (
          !this.stopped &&
          this.bridge.store.data.cards.some(
            (c) =>
              c.dirty &&
              c.message_id &&
              this.bridge.channel(c.channel_id).enabled &&
              Date.now() - c.created_at < 14 * 86400000,
          )
        ) {
          clearTimeout(this.cardRetry);
          this.cardRetry = setTimeout(() => {
            this.syncCards();
          }, 30000);
          this.cardRetry.unref();
        }
      });
  }
  private async updateDirtyCards() {
    for (const card of this.bridge.store.data.cards.filter((c) => c.dirty && c.message_id)) {
      if (this.stopped) return;
      if (Date.now() - card.created_at >= 14 * 86400000) continue;
      const channel = this.bridge.channel(card.channel_id);
      if (!channel.enabled) continue;
      try {
        const runtime = await this.ensure(channel);
        const revision = card.revision;
        const response = await runtime.client.im.message.patch({
          path: { message_id: card.message_id! },
          data: { content: JSON.stringify(renderCard(card)) },
        });
        checkResponse(response);
        this.bridge.store.transaction(() => {
          const current = this.bridge.card(card.id);
          if (current.revision === revision) current.dirty = false;
        });
      } catch {
        this.bridge.host.warn(`feishu: 卡片 ${card.id} 更新失败，已保留更新意图。`);
      }
    }
  }

  async close() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.cardRetry);
    for (const runtime of this.runtimes.values()) runtime.ws?.close({ force: true });
    await this.reconcileChain;
    await this.syncing;
    for (const runtime of this.runtimes.values()) runtime.ws?.close({ force: true });
    this.runtimes.clear();
  }
}
export function checkResponse(response: { code?: number }) {
  if (response.code !== 0 && response.code !== undefined) {
    const error = new Error(`Feishu API code=${response.code}`);
    Object.assign(error, { code: response.code });
    throw error;
  }
}
