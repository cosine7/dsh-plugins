import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeRule } from "./rules.js";
import { isRecord, type StoreData } from "./types.js";

export class Store {
  readonly file: string;
  readonly lock: string;
  readonly token = randomUUID();
  data: StoreData;

  constructor(readonly directory: string) {
    this.file = path.join(directory, "tasks.json");
    this.lock = path.join(directory, "owner.lock");
    fs.mkdirSync(directory, { recursive: true });
    this.acquire();
    try {
      const data: unknown = fs.existsSync(this.file)
        ? JSON.parse(fs.readFileSync(this.file, "utf8"))
        : { version: 1, tasks: [], history: [] };
      if (
        !isRecord(data) ||
        data.version !== 1 ||
        !Array.isArray(data.tasks) ||
        !Array.isArray(data.history)
      )
        throw new Error("不支持的任务存储格式；未修改原文件。");
      for (const task of data.tasks as unknown[]) {
        if (
          !isRecord(task) ||
          typeof task.id !== "string" ||
          typeof task.target_session_id !== "string" ||
          !Number.isInteger(task.revision) ||
          typeof task.enabled !== "boolean" ||
          typeof task.title !== "string" ||
          typeof task.prompt !== "string" ||
          (task.next_at !== null && !Number.isSafeInteger(task.next_at))
        )
          throw new Error("任务存储损坏；未修改原文件。");
        normalizeRule(task.rule);
        if (task.dispatching) {
          task.enabled = false;
          task.error =
            "上次进程在投递期间结束，结果不确定。请检查目标会话，再编辑 enabled=true 恢复。";
        }
      }
      this.data = data as unknown as StoreData;
      if (new Set(this.data.tasks.map((t) => t.id)).size !== this.data.tasks.length)
        throw new Error("任务 ID 重复；未修改原文件。");
      this.save();
    } catch (error) {
      this.close();
      throw error;
    }
  }
  acquire() {
    try {
      fs.writeFileSync(this.lock, JSON.stringify({ pid: process.pid, token: this.token }), {
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: unknown;
      try {
        owner = JSON.parse(fs.readFileSync(this.lock, "utf8"));
      } catch {
        throw new Error("任务中心锁无法读取，请确认没有其他实例运行后处理 owner.lock。");
      }
      if (
        !isRecord(owner) ||
        typeof owner.pid !== "number" ||
        !Number.isInteger(owner.pid) ||
        owner.pid <= 0
      )
        throw new Error("任务中心锁格式无效。");
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive) throw new Error("另一个 DSH 实例正在使用此任务中心，当前实例不启动调度。");
      fs.unlinkSync(this.lock);
      fs.writeFileSync(this.lock, JSON.stringify({ pid: process.pid, token: this.token }), {
        flag: "wx",
      });
    }
  }
  save() {
    const tmp = this.file + "." + this.token + ".tmp";
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(this.data, null, 2) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, this.file);
    } catch (error) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 尽力清理临时文件，保留原始错误。 */
      }
      throw error;
    }
  }
  transaction<T>(fn: (data: StoreData) => T): T {
    const before = structuredClone(this.data);
    try {
      const result = fn(this.data);
      this.save();
      return structuredClone(result);
    } catch (error) {
      this.data = before;
      throw error;
    }
  }
  close() {
    try {
      const owner: unknown = JSON.parse(fs.readFileSync(this.lock, "utf8"));
      if (isRecord(owner) && owner.token === this.token) fs.unlinkSync(this.lock);
    } catch {
      /* 锁已消失或不属于本实例时无需处理。 */
    }
  }
}
