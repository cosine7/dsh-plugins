import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Store } from "./store.js";
import { TaskCenter } from "./center.js";
import { normalizeRule, preview } from "./rules.js";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type {} from "@deepseek-ai/dsh-skill";
import type {} from "@deepseek-ai/dsh-workspace";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import type {
  ParameterSchemaSpec,
  ParameterPropertySpec,
  StringValueSchemaSpec,
} from "@deepseek-ai/dsh-tools";
import { errorMessage } from "./types.js";
import { isAbsolute } from "node:path";
import { sessionRouting } from "./routing.js";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "cosine-task-center": { kind: "cosine-task-center" };
  }
}

type ToolDefinition = readonly [
  string,
  string,
  ParameterSchemaSpec,
  (args: Record<string, unknown>, agent: Agent) => unknown,
];

declare module "@deepseek-ai/dsh-workspace/types" {
  interface SessionActivityKindMap {
    schedule: true;
  }
}
export const name = "cosine-task-center";
export const inject = [
  "agents",
  "sessions",
  "tools",
  "sessionPersistence",
  "sessionController",
  "sessionQuery",
  "workspaceRegistry",
];
const string = (description: string): StringValueSchemaSpec => ({ type: "string", description });
const required = (description: string): ParameterPropertySpec => ({
  ...string(description),
  required: true,
});
const revision: ParameterPropertySpec = {
  type: "integer",
  required: true,
  description: "当前 task_center_list 返回的 revision，防止覆盖其他会话的修改。",
};
const ruleSchema: ParameterPropertySpec = {
  type: "object",
  required: true,
  additionalProperties: false,
  description:
    "先读取 dsh-task-center skill。kind=once: at（含偏移）；interval: every_minutes, anchor可选；cron: timezone, expression（五字段）；windows: timezone, weekdays（1=周一至7=周日）, windows:[{start:HH:mm,end:HH:mm,every_minutes}], exclude_dates/start_date/end_date可选。",
  properties: {
    kind: { type: "string", required: true, enum: ["once", "interval", "cron", "windows"] },
    at: string("一次性 ISO 日期时间，必须包含时区偏移。"),
    anchor: string("间隔首次触发时间，ISO 格式含偏移。"),
    every_minutes: { type: "integer", description: "至少1分钟。" },
    timezone: string(
      "IANA 时区，如 Asia/Shanghai。once/interval 可选，仅控制显示，也支持 UTC+08:00；省略时保留输入时间的偏移，无 anchor 时使用宿主时区。",
    ),
    expression: string("五字段 cron，禁止同时限制日与星期。"),
    weekdays: { type: "array", items: { type: "integer", enum: [1, 2, 3, 4, 5, 6, 7] } },
    windows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          start: required("HH:mm"),
          end: required("HH:mm，包含边界"),
          every_minutes: { type: "integer", required: true },
        },
      },
    },
    exclude_dates: { type: "array", items: { type: "string" } },
    start_date: string("YYYY-MM-DD"),
    end_date: string("YYYY-MM-DD"),
  },
};

export function apply(ctx: Context) {
  const routing = sessionRouting(ctx);
  let center: TaskCenter<Agent>;
  try {
    const store = new Store(join(resolveDshHome(), "storages", "cosine-task-center"));
    center = new TaskCenter(store, {
      ...routing,
      get: (id) => ctx.agents.roots().find((a) => String(a.session.id ?? a.id) === id),
      flush: (agent) => ctx.sessions.flush(agent.session),
      detached: (fn) => ctx.agents.withoutInitiator(fn),
      warn: (text) => ctx.logger.warn(text),
      // Session format v4 requires a producer-owned kind, rather than the old generic plugin source.
      deliver: (agent, text) =>
        agent.followup(
          createUserMessage({ content: [{ type: "text", text }], source: { kind: name } }),
        ),
    });
  } catch (error) {
    ctx.logger.warn(`task-center disabled: ${errorMessage(error)}`);
    return;
  }
  const sessionId = (agent: Agent) => String(agent.session.id ?? agent.id);
  const definitions: ToolDefinition[] = [
    [
      "task_center_preview",
      "预览规则的接下来触发时间，不创建任务。自然语言调度优先使用本插件；复杂规则先读取 dsh-task-center skill。",
      { rule: ruleSchema },
      (args) => {
        const rule = normalizeRule(args.rule);
        return { rule, upcoming: preview(rule) };
      },
    ],
    [
      "task_center_list",
      "查看本插件全部任务、规则、revision、执行会话及状态。不会列出官方 schedule 的任务。",
      {},
      () => center.list(),
    ],
    [
      "task_center_sessions",
      "只读列出已加载及历史会话，并标记归档状态；不会唤醒会话。",
      {},
      async (_args, agent) => ({
        current_session_id: sessionId(agent),
        sessions: (await ctx.sessionQuery.listSessions()).map((r) => ({
          session_id: String(r.header.id),
          loaded: !!ctx.agents.get(r.header.id),
          archived: routing.archived(String(r.header.id)),
          ...(r.header.cwd === undefined ? {} : { cwd: r.header.cwd }),
        })),
      }),
    ],
    [
      "task_center_create",
      "创建全局定时任务：指定会话（默认当前）或每次触发创建新会话。归档/删除指定会话不会取消任务。保存工作目录与完整 prompt；关联的飞书订阅随目标转交。",
      {
        title: required("任务名称"),
        prompt: required("到期交给模型的完整指令"),
        rule: ruleSchema,
        target_mode: {
          type: "string",
          enum: ["session", "new"],
          description: "session 复用指定会话；new 每次触发新建，默认 session。",
        },
        target_session_id: string("session 模式目标 ID，省略为当前会话。"),
        cwd: string("绝对工作目录，默认目标/当前会话的目录；新会话仅设置 cwd 和普通任务消息。"),
        feishu_channel_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "关联并随执行目标转交的飞书通道；省略继承源会话当前订阅，空数组不关联。只能选择源会话拥有的通道。",
        },
      },
      async (args, agent) => {
        if (args.target_session_id !== undefined && typeof args.target_session_id !== "string")
          throw new Error("target_session_id 无效。");
        const source =
          args.target_mode === "new"
            ? sessionId(agent)
            : ((args.target_session_id as string | undefined) ?? sessionId(agent));
        const info = await routing.describe(source);
        const cwd = args.cwd ?? info.cwd ?? agent.session.header.cwd ?? process.cwd();
        if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("cwd 必须是绝对路径。");
        const available = await routing.bindings(source);
        const selected = args.feishu_channel_ids;
        if (
          selected !== undefined &&
          (!Array.isArray(selected) ||
            selected.some(
              (id) => typeof id !== "string" || !available.some((b) => b.channel_id === id),
            ))
        )
          throw new Error("只能关联源会话当前拥有的飞书通道。");
        return center.create(
          {
            ...args,
            cwd,
            feishu_bindings:
              selected === undefined
                ? available
                : available.filter((b) => (selected as string[]).includes(b.channel_id)),
          },
          sessionId(agent),
        );
      },
    ],
    [
      "task_center_update",
      "修改规则、内容或暂停/恢复。先 list 获取最新 revision。恢复时从现在计算下次，不补跑暂停期间任务。",
      {
        id: required("任务 ID"),
        revision,
        changes: {
          type: "object",
          required: true,
          additionalProperties: false,
          properties: {
            title: string("新名称"),
            prompt: string("新指令"),
            enabled: { type: "boolean" },
            cwd: string("新建或替代会话的绝对工作目录。"),
            target_mode: {
              type: "string",
              enum: ["session", "new"],
              description: "切换为每次新建；指定复用目标请用 transfer。",
            },
            rule: Object.fromEntries(
              Object.entries(ruleSchema).filter(([key]) => key !== "required"),
            ) as ParameterPropertySpec,
          },
        },
      },
      (args) => center.update(args.id as string, args.revision as number, args.changes),
    ],
    [
      "task_center_transfer",
      "把任务改为投递到指定的未归档会话，并转交关联的飞书订阅。省略目标表示当前会话；已投递消息不撤回。",
      {
        id: required("任务 ID"),
        revision,
        target_session_id: string("目标会话 ID，省略使用当前会话。"),
        rebind_feishu: {
          type: "boolean",
          description:
            "显式重新关联目标会话当前订阅的飞书通道，用于用户主动调整订阅后的重新关联；默认保留任务原关联。",
        },
      },
      async (args, agent) =>
        center.transfer(
          args.id as string,
          args.revision as number,
          (args.target_session_id as string | undefined) ?? sessionId(agent),
          args.rebind_feishu === true
            ? await routing.bindings(
                (args.target_session_id as string | undefined) ?? sessionId(agent),
              )
            : undefined,
        ),
    ],
    [
      "task_center_delete",
      "删除本插件的一个任务，未来不再投递；已投递的消息不会撤回。",
      { id: required("任务 ID"), revision },
      (args) => center.remove(args.id as string, args.revision as number),
    ],
    [
      "task_center_history",
      "查看本插件最近最多 500 条投递记录。delivered 表示会话已接收，不代表任务执行成功。",
      { id: string("可选任务 ID") },
      (args) =>
        structuredClone(center.store.data.history.filter((h) => !args.id || h.task_id === args.id)),
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
        for (const [toolName, description, parameters, execute] of definitions) {
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
                    return { error: "任务中心不可用或调用已取消。" };
                  try {
                    const operation = Promise.resolve().then(() => execute(args, agent));
                    running.add(operation);
                    try {
                      return (await operation) as JsonValue;
                    } finally {
                      running.delete(operation);
                    }
                  } catch (error) {
                    return { error: errorMessage(error) };
                  }
                },
                presentCall: () => ({
                  card: "generic",
                  title: toolName,
                  kind: [
                    "task_center_list",
                    "task_center_preview",
                    "task_center_sessions",
                    "task_center_history",
                  ].includes(toolName)
                    ? "read"
                    : "other",
                }),
              }),
            ),
          );
        }
        disposers.push(
          agent.ctx.on("agent/status", ({ status }) => {
            if (status === "idle") center.kick();
          }),
        );
      } catch (e) {
        disposers.reverse().forEach((d) => d());
        throw e;
      }
      center.kick();
      return () => {
        disposers.reverse().forEach((d) => d());
        mounted.delete(agent);
      };
    }, "task-center.tools");
    mounted.set(agent, dispose);
  };
  ctx.effect(() => {
    const stopCreated = ctx.on("agent/created", ({ agent }) => {
      mount(agent);
      return undefined;
    });
    // Schedules belong to the task, not the Session's archive lifecycle.
    const stopSession = ctx.on("workspace/session-stop", () => center.kick());
    ctx.on("agent/disposed", () => center.kick());
    for (const agent of ctx.agents.roots()) mount(agent);
    center.kick();
    return async () => {
      stopping = true;
      stopCreated();
      stopSession();
      await Promise.allSettled([...mounted.values()].map((dispose) => dispose()));
      mounted.clear();
      await Promise.allSettled(running);
      await center.close();
    };
  }, "task-center.lifecycle");
  ctx.inject(["skills"], (skillCtx) => {
    skillCtx.skills.register({
      name: "dsh-task-center",
      description:
        "创建、查看、修改、暂停、删除全局定时任务，支持自然语言时间、cron、多窗口间隔，以及把唯一执行会话切换到当前会话。管理本插件任务前读取。",
      source: "runtime",
      content: readFileSync(new URL("../skills/dsh-task-center/SKILL.md", import.meta.url), "utf8"),
      resourceBase: {
        kind: "directory",
        path: fileURLToPath(new URL("../skills/dsh-task-center/", import.meta.url)),
      },
    });
  });
}
