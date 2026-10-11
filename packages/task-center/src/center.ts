import type { Store } from "./store.js";
import {
  isRecord,
  errorMessage,
  type Task,
  type CreateTaskInput,
  type TaskChanges,
  type TaskCenterHost,
  type MaintenanceAgent,
} from "./types.js";
import { randomUUID } from "node:crypto";
import { normalizeRule, nextOccurrence, latestOccurrence, preview } from "./rules.js";

export class TaskCenter<A extends MaintenanceAgent> {
  readonly store: Store;
  readonly host: TaskCenterHost<A>;
  readonly now: () => number;
  stopped: boolean;
  pending: Map<string, Promise<void>>;
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
      target_live: !!this.host.get(task.target_session_id),
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
  stopSession(sessionId: string) {
    if (!this.sessionActivity(sessionId).length) return;
    this.store.transaction(() => {
      for (const task of this.sessionActivity(sessionId)) {
        task.enabled = false;
        task.revision++;
      }
    });
    this.kick();
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
    const target = args.target_session_id ?? currentSession;
    if (typeof target !== "string" || !target.trim()) throw new Error("需要有效目标会话。");
    if (target !== currentSession && !this.host.get(target))
      throw new Error("请从 task_center_sessions 返回的活动会话中选择目标，或进入目标会话后创建。");
    const rule = normalizeRule(args.rule, this.now());
    const next = nextOccurrence(rule, this.now());
    if (next === null) throw new Error("规则没有未来触发时间。");
    const task: Task = {
      id: randomUUID(),
      title: args.title.trim(),
      prompt: args.prompt.trim(),
      rule,
      target_session_id: target,
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
    if (this.pending.has(id)) throw new Error("任务正在投递，请稍后重新列出并修改。");
    if (
      !isRecord(changes) ||
      !Object.keys(changes).length ||
      Object.keys(changes).some((k) => !["title", "prompt", "rule", "enabled"].includes(k))
    )
      throw new Error("changes 支持 title、prompt、rule、enabled；切换会话请用 transfer。");
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
  transfer(id: string, revision: number, target: string) {
    const task = this.task(id);
    this.check(task, revision);
    if (!this.host.get(target))
      throw new Error(
        "目标必须是 task_center_sessions 中的活动会话；可在目标会话中说“转交给当前会话”。",
      );
    const updated = this.store.transaction(() => {
      task.target_session_id = target;
      task.revision++;
      return task;
    });
    this.kick();
    return this.view(updated);
  }
  remove(id: string, revision: number) {
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
      if (!task.enabled || task.dispatching || task.next_at === null || this.pending.has(task.id))
        continue;
      const agent = this.host.get(task.target_session_id);
      if (!agent) continue;
      if (this.waiters.has(agent)) continue;
      if ((this.retryAt.get(task.id) ?? 0) > this.now()) {
        delay = Math.min(delay, (this.retryAt.get(task.id) ?? 0) - this.now());
        continue;
      }
      if (task.next_at > this.now()) {
        delay = Math.min(delay, task.next_at - this.now());
        continue;
      }
      const operation = this.dispatch(task.id, agent);
      this.pending.set(task.id, operation);
      void operation
        .catch((e) => {
          this.retryAt.set(task.id, this.now() + 60000);
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
          this.host.get(task.target_session_id) !== agent
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
          this.host.get(task.target_session_id) !== agent
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
          target_session_id: task.target_session_id,
          accepted_at: accepted,
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
            `[Task Center: ${task.title}]\nTask ID: ${id}\nOccurrence: ${new Date(occurrence).toISOString()}\nDelivery ID: ${marker.id}\n\n${task.prompt}`,
          );
          if (!(await this.host.flush(agent))) throw new Error("投递后的持久化未确认。");
          this.store.transaction((data) => {
            // Editing while persistence is pending must not undo user changes.
            const current = data.tasks.find((t) => t.id === id);
            if (current?.dispatching?.id === marker.id) {
              if (current.next_at === task.next_at) current.next_at = next;
              current.last_delivery = marker;
              delete current.dispatching;
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
