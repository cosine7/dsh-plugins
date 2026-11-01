import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-api-session-controller";
import type {} from "@deepseek-ai/dsh-session-query";
import type {} from "@deepseek-ai/dsh-workspace";
import type {} from "@deepseek-ai/dsh-session-title";
import type { FeishuBinding } from "./types.js";
import { realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

declare module "@deepseek-ai/cordis" {
  interface Events {
    "cosine/plugin-alert"(request: {
      source: "task-center" | "feishu";
      key: string;
      message: string;
      channel_ids?: string[];
    }): void;
    "cosine/feishu-bindings"(
      request: { sessionId: string },
      next: () => Promise<FeishuBinding[]>,
    ): Promise<FeishuBinding[]>;
    "cosine/feishu-handoff"(
      request: { bindings: FeishuBinding[]; targetSessionId: string },
      next: () => Promise<FeishuBinding[]>,
    ): Promise<FeishuBinding[]>;
  }
}

/** Use the desktop's ordinary Session composition; never assemble a second Agent runtime. */
export function sessionRouting(ctx: Context) {
  const archived = (id: string) =>
    ctx.workspaceRegistry.archivedSessionIds.includes(id as SessionId);
  const describe = async (id: string) => {
    // A full backend listing propagates I/O failures. Only a successful absence means missing.
    const records = await ctx.sessionQuery.listSessions();
    const record = records.find((r) => String(r.header.id) === id);
    return {
      state: !record
        ? ("missing" as const)
        : archived(id)
          ? ("archived" as const)
          : ("available" as const),
      ...(record?.header.cwd ? { cwd: record.header.cwd } : {}),
    };
  };
  const resolve = async (id: string) => {
    if (archived(id)) throw new Error("目标会话已归档，不能恢复运行。");
    const result = await ctx.sessionController.resolveAgent(id as SessionId);
    if ("error" in result) throw new Error(`会话加载失败：${result.error.code}`);
    if (archived(id)) throw new Error("会话加载期间被归档，取消投递。");
    return result.agent;
  };
  return {
    notify: (key: string, message: string, channelIds?: string[]) =>
      ctx.parallel("cosine/plugin-alert", {
        source: "task-center",
        key,
        message,
        ...(channelIds?.length ? { channel_ids: channelIds } : {}),
      }),
    describe,
    resolve,
    archived,
    async name(agent: Agent, title: string) {
      if (archived(String(agent.session.id))) throw new Error("准备中的会话已归档，不能设置标题。");
      // Retried preparation must never replace a name the user has already chosen.
      if (!ctx.sessionTitle.get(agent.session)) ctx.sessionTitle.rename(agent.session, title);
    },
    async create(cwd: string, id: string) {
      const info = await describe(id);
      if (info.state === "archived") throw new Error("准备中的会话已归档。");
      if (info.state === "available") return { id, agent: await resolve(id) };
      let canonical = resolvePath(cwd);
      try {
        canonical = await realpath(cwd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const workspace = ctx.workspaceRegistry
        .list()
        .find((w) => resolvePath(w.path).toLowerCase() === canonical.toLowerCase());
      const created = await ctx.sessionController.create({
        sessionId: id as SessionId,
        ...(workspace ? { workspaceId: workspace.id } : { cwd }),
      });
      return { id: String(created.sessionId), agent: await resolve(String(created.sessionId)) };
    },
    bindings: (sessionId: string) =>
      ctx.waterfall("cosine/feishu-bindings", { sessionId }, async () => []),
    handoff: (bindings: FeishuBinding[], targetSessionId: string) => {
      if (!bindings.length) return Promise.resolve([]);
      return ctx.waterfall("cosine/feishu-handoff", { bindings, targetSessionId }, async () => {
        throw new Error("任务关联了飞书通道，但飞书插件不可用。");
      });
    },
  };
}
