import type { Store } from "./store.js";
import {
  isRecord,
  errorMessage,
  type Task,
  type CreateTaskInput,
  type TaskChanges,
  type TaskCenterHost,
  type MaintenanceAgent,
  type FeishuBinding,
} from "./types.js";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { normalizeRule, nextOccurrence, latestOccurrence, preview } from "./rules.js";

export class TaskCenter<A extends MaintenanceAgent> {
  readonly store: Store;
  readonly host: TaskCenterHost<A>;
  readonly now: () => number;
  stopped: boolean;
  pending: Map<string, Promise<void>>;
  readonly mutating = new Set<string>();
  waiters: Set<A>;
  retryAt: Map<string, number>;
  stopSignal: Promise<void>;
  signalStop!: () => void;
  timer?: NodeJS.Timeout;
  constructor(store: Store, host: TaskCenterHost<A>, now = () => Date.now()) {
    this.store = store;
    this.host = host;
    this.now = now;
    this.stopped = false;
    this.pending = new Map();
    this.waiters = new Set();
    this.retryAt = new Map();
    this.stopSignal = new Promise((resolve) => {
      this.signalStop = resolve;
    });
  }
  task(id: string) {
    const task = this.store.data.tasks.find((t) => t.id === id);
    if (!task) throw new Error("任务不存在。");
    return task;
  }
  view(task: Task) {
    return {
      ...structuredClone(task),
      target_live: !!task.target_session_id && !!this.host.get(task.target_session_id),
      state: !task.enabled
        ? "paused"
        : task.next_at === null
          ? "completed"
          : task.next_at <= this.now()
            ? "overdue"
            : "scheduled",
      upcoming:
        task.enabled && task.next_at !== null ? preview(task.rule, task.next_at - 1, 5) : [],
    };
  }
  list() {
    return this.store.data.tasks.map((t) => this.view(t));
  }
  sessionActivity(sessionId: string) {
    return this.store.data.tasks.filter(
      (task) => task.target_session_id === sessionId && task.enabled && task.next_at !== null,
    );
  }
  check(task: Task, revision: number) {
    if (!Number.isInteger(revision) || task.revision !== revision)
      throw new Error("任务已修改或缺少 revision，请先重新列出任务，再使用最新 revision。");
  }
  create(args: CreateTaskInput, currentSession: string) {
    if (
      typeof args.title !== "string" ||
      !args.title.trim() ||
      args.title.length > 200 ||
      typeof args.prompt !== "string" ||
      !args.prompt.trim() ||
      args.prompt.length > 32000
    )
      throw new Error("需要 title（1–200 字符）和 prompt（1–32000 字符）。");
    const mode = args.target_mode ?? "session";
    if (mode !== "session" && mode !== "new")
      throw new Error("target_mode 必须为 session 或 new。");
    if (mode === "new" && args.target_session_id !== undefined)
      throw new Error("新建模式不能同时指定 target_session_id。");
    if (typeof args.cwd !== "string" || !isAbsolute(args.cwd))
      throw new Error("需要绝对工作目录 cwd。");
    const target = args.target_session_id ?? currentSession;
    if (typeof target !== "string" || !target.trim()) throw new Error("需要有效目标会话。");
    const rule = normalizeRule(args.rule, this.now());
    const next = nextOccurrence(rule, this.now());
    if (next === null) throw new Error("规则没有未来触发时间。");
    const task: Task = {
      id: randomUUID(),
      title: args.title.trim(),
      prompt: args.prompt.trim(),
      rule,
      target_mode: mode,
      ...(mode === "session" ? { target_session_id: target } : {}),
      cwd: args.cwd,
      feishu_bindings: args.feishu_bindings ?? [],
      revision: 1,
      enabled: true,
      next_at: next,
      created_at: this.now(),
    };
    this.store.transaction((data) => {
      if (data.tasks.length >= 1000) throw new Error("任务数量已达 1000，请删除不需要的任务。");
      data.tasks.push(task);
      return task;
    });
    this.kick();
    return this.view(task);
  }
  update(id: string, revision: number, changes: unknown) {
    const task = this.task(id);
    this.check(task, revision);
    if (this.mutating.has(id)) throw new Error("任务正在转交，请稍后修改。");
    if (this.pending.has(id)) throw new Error("任务正在投递，请稍后重新列出并修改。");
    if (
      !isRecord(changes) ||
      !Object.keys(changes).length ||
      Object.keys(changes).some(
        (k) => !["title", "prompt", "rule", "enabled", "cwd", "target_mode"].includes(k),
      )
    )
      throw new Error(
        "changes 支持 title、prompt、rule、enabled、cwd、target_mode；指定会话请用 transfer。",
      );
    if (changes.cwd !== undefined && (typeof changes.cwd !== "string" || !isAbsolute(changes.cwd)))
      throw new Error("cwd 必须是绝对路径。");
    if (
      changes.target_mode !== undefined &&
      changes.target_mode !== "session" &&
      changes.target_mode !== "new"
    )
      throw new Error("target_mode 无效。");
    if (changes.target_mode === "session" && !task.target_session_id)
      throw new Error("请通过 transfer 指定复用目标会话。");
    if (
      changes.title !== undefined &&
      (typeof changes.title !== "string" || !changes.title.trim() || changes.title.length > 200)
    )
      throw new Error("title 无效。");
    if (
      changes.prompt !== undefined &&
      (typeof changes.prompt !== "string" ||
        !changes.prompt.trim() ||
        changes.prompt.length > 32000)
    )
      throw new Error("prompt 无效。");
    if (changes.enabled !== undefined && typeof changes.enabled !== "boolean")
      throw new Error("enabled 必须为布尔值。");
    const normalized = structuredClone(changes) as TaskChanges;
    if (changes.rule !== undefined) normalized.rule = normalizeRule(changes.rule, this.now());
    const updated = this.store.transaction(() => {
      const target = this.task(id);
      Object.assign(target, normalized);
      if (changes.target_mode === "new") delete target.target_session_id;
      if (changes.target_mode !== undefined || changes.cwd !== undefined) delete target.preparing;
      target.revision++;
      if (changes.rule !== undefined || changes.enabled === true) {
        target.next_at = nextOccurrence(target.rule, this.now());
        if (target.next_at === null) throw new Error("规则没有未来触发时间，请修改规则后恢复。");
        delete target.error;
        delete target.dispatching;
      }
      return target;
    });
    this.kick();
    return this.view(updated);
  }
  async transfer(id: string, revision: number, target: string, bindings?: FeishuBinding[]) {
    const task = this.task(id);
    this.check(task, revision);
    if (this.pending.has(id) || this.mutating.has(id))
      throw new Error("任务正在准备、投递或转交，请稍后操作。");
    this.mutating.add(id);
    try {
      const info = await this.host.describe(target);
      if (info.state !== "available") throw new Error("请选择存在且未归档的目标会话。");
      this.check(this.task(id), revision);
      const agent = await this.host.resolve(target);
      if (!agent || this.host.archived(target)) throw new Error("目标会话不可用。");
      const moved = await this.host.handoff(bindings ?? task.feishu_bindings, target);
      const updated = this.store.transaction(() => {
        const current = this.task(id);
        current.target_session_id = target;
        current.target_mode = "session";
        current.cwd = info.cwd ?? current.cwd;
        current.feishu_bindings = moved;
        delete current.preparing;
        current.revision++;
        return current;
      });
      this.kick();
      return this.view(updated);
    } finally {
      this.mutating.delete(id);
      this.kick();
    }
  }
  remove(id: string, revision: number) {
    if (this.mutating.has(id)) throw new Error("任务正在转交，请稍后删除。");
    this.check(this.task(id), revision);
    this.store.transaction((data) => {
      data.tasks = data.tasks.filter((t) => t.id !== id);
      return true;
    });
    this.kick();
    return { deleted: true, id };
  }
  kick() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const schedule = () => {
      this.timer = setTimeout(() => {
        void this.tick().catch((e) => this.host.warn(String(e)));
      }, 0);
    };
    if (this.host.detached) this.host.detached(schedule);
    else schedule();
    this.timer?.unref();
  }
  async tick() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    let delay = 60000;
    for (const task of this.store.data.tasks) {
      if (
        !task.enabled ||
        task.dispatching ||
        task.next_at === null ||
        this.pending.has(task.id) ||
        this.mutating.has(task.id)
      )
        continue;
      const agent = task.target_session_id ? this.host.get(task.target_session_id) : undefined;
      if (agent && this.waiters.has(agent)) continue;
      if ((this.retryAt.get(task.id) ?? 0) > this.now()) {
        delay = Math.min(delay, (this.retryAt.get(task.id) ?? 0) - this.now());
        continue;
      }
      if (task.next_at > this.now()) {
        delay = Math.min(delay, task.next_at - this.now());
        continue;
      }
      const operation = this.prepareAndDispatch(task.id);
      this.pending.set(task.id, operation);
      void operation
        .catch((e) => {
          this.retryAt.set(task.id, this.now() + 60000);
          try {
            if (this.store.data.tasks.some((t) => t.id === task.id))
              this.store.transaction(() => {
                this.task(task.id).error = errorMessage(e);
              });
          } catch {
            this.host.warn("任务错误状态无法持久化，请检查磁盘。");
          }
          this.host.warn(String(e));
        })
        .finally(() => {
          this.pending.delete(task.id);
          this.kick();
        });
    }
    this.timer = setTimeout(
      () => {
        void this.tick().catch((e) => this.host.warn(String(e)));
      },
      Math.max(1, delay),
    );
    this.timer?.unref();
  }
  async prepareAndDispatch(id: string): Promise<void> {
    let task = this.task(id);
    const revision = task.revision;
    if (this.stopped || !task.enabled || task.next_at === null || task.next_at > this.now()) return;
    if (!task.preparing) {
      const original = task.target_mode === "session" ? task.target_session_id : undefined;
      const info = original ? await this.host.describe(original) : undefined;
      task = this.task(id);
      if (this.stopped || !task.enabled || task.revision !== revision) return;
      if (original && info?.state === "available") {
        const agent = await this.host.resolve(original);
        if (!this.host.archived(original)) await this.dispatch(id, agent);
        return;
      }
      this.store.transaction(() => {
        task.preparing = {
          session_id: `session-${randomUUID()}`,
          occurrence_at: task.next_at!,
          ...(original
            ? { original_session_id: original, reason: info!.state as "archived" | "missing" }
            : {}),
        };
      });
    }
    const preparation = structuredClone(task.preparing!);
    if (this.host.archived(preparation.session_id)) {
      this.store.transaction(() => {
        task.preparing = {
          ...preparation,
          session_id: `session-${randomUUID()}`,
          original_session_id: preparation.session_id,
          reason: "archived",
        };
      });
      return this.prepareAndDispatch(id);
    }
    const created = await this.host.create(task.cwd, preparation.session_id);
    task = this.task(id);
    if (this.stopped || !task.enabled || task.revision !== revision) return;
    // Persist the actual host identity before any subscription or message is moved.
    if (created.id !== preparation.session_id) {
      this.store.transaction(() => {
        task.preparing!.session_id = created.id;
      });
    }
    const moved = await this.host.handoff(task.feishu_bindings, created.id);
    task = this.task(id);
    if (this.stopped || !task.enabled || task.revision !== revision) return;
    this.store.transaction(() => {
      task.feishu_bindings = moved;
      if (task.target_mode === "session" && task.target_session_id !== created.id) {
        task.target_session_id = created.id;
        task.revision++;
      }
    });
    if (!this.host.archived(created.id)) await this.dispatch(id, created.agent);
  }
  async dispatch(id: string, agent: A) {
    // 和官方 Schedule 一样，在 Agent 空闲维护边界串行接受投递。
    let maintenance;
    try {
      maintenance = agent.runMaintenance(async () => {
        if (this.stopped) return;
        let task = this.store.data.tasks.find((t) => t.id === id);
        if (
          !task ||
          !task.enabled ||
          task.dispatching ||
          task.next_at === null ||
          task.next_at > this.now() ||
          this.host.get(task.preparing?.session_id ?? task.target_session_id ?? "") !== agent ||
          this.host.archived(task.preparing?.session_id ?? task.target_session_id ?? "")
        )
          return;
        if (!(await this.host.flush(agent))) throw new Error("会话持久化未就绪，尚未投递。");
        // Another session may transfer/delete/update while the flush awaited.
        task = this.store.data.tasks.find((t) => t.id === id);
        if (
          this.stopped ||
          !task ||
          !task.enabled ||
          task.dispatching ||
          task.next_at === null ||
          task.next_at > this.now() ||
          this.host.get(task.preparing?.session_id ?? task.target_session_id ?? "") !== agent ||
          this.host.archived(task.preparing?.session_id ?? task.target_session_id ?? "")
        )
          return;
        const accepted = this.now();
        const occurrence = Math.max(
          task.next_at,
          latestOccurrence(task.rule, accepted) ?? task.next_at,
        );
        const marker = {
          id: randomUUID(),
          occurrence_at: occurrence,
          target_session_id: task.preparing?.session_id ?? task.target_session_id!,
          accepted_at: accepted,
          ...(task.preparing?.original_session_id
            ? {
                original_session_id: task.preparing.original_session_id,
                replacement_reason: task.preparing.reason,
              }
            : {}),
        };
        const next = nextOccurrence(task.rule, accepted);
        // Persist an intent before followup. A crash in this gap pauses, never blindly re-delivers.
        this.store.transaction(() => {
          task.dispatching = marker;
          return true;
        });
        try {
          this.host.deliver(
            agent,
            `[Task Center: ${task.title}]\nTask ID: ${id}\nOccurrence: ${new Date(occurrence).toISOString()}\nDelivery ID: ${marker.id}\n\n${task.preparing?.original_session_id ? `本任务原计划投递到 ${task.preparing.original_session_id}，但该会话${task.preparing.reason === "archived" ? "已归档。原会话历史仍保留，如有可用的会话搜索或读取工具，可以按上述 Session ID 查阅；不要解除归档或恢复运行原会话。" : "已不存在，无法依赖原会话历史。"}\n因此改由当前新会话执行，未继承原会话上下文。\n\n原任务指令：\n` : ""}${task.prompt}`,
          );
          if (!(await this.host.flush(agent))) throw new Error("投递后的持久化未确认。");
          this.store.transaction((data) => {
            // Editing while persistence is pending must not undo user changes.
            const current = data.tasks.find((t) => t.id === id);
            if (current?.dispatching?.id === marker.id) {
              if (current.next_at === task.next_at) current.next_at = next;
              current.last_delivery = marker;
              delete current.dispatching;
              delete current.preparing;
              delete current.error;
            }
            data.history.push({ task_id: id, ...marker, state: "delivered" });
            data.history = data.history.slice(-500);
            return true;
          });
        } catch (error) {
          this.store.transaction((data) => {
            const current = data.tasks.find((t) => t.id === id);
            if (current) {
              current.enabled = false;
              current.error = `投递结果不确定，请检查目标会话后恢复：${errorMessage(error)}`;
            }
            return true;
          });
          this.host.warn(`task-center ${id}: ${errorMessage(error)}`);
        }
      });
    } catch {
      if (!this.waiters.has(agent)) {
        this.waiters.add(agent);
        void Promise.race([agent.whenIdle(), this.stopSignal])
          .catch((e) => this.host.warn(String(e)))
          .finally(() => {
            this.waiters.delete(agent);
            this.kick();
          });
      }
      return;
    }
    await maintenance;
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.signalStop();
    await Promise.allSettled(this.pending.values());
    this.store.close();
  }
}
