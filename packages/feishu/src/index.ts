import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  defineTool,
  type ParameterPropertySpec,
  type ParameterSchemaSpec,
} from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type {} from "@deepseek-ai/dsh-skill";
import type {} from "@deepseek-ai/dsh-workspace";
import type {} from "@deepseek-ai/dsh-credentials";
import { Store } from "./store.js";
import { Bridge } from "./bridge.js";
import { Transport } from "./transport.js";
import { Setup } from "./setup.js";
import { safeError } from "./types.js";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "cosine-feishu": { kind: "cosine-feishu" };
  }
}
declare module "@deepseek-ai/dsh-workspace/types" {
  interface SessionActivityKindMap {
    schedule: true;
  }
}
export const name = "cosine-feishu";
export const inject = ["agents", "sessions", "tools", "sessionPersistence", "credentials"];
const string = (description: string, required = false): ParameterPropertySpec => ({
  type: "string",
  description,
  ...(required ? { required: true } : {}),
});
const channel = string("通道 ID，来自 feishu_status。", true);
const revision: ParameterPropertySpec = {
  type: "integer",
  required: true,
  description: "先查询当前 revision，避免覆盖其他 Session 的修改。",
};
type Definition = [
  string,
  string,
  ParameterSchemaSpec,
  (args: Record<string, unknown>, sessionId: string) => unknown,
];

export function apply(ctx: Context) {
  let bridge: Bridge<Agent>;
  try {
    bridge = new Bridge(new Store(join(resolveDshHome(), "storages", name)), {
      get: (id) => ctx.agents.roots().find((a) => String(a.session.id ?? a.id) === id),
      flush: (agent) => ctx.sessions.flush(agent.session),
      detached: (operation) => ctx.agents.withoutInitiator(operation),
      warn: (message) => ctx.logger.warn(message),
      deliver: (agent, message) =>
        agent.followup(
          createUserMessage({ content: [{ type: "text", text: message }], source: { kind: name } }),
        ),
    });
  } catch {
    ctx.logger.warn("feishu: 存储初始化失败，插件未启动；请检查存储文件和实例锁。");
    return;
  }
  const transport = new Transport(bridge, ctx.credentials);
  const setup = new Setup(bridge, ctx.credentials, () => transport.reconcile(true));
  const sid = (agent: Agent) => String(agent.session.id ?? agent.id);
  const definitions: Definition[] = [
    [
      "feishu_status",
      "查看所有机器人通道、唯一订阅 Session、revision 和连接状态；不会订阅。",
      {},
      () =>
        bridge.store.data.channels.map((c) => ({
          ...structuredClone(c),
          connection: transport.status(c.id),
          subscriber_loaded: !!c.session_id && !!bridge.host.get(c.session_id),
          pending: bridge.events(c.id, "pending", 500).length,
        })),
    ],
    [
      "feishu_sessions",
      "列出已加载的根 Session；不会恢复历史会话。",
      {},
      (_args, current) => ({
        current_session_id: current,
        sessions: ctx.agents.roots().map((a) => ({ session_id: sid(a), status: a.status })),
      }),
    ],
    [
      "feishu_setup_start",
      "先读取 dsh-feishu skill。发起创建或接入现有应用的扫码流程，立即返回二维码/链接；不等待人类授权。",
      {
        mode: { type: "string", enum: ["create", "existing", "update"], required: true },
        channel_id: string("update 时指定已有通道。"),
        existing_app_id: string("existing 时指定已有应用 ID；凭据仍由扫码写入 DSH。"),
        label: string("通道名称"),
        authorized_open_id: string("授权用户 open_id；可从扫码结果获取。"),
        additional_scopes: {
          type: "array",
          items: { type: "string" },
          description: "仅在用户要求新增能力时添加权限，仍需用户扫码批准。",
        },
      },
      (args) => setup.start(args as Parameters<typeof setup.start>[0]),
    ],
    [
      "feishu_setup_status",
      "查询扫码状态；needs_user 时可补充授权用户。重启后未完成流程需重新发起。",
      {
        job_id: string("流程 ID，省略列出全部。"),
        authorized_open_id: string("仅 needs_user 状态使用。"),
      },
      (args) =>
        setup.status(
          args.job_id as string | undefined,
          args.authorized_open_id as string | undefined,
        ),
    ],
    [
      "feishu_setup_cancel",
      "取消未完成的扫码流程。",
      { job_id: string("流程 ID", true) },
      (args) => setup.cancel(args.job_id as string),
    ],
    [
      "feishu_configure",
      "接入已存入 DSH 凭据服务的应用；只能传凭据引用名，禁止传明文 secret。通常优先扫码接入。",
      {
        channel_id: string("更新已有通道时指定。"),
        label: string("通道名称", true),
        app_id_ref: string("DSH 应用 ID 凭据引用名", true),
        app_secret_ref: string("DSH 应用 secret 凭据引用名", true),
        revision: {
          type: "integer",
          description: "更新已有通道时必填最新 revision。",
        },
        authorized_open_id: string("唯一授权用户 open_id", true),
      },
      async (args) => {
        const value = bridge.configure({
          id: args.channel_id as string | undefined,
          revision: args.revision,
          label: args.label as string,
          appIdRef: args.app_id_ref as string,
          appSecretRef: args.app_secret_ref as string,
          openId: args.authorized_open_id as string,
        });
        await transport.reconcile(true);
        return value;
      },
    ],
    [
      "feishu_check",
      "检查凭据、机器人身份、权限和长连接。按返回链接检查事件及卡片回调均使用长连接，并实际测试收事件。",
      { channel_id: channel },
      async (args) => {
        const result = await transport.check(args.channel_id as string);
        return {
          ...result,
          ...(typeof result.console_url === "string" ? await setup.qr(result.console_url) : {}),
        };
      },
    ],
    [
      "feishu_reconnect",
      "修复飞书配置后重新建立长连接；正常断线由 SDK 自动重连。",
      {},
      async () => {
        await transport.reconcile(true);
        return { restarted: true };
      },
    ],
    [
      "feishu_subscribe",
      "当前 Session 主动订阅通道；每个机器人只允许一个订阅者，不补投无人订阅期间的历史消息。",
      { channel_id: channel, revision },
      (args, current) => bridge.subscribe(args.channel_id as string, current, args.revision),
    ],
    [
      "feishu_transfer",
      "明确转交唯一订阅者。尚未投递的事件及旧卡片后续点击都交给新 Session，已投递消息不撤回。",
      { channel_id: channel, revision, target_session_id: string("省略转交给当前 Session。") },
      (args, current) =>
        bridge.subscribe(
          args.channel_id as string,
          (args.target_session_id as string) ?? current,
          args.revision,
          true,
        ),
    ],
    [
      "feishu_unsubscribe",
      "取消通道订阅；仍保持收事件并记录，后续不唤醒 Session。",
      { channel_id: channel, revision },
      (args) => bridge.unsubscribe(args.channel_id as string, args.revision),
    ],
    [
      "feishu_connection",
      "启用或停用通道长连接；保留订阅关系，停用期间不接收消息。",
      { channel_id: channel, revision, enabled: { type: "boolean", required: true } },
      async (args) => {
        const value = bridge.enable(
          args.channel_id as string,
          args.revision,
          args.enabled as boolean,
        );
        await transport.reconcile();
        return value;
      },
    ],
    [
      "feishu_send_text",
      "以机器人身份发送文字，只允许当前订阅 Session。request_id 可复用查询发送结果；uncertain 不自动重发。",
      {
        channel_id: channel,
        text: string("消息内容", true),
        request_id: string("1–50 位英文、数字、连字符或下划线；同一消息重试保持不变。"),
      },
      (args, current) =>
        transport.send(
          args.channel_id as string,
          current,
          args.text as string,
          args.request_id as string | undefined,
        ),
    ],
    [
      "feishu_send_card",
      "发送带按钮的确认卡片。必须由 Agent 明确指定 expires_at；点击仅投递意愿，实际操作需按当前条件重新判断。",
      {
        channel_id: channel,
        title: string("标题", true),
        content: string("完整信号/请求上下文", true),
        expires_at: string(
          "含时区的 ISO 有效截止时间，必须在未来且不超过14天；根据业务选择，通常可用24小时。",
          true,
        ),
        request_id: string("发送幂等 ID"),
        choices: {
          type: "array",
          required: true,
          items: {
            type: "object",
            additionalProperties: false,
            properties: { id: string("动作 ID", true), label: string("按钮文字", true) },
          },
          description: "2–6 个按钮，例如 execute/执行、ignore/忽略。",
        },
      },
      (args, current) =>
        transport.sendCard(
          args.channel_id as string,
          current,
          args as Parameters<typeof transport.sendCard>[2],
          args.request_id as string | undefined,
        ),
    ],
    [
      "feishu_cards",
      "查询卡片及最新 revision，所有 Session 可查看。",
      { channel_id: string("可选通道 ID"), card_id: string("可选卡片 ID") },
      (args) =>
        structuredClone(
          bridge.store.data.cards
            .filter(
              (c) =>
                (!args.channel_id || c.channel_id === args.channel_id) &&
                (!args.card_id || c.id === args.card_id),
            )
            .slice(-100),
        ),
    ],
    [
      "feishu_update_card",
      "当前订阅 Session 写入最终处理结果并移除按钮；dirty=true 表示正在等待飞书更新成功。禁止把用户点击直接描述为已执行。",
      {
        card_id: string("卡片 ID", true),
        revision,
        status: string("实际处理结果，例如条件已变，未执行。", true),
      },
      (args, current) =>
        bridge.updateCard(args.card_id as string, current, args.revision, args.status),
    ],
    [
      "feishu_events",
      "查看收到的事件记录。unassigned 不自动补投；delivered 仅代表会话接收，uncertain 需核对会话，不可盲目重投。",
      {
        channel_id: string("可选通道 ID"),
        state: string("可选事件状态"),
        limit: { type: "integer", description: "1–500，默认100" },
      },
      (args) =>
        bridge.events(
          args.channel_id as string | undefined,
          args.state as string | undefined,
          args.limit as number | undefined,
        ),
    ],
    [
      "feishu_outbound",
      "查看发送记录，所有 Session 可查看；sending/uncertain 不代表发送失败。",
      { channel_id: string("可选通道 ID") },
      (args) =>
        structuredClone(
          bridge.store.data.outbound
            .filter((o) => !args.channel_id || o.channel_id === args.channel_id)
            .slice(-100),
        ),
    ],
  ];
  const mounted = new Map<Agent, () => unknown>();
  const running = new Set<Promise<unknown>>();
  let stopping = false;
  const mount = (agent: Agent) => {
    if (stopping || mounted.has(agent) || !ctx.agents.roots().includes(agent)) return;
    const dispose = agent.ctx.effect(() => {
      const disposers: (() => unknown)[] = [];
      try {
        for (const [toolName, description, parameters, execute] of definitions)
          disposers.push(
            agent.ctx.tools.register(
              defineTool({
                name: toolName,
                description,
                parameters,
                output: {
                  schema: { type: "json" },
                  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
                },
                async execute(args, exec) {
                  if (stopping || exec.signal.aborted || exec.agent !== agent)
                    return { error: "飞书通道不可用或调用已取消。" };
                  const operation = Promise.resolve().then(() => execute(args, sid(agent)));
                  running.add(operation);
                  try {
                    return (await operation) as JsonValue;
                  } catch (error) {
                    return {
                      error:
                        error instanceof Error && error.constructor === Error
                          ? error.message
                          : safeError(error),
                    };
                  } finally {
                    running.delete(operation);
                  }
                },
                presentCall: () => ({
                  card: "generic",
                  title: toolName,
                  kind: [
                    "feishu_status",
                    "feishu_sessions",
                    "feishu_cards",
                    "feishu_events",
                    "feishu_outbound",
                  ].includes(toolName)
                    ? "read"
                    : "other",
                }),
              }),
            ),
          );
        disposers.push(
          agent.ctx.on("agent/status", ({ status }) => {
            if (status === "idle") bridge.kick();
          }),
        );
      } catch (error) {
        disposers.reverse().forEach((d) => d());
        throw error;
      }
      bridge.kick();
      return () => {
        disposers.reverse().forEach((d) => d());
        mounted.delete(agent);
      };
    }, "feishu.tools");
    mounted.set(agent, dispose);
  };
  ctx.effect(() => {
    const disposers = [
      ctx.on("agent/created", ({ agent }) => {
        mount(agent);
        return undefined;
      }),
      ctx.on("agent/disposed", () => bridge.kick()),
      ctx.on("workspace/session-stop", ({ sessionId }) => bridge.stopSession(String(sessionId))),
      ctx.on("workspace/session-activity", async ({ sessionId }, next) => {
        const bound = bridge.store.data.channels.filter((c) => c.session_id === String(sessionId));
        const rest = await next();
        return bound.length
          ? [
              {
                kind: "schedule" as const,
                items: bound.map((c) => ({ id: `feishu:${c.id}`, label: `飞书：${c.label}` })),
              },
              ...rest,
            ]
          : rest;
      }),
      ctx.on("credentials/reference-updated", (ref) => {
        if (
          bridge.store.data.channels.some((c) => c.app_id_ref === ref || c.app_secret_ref === ref)
        )
          transport.reconnect();
      }),
    ];
    for (const agent of ctx.agents.roots()) mount(agent);
    bridge.expireCards();
    bridge.kick();
    void transport.reconcile();
    return async () => {
      stopping = true;
      disposers.reverse().forEach((d) => d());
      await Promise.allSettled([...mounted.values()].map((d) => d()));
      mounted.clear();
      await setup.close();
      await Promise.allSettled(running);
      await transport.close();
      await bridge.close();
    };
  }, "feishu.lifecycle");
  ctx.inject(["skills"], (skillCtx) =>
    skillCtx.skills.register({
      name: "dsh-feishu",
      description:
        "飞书机器人双向通道：扫码接入、权限检查、唯一 Session 订阅与转交、文字消息、确认卡片和事件记录。操作前读取。",
      source: "runtime",
      content: readFileSync(new URL("../skills/dsh-feishu/SKILL.md", import.meta.url), "utf8"),
      resourceBase: {
        kind: "directory",
        path: fileURLToPath(new URL("../skills/dsh-feishu/", import.meta.url)),
      },
    }),
  );
}
