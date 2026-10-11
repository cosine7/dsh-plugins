import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { record, type StoreData } from "./types.js";

/** One writer, atomic replacement, rollback on failure. This directory never contains credentials. */
export class Store {
  readonly file: string;
  readonly lock: string;
  readonly token = randomUUID();
  data: StoreData;
  private closed = false;

  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, "state.json");
    this.lock = path.join(directory, "owner.lock");
    this.acquire();
    try {
      const data: unknown = fs.existsSync(this.file)
        ? JSON.parse(fs.readFileSync(this.file, "utf8"))
        : { version: 1, channels: [], events: [], cards: [], outbound: [], seen: [] };
      if (!validData(data)) throw new Error("飞书状态文件损坏或版本不支持；原文件未修改。");
      this.data = data;
      for (const event of this.data.events) {
        if (event.state === "dispatching") event.state = "uncertain";
      }
      for (const outbound of this.data.outbound) {
        if (outbound.state === "sending") outbound.state = "uncertain";
      }
      this.save();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private acquire() {
    try {
      fs.writeFileSync(this.lock, JSON.stringify({ pid: process.pid, token: this.token }), {
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner: unknown = JSON.parse(fs.readFileSync(this.lock, "utf8"));
      if (!record(owner) || !Number.isInteger(owner.pid) || Number(owner.pid) <= 0)
        throw new Error("飞书实例锁无效，请先检查是否有其他 DSH 实例。");
      try {
        process.kill(Number(owner.pid), 0);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
        fs.unlinkSync(this.lock);
        fs.writeFileSync(this.lock, JSON.stringify({ pid: process.pid, token: this.token }), {
          flag: "wx",
        });
        return;
      }
      throw new Error("另一个 DSH 实例正在使用飞书通道。");
    }
  }

  transaction<T>(operation: (data: StoreData) => T): T {
    if (this.closed) throw new Error("飞书存储已关闭。");
    const before = structuredClone(this.data);
    try {
      const result = operation(this.data);
      this.save();
      return result;
    } catch (error) {
      this.data = before;
      throw error;
    }
  }

  private save() {
    const tmp = `${this.file}.${this.token}.tmp`;
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
        /* Preserve the original failure. */
      }
      throw error;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      const owner: unknown = JSON.parse(fs.readFileSync(this.lock, "utf8"));
      if (record(owner) && owner.token === this.token) fs.unlinkSync(this.lock);
    } catch {
      /* Never remove another writer's lock. */
    }
  }
}

function validData(value: unknown): value is StoreData {
  if (!record(value) || value.version !== 1) return false;
  for (const key of ["channels", "events", "cards", "outbound", "seen"])
    if (!Array.isArray(value[key])) return false;
  const { channels, events, cards, outbound, seen } = value as unknown as StoreData;
  return (
    channels.every(
      (c) =>
        record(c) &&
        typeof c.id === "string" &&
        typeof c.label === "string" &&
        typeof c.app_id_ref === "string" &&
        typeof c.app_secret_ref === "string" &&
        typeof c.authorized_open_id === "string" &&
        c.authorized_open_id.startsWith("ou_") &&
        typeof c.enabled === "boolean" &&
        Number.isInteger(c.revision) &&
        c.revision > 0 &&
        (c.chat_id === undefined || typeof c.chat_id === "string") &&
        (c.session_id === undefined || typeof c.session_id === "string"),
    ) &&
    new Set(channels.map((c) => c.id)).size === channels.length &&
    events.every(
      (e) =>
        record(e) &&
        typeof e.id === "string" &&
        typeof e.key === "string" &&
        typeof e.channel_id === "string" &&
        channels.some((c) => c.id === e.channel_id) &&
        ["text", "card"].includes(e.kind) &&
        typeof e.message_id === "string" &&
        typeof e.open_id === "string" &&
        typeof e.chat_id === "string" &&
        typeof e.text === "string" &&
        Number.isFinite(e.received_at) &&
        ["pending", "unassigned", "dispatching", "delivered", "uncertain", "expired"].includes(
          e.state,
        ),
    ) &&
    cards.every(
      (c) =>
        record(c) &&
        typeof c.id === "string" &&
        typeof c.channel_id === "string" &&
        channels.some((channel) => channel.id === c.channel_id) &&
        typeof c.origin_session_id === "string" &&
        typeof c.dirty === "boolean" &&
        (c.message_id === undefined || typeof c.message_id === "string") &&
        typeof c.title === "string" &&
        typeof c.content === "string" &&
        Array.isArray(c.choices) &&
        c.choices.length >= 2 &&
        c.choices.length <= 6 &&
        c.choices.every(
          (a) => record(a) && typeof a.id === "string" && typeof a.label === "string",
        ) &&
        Number.isFinite(c.expires_at) &&
        Number.isFinite(c.created_at) &&
        Number.isInteger(c.revision) &&
        ["pending", "received", "expired", "completed"].includes(c.state),
    ) &&
    outbound.every(
      (o) =>
        record(o) &&
        typeof o.id === "string" &&
        typeof o.channel_id === "string" &&
        channels.some((c) => c.id === o.channel_id) &&
        typeof o.origin_session_id === "string" &&
        Number.isFinite(o.created_at) &&
        typeof o.content === "string" &&
        ["sending", "sent", "uncertain"].includes(o.state),
    ) &&
    seen.every((k) => typeof k === "string")
  );
}
