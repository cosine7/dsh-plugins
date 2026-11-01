import { test, expect, type TestContext } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { TaskCenter } from "../src/center.js";
import type { MaintenanceAgent, TaskCenterHost, StoreData } from "../src/types.js";

interface TestAgent extends MaintenanceAgent {
  id: string;
}

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-task-center-test-"));
  const store = new Store(dir);
  let now = Date.parse("2026-09-10T00:00:00Z");
  const agents = new Map<string, TestAgent>();
  const archived = new Set<string>();
  const stored = new Set(["A", "B"]);
  const deliveries: { id: string; text: string }[] = [];
  const titles = new Map<string, string>();
  for (const id of ["A", "B"])
    agents.set(id, { id, runMaintenance: (fn) => fn(), whenIdle: () => Promise.resolve() });
  const host: TaskCenterHost<TestAgent> = {
    get: (id) => agents.get(id),
    archived: (id) => archived.has(id),
    describe: async (id) => ({
      state: !stored.has(id) ? "missing" : archived.has(id) ? "archived" : "available",
      cwd: "C:/test",
    }),
    resolve: async (id) => {
      if (!stored.has(id) || archived.has(id)) throw new Error("cannot resume");
      if (!agents.has(id))
        agents.set(id, { id, runMaintenance: (fn) => fn(), whenIdle: async () => {} });
      return agents.get(id)!;
    },
    create: async (_cwd, id) => {
      stored.add(id);
      if (!agents.has(id))
        agents.set(id, { id, runMaintenance: (fn) => fn(), whenIdle: async () => {} });
      return { id, agent: agents.get(id)! };
    },
    name: async (agent, title) => {
      if (!titles.has(agent.id)) titles.set(agent.id, title);
    },
    handoff: async (bindings, target) =>
      bindings.map((b) => ({ ...b, session_id: target, revision: b.revision + 1 })),
    flush: async () => true,
    warn: () => {},
    deliver: (agent, text) => deliveries.push({ id: agent.id, text }),
  };
  const center = new TaskCenter(store, host, () => now);
  center.kick = () => {};
  t.onTestFinished(async () => {
    await center.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const agent = (id: string): TestAgent => {
    const value = agents.get(id);
    if (!value) throw new Error(`Missing test agent: ${id}`);
    return value;
  };
  return {
    dir,
    store,
    agents,
    archived,
    stored,
    agent,
    deliveries,
    titles,
    host,
    center,
    advance: (delta: number) => (now += delta),
  };
}
const create = (c: TaskCenter<TestAgent>) =>
  c.create(
    {
      title: "test",
      prompt: "check",
      cwd: "C:/test",
      rule: { kind: "interval", every_minutes: 20 },
    },
    "B",
  );
test("global list, revision checks, transfer targets one session, persistence", async (t) => {
  const f = fixture(t);
  const task = create(f.center);
  expect(f.center.list().length).toBe(1);
  await f.center.transfer(task.id, 1, "A");
  expect(() => f.center.remove(task.id, 1)).toThrow(/revision/);
  f.advance(65 * 60000);
  await f.center.dispatch(task.id, f.agent("A"));
  expect(f.deliveries.length).toBe(1);
  expect(f.deliveries[0].id).toBe("A");
  expect(f.deliveries[0].text).toMatch(/2026-09-10T01:00:00.000Z/);
  expect(f.center.task(task.id).next_at).toBe(Date.parse("2026-09-10T01:20:00Z"));
  expect((JSON.parse(fs.readFileSync(f.store.file, "utf8")) as StoreData).history.length).toBe(1);
});
test("transfer during persistence preflight rechecks destination", async (t) => {
  const f = fixture(t);
  const task = create(f.center);
  f.advance(20 * 60000);
  let release!: (ready: boolean) => void;
  f.host.flush = () => new Promise<boolean>((r) => (release = r));
  const pending = f.center.dispatch(task.id, f.agent("B"));
  await f.center.transfer(task.id, 1, "A");
  release(true);
  await pending;
  expect(f.deliveries.length).toBe(0);
  f.host.flush = async () => true;
  await f.center.dispatch(task.id, f.agent("A"));
  expect(f.deliveries.length).toBe(1);
  expect(f.deliveries[0].id).toBe("A");
});
test("busy session waits without injecting or spinning; cold session resumes through host", async (t) => {
  const f = fixture(t);
  const task = create(f.center);
  f.advance(20 * 60000);
  let release!: () => void;
  const agent = f.agent("B");
  agent.runMaintenance = () => {
    throw new Error("busy");
  };
  agent.whenIdle = () => new Promise<void>((r) => (release = r));
  await f.center.dispatch(task.id, agent);
  expect(f.deliveries.length).toBe(0);
  expect(f.center.waiters.size).toBe(1);
  agent.runMaintenance = (fn) => fn();
  release();
  await new Promise((r) => setImmediate(r));
  f.agents.delete("B");
  await f.center.prepareAndDispatch(task.id);
  expect(f.deliveries.length).toBe(1);
});
test("pause/resume starts from now, delete prevents delivery", async (t) => {
  const f = fixture(t);
  const task = create(f.center);
  f.center.update(task.id, 1, { enabled: false });
  f.advance(65 * 60000);
  await f.center.dispatch(task.id, f.agent("B"));
  expect(f.deliveries.length).toBe(0);
  const active = f.center.update(task.id, 2, { enabled: true });
  expect(active.next_at).toBe(Date.parse("2026-09-10T01:20:00Z"));
  f.center.remove(task.id, 3);
  f.advance(20 * 60000);
  await f.center.dispatch(task.id, f.agent("B"));
  expect(f.deliveries.length).toBe(0);
});
test("unconfirmed delivery pauses; restart retains uncertainty and lock excludes second owner", async (t) => {
  const f = fixture(t);
  const task = create(f.center);
  f.advance(20 * 60000);
  expect(() => new Store(f.dir)).toThrow(/另一个/);
  let calls = 0;
  f.host.flush = async () => ++calls === 1;
  await f.center.dispatch(task.id, f.agent("B"));
  expect(f.deliveries.length).toBe(1);
  expect(f.center.task(task.id).enabled).toBe(false);
  f.store.close();
  const reopened = new Store(f.dir);
  expect(reopened.data.tasks[0].enabled).toBe(false);
  expect(reopened.data.tasks[0].error).toMatch(/不确定/);
  reopened.close();
});
test("shutdown blocks future dispatch and releases store", async (t) => {
  const f = fixture(t);
  const task = create(f.center);
  f.advance(20 * 60000);
  await f.center.close();
  await f.center.dispatch(task.id, f.agent("B"));
  expect(f.deliveries.length).toBe(0);
  expect(fs.existsSync(f.store.lock)).toBe(false);
});
test("corrupt database is not overwritten", (t) => {
  const f = fixture(t);
  f.store.close();
  fs.writeFileSync(f.store.file, "BROKEN");
  expect(() => new Store(f.dir)).toThrow();
  expect(fs.readFileSync(f.store.file, "utf8")).toBe("BROKEN");
});
test("deletion while preflight is awaiting prevents delivery", async (t) => {
  const f = fixture(t),
    task = create(f.center);
  f.advance(20 * 60000);
  let release!: (ready: boolean) => void;
  f.host.flush = () => new Promise<boolean>((r) => (release = r));
  const pending = f.center.dispatch(task.id, f.agent("B"));
  f.center.remove(task.id, 1);
  release(true);
  await pending;
  expect(f.deliveries.length).toBe(0);
});
test("failed final disk writes never automatically duplicate an uncertain delivery", async (t) => {
  const f = fixture(t),
    task = create(f.center);
  f.advance(20 * 60000);
  const save = f.store.save.bind(f.store);
  f.host.deliver = (agent, text) => {
    f.deliveries.push({ id: agent.id, text });
    f.store.save = () => {
      throw new Error("disk full");
    };
  };
  await expect(f.center.dispatch(task.id, f.agent("B"))).rejects.toThrow(/disk full/);
  f.store.save = save;
  await f.center.dispatch(task.id, f.agent("B"));
  expect(f.deliveries.length).toBe(1);
  expect(f.center.task(task.id).dispatching).toBeTruthy();
});
test("archive during preflight blocks delivery and replaces the Session without pausing the task", async (t) => {
  const f = fixture(t),
    task = create(f.center);
  const other = f.center.create(
    {
      title: "other",
      prompt: "keep",
      cwd: "C:/test",
      rule: { kind: "interval", every_minutes: 20 },
    },
    "A",
  );
  f.advance(20 * 60000);
  let release!: (ready: boolean) => void;
  f.host.flush = () =>
    new Promise<boolean>((resolve) => {
      release = resolve;
    });
  const pending = f.center.dispatch(task.id, f.agent("B"));
  expect(f.center.sessionActivity("B").length).toBe(1);
  f.archived.add("B");
  release(true);
  await pending;
  expect(f.deliveries.length).toBe(0);
  expect(f.center.task(task.id).revision).toBe(1);
  expect(f.center.task(task.id).enabled).toBe(true);
  expect(f.center.task(other.id).enabled).toBe(true);
  f.host.flush = async () => true;
  await f.center.prepareAndDispatch(task.id);
  expect(f.deliveries).toHaveLength(1);
  expect(f.deliveries[0].id).not.toBe("B");
  expect(f.deliveries[0].text).toContain("B，但该会话已归档");
  expect(f.deliveries[0].text).toContain("会话搜索");
  expect(f.center.task(task.id).target_session_id).toBe(f.deliveries[0].id);
  expect(f.store.data.history[0].replacement_reason).toBe("archived");
  expect(f.archived.has("B")).toBe(true);
});

test("missing Session is replaced once, then reused with associated channel ownership", async (t) => {
  const f = fixture(t),
    task = create(f.center);
  f.center.task(task.id).feishu_bindings = [{ channel_id: "bot", session_id: "B", revision: 3 }];
  f.stored.delete("B");
  f.agents.delete("B");
  f.advance(20 * 60000);
  await f.center.prepareAndDispatch(task.id);
  const target = f.center.task(task.id).target_session_id;
  expect(f.deliveries[0].text).toContain("B，但该会话已不存在");
  expect(f.center.task(task.id).feishu_bindings[0].session_id).toBe(target);
  f.advance(20 * 60000);
  await f.center.prepareAndDispatch(task.id);
  expect(f.deliveries.map((d) => d.id)).toEqual([target, target]);
});

test("new mode creates a distinct Session for every occurrence without changing mode", async (t) => {
  const f = fixture(t);
  const task = f.center.create(
    {
      title: "new",
      prompt: "do it",
      cwd: "C:/test",
      target_mode: "new",
      rule: { kind: "interval", every_minutes: 20 },
    },
    "B",
  );
  for (let i = 0; i < 2; i++) {
    f.advance(20 * 60000);
    await f.center.prepareAndDispatch(task.id);
  }
  expect(new Set(f.deliveries.map((d) => d.id)).size).toBe(2);
  expect(f.center.task(task.id).target_mode).toBe("new");
  expect(f.center.task(task.id).target_session_id).toBeUndefined();
});

test("I/O failures never count as deletion or create a replacement", async (t) => {
  const f = fixture(t),
    task = create(f.center);
  f.advance(20 * 60000);
  f.host.describe = async () => {
    throw new Error("disk failure");
  };
  await expect(f.center.prepareAndDispatch(task.id)).rejects.toThrow("disk failure");
  expect(f.center.task(task.id).preparing).toBeUndefined();
  expect(f.agents.size).toBe(2);
  expect(f.deliveries).toHaveLength(0);
});

// Failure modes: optional Feishu downtime blocks execution, a failed handoff is
// hidden from the Agent/history, or a delivered occurrence is retried twice.
test("handoff failure is durable and visible without blocking or duplicating task delivery", async (t) => {
  const f = fixture(t),
    task = create(f.center);
  f.center.task(task.id).feishu_bindings = [{ channel_id: "bot", session_id: "B", revision: 3 }];
  f.archived.add("B");
  f.advance(20 * 60000);
  f.host.handoff = async () => {
    throw new Error("subscription changed");
  };
  await f.center.prepareAndDispatch(task.id);
  const target = f.deliveries[0].id;
  expect(f.deliveries[0].text).toContain("飞书订阅转交失败");
  expect(f.deliveries[0].text).toContain("subscription changed");
  expect(f.center.task(task.id).feishu_handoff).toMatchObject({
    state: "failed",
    target_session_id: target,
    error: "subscription changed",
  });
  expect(f.store.data.history[0].feishu_handoff).toEqual(f.center.task(task.id).feishu_handoff);
  expect(JSON.parse(fs.readFileSync(f.store.file, "utf8")).tasks[0].feishu_handoff.state).toBe(
    "failed",
  );
  await f.center.prepareAndDispatch(task.id);
  expect(f.deliveries).toHaveLength(1);
  expect(f.agents.size).toBe(3);
});

test("task transfer only moves Feishu channels when explicitly selected", async (t) => {
  const f = fixture(t),
    task = create(f.center);
  f.center.task(task.id).feishu_bindings = [{ channel_id: "bot", session_id: "B", revision: 3 }];
  let handoffs = 0;
  const handoff = f.host.handoff.bind(f.host);
  f.host.handoff = async (...args) => {
    handoffs++;
    return handoff(...args);
  };
  const moved = await f.center.transfer(task.id, 1, "A");
  expect(handoffs).toBe(0);
  expect(moved.feishu_bindings).toEqual([]);
  const linked = await f.center.transfer(task.id, moved.revision, "B", [
    { channel_id: "bot", session_id: "A", revision: 4 },
  ]);
  expect(handoffs).toBe(1);
  expect(linked.feishu_handoff?.state).toBe("succeeded");
  expect(linked.feishu_bindings[0].session_id).toBe("B");
});

test("manual handoff failure returns the moved task and its independent Feishu status", async (t) => {
  const f = fixture(t),
    task = create(f.center);
  f.host.handoff = async () => {
    throw new Error("plugin unavailable");
  };
  const moved = await f.center.transfer(task.id, 1, "A", [
    { channel_id: "bot", session_id: "B", revision: 3 },
  ]);
  expect(moved.target_session_id).toBe("A");
  expect(moved.feishu_handoff).toMatchObject({ state: "failed", error: "plugin unavailable" });
});

test("unlinked new Sessions never call the optional Feishu service", async (t) => {
  const f = fixture(t);
  f.host.handoff = async () => {
    throw new Error("must not call");
  };
  const task = f.center.create(
    {
      title: "independent",
      prompt: "run",
      cwd: "C:/test",
      target_mode: "new",
      rule: { kind: "interval", every_minutes: 20 },
    },
    "B",
  );
  f.advance(20 * 60000);
  await f.center.prepareAndDispatch(task.id);
  expect(f.deliveries).toHaveLength(1);
  expect(f.deliveries[0].text).not.toContain("飞书订阅转交失败");
  expect(f.center.task(task.id).feishu_handoff).toBeUndefined();
});

test("clearing optional bindings removes stale failure status before rearming a new Session", async (t) => {
  const f = fixture(t),
    task = create(f.center);
  f.center.task(task.id).feishu_bindings = [{ channel_id: "bot", session_id: "B", revision: 3 }];
  f.center.task(task.id).preparing = { session_id: "old-prepared", occurrence_at: task.next_at! };
  f.center.task(task.id).feishu_handoff = {
    state: "failed",
    target_session_id: "old-prepared",
    channel_ids: ["bot"],
    error: "old failure",
  };
  const updated = f.center.update(task.id, task.revision, {
    target_mode: "new",
    feishu_bindings: [],
    rule: { kind: "once", at: "2026-09-10T00:01:00Z" },
  });
  expect(updated.preparing).toBeUndefined();
  expect(updated.feishu_handoff).toBeUndefined();
  f.advance(60000);
  await f.center.prepareAndDispatch(task.id);
  expect(f.deliveries[0].id).not.toBe("old-prepared");
  expect(f.center.task(task.id).next_at).toBeNull();
});

test("invalid optional bindings are rejected before mutating persisted tasks", (t) => {
  const f = fixture(t),
    task = create(f.center);
  expect(() => f.center.update(task.id, 1, { feishu_bindings: null })).toThrow(/飞书关联/);
  expect(f.center.task(task.id).revision).toBe(1);
  expect(f.center.task(task.id).feishu_bindings).toEqual([]);
});

test("retargeting excludes concurrent mutation and dispatch until its handoff commits", async (t) => {
  const f = fixture(t),
    task = create(f.center);
  f.advance(20 * 60000);
  let release!: () => void;
  f.host.describe = () =>
    new Promise((resolve) => {
      release = () => resolve({ state: "available", cwd: "C:/test" });
    });
  const moving = f.center.transfer(task.id, 1, "A");
  expect(() => f.center.update(task.id, 1, { enabled: false })).toThrow("转交");
  expect(() => f.center.remove(task.id, 1)).toThrow("转交");
  await f.center.tick();
  expect(f.deliveries).toHaveLength(0);
  release();
  await moving;
  expect(f.center.task(task.id).target_session_id).toBe("A");
});

// Failure modes: missing/invalid titles, lost persistence, renaming existing Sessions,
// unnamed archive/deletion replacements, premature delivery and duplicate creation on retry.
test("creator chooses and updates the persistent title for newly created Sessions", async (t) => {
  const f = fixture(t);
  const task = f.center.create(
    {
      title: "task label",
      session_title: "创建者指定的会话",
      prompt: "run",
      cwd: "C:/test",
      target_mode: "new",
      rule: { kind: "interval", every_minutes: 20 },
    },
    "B",
  );
  expect(f.center.task(task.id).session_title).toBe("创建者指定的会话");
  expect(JSON.parse(fs.readFileSync(f.store.file, "utf8")).tasks[0].session_title).toBe(
    "创建者指定的会话",
  );
  f.advance(20 * 60000);
  await f.center.prepareAndDispatch(task.id);
  expect(f.titles.get(f.deliveries[0].id)).toBe("创建者指定的会话");
  f.center.update(task.id, f.center.task(task.id).revision, { session_title: "下一次的新标题" });
  f.advance(20 * 60000);
  await f.center.prepareAndDispatch(task.id);
  expect(f.titles.get(f.deliveries[1].id)).toBe("下一次的新标题");
  expect(f.titles.get(f.deliveries[0].id)).toBe("创建者指定的会话");
});

test("an omitted Session title defaults to the task name without renaming a reused Session", async (t) => {
  const f = fixture(t),
    existing = create(f.center);
  f.titles.set("B", "用户已有名称");
  f.advance(20 * 60000);
  await f.center.prepareAndDispatch(existing.id);
  expect(f.titles.get("B")).toBe("用户已有名称");
  const fresh = f.center.create(
    {
      title: "默认会话名称",
      prompt: "run",
      cwd: "C:/test",
      target_mode: "new",
      rule: { kind: "interval", every_minutes: 20 },
    },
    "B",
  );
  f.advance(20 * 60000);
  await f.center.prepareAndDispatch(fresh.id);
  expect(f.titles.get(f.deliveries.at(-1)!.id)).toBe("默认会话名称");
});

test.for(["", "   ", "a\nb", "x".repeat(201), 42, null].map((value) => ({ value })))(
  "invalid Session title %j is rejected before writing a task",
  ({ value }, t) => {
    const f = fixture(t);
    expect(() =>
      f.center.create(
        {
          title: "task",
          session_title: value,
          prompt: "run",
          cwd: "C:/test",
          target_mode: "new",
          rule: { kind: "interval", every_minutes: 20 },
        },
        "B",
      ),
    ).toThrow(/session_title/);
    expect(f.store.data.tasks).toHaveLength(0);
    const task = create(f.center);
    expect(() => f.center.update(task.id, 1, { session_title: value })).toThrow(/session_title/);
    expect(f.center.task(task.id).revision).toBe(1);
  },
);

test.for(["archived", "missing"] as const)(
  "%s replacement receives the creator's title",
  async (state, t) => {
    const f = fixture(t),
      task = create(f.center);
    f.center.update(task.id, 1, { session_title: "替代会话名称" });
    if (state === "archived") f.archived.add("B");
    else {
      f.stored.delete("B");
      f.agents.delete("B");
    }
    f.advance(20 * 60000);
    await f.center.prepareAndDispatch(task.id);
    expect(f.titles.get(f.deliveries[0].id)).toBe("替代会话名称");
  },
);

test("title failure blocks handoff and delivery, and retry reuses the prepared Session", async (t) => {
  const f = fixture(t),
    task = create(f.center);
  f.archived.add("B");
  f.advance(20 * 60000);
  const name = f.host.name.bind(f.host);
  const handoff = f.host.handoff.bind(f.host);
  let handoffs = 0;
  f.host.handoff = async (...args) => {
    handoffs++;
    return handoff(...args);
  };
  f.host.name = async () => {
    throw new Error("title failed");
  };
  await expect(f.center.prepareAndDispatch(task.id)).rejects.toThrow("title failed");
  const prepared = f.center.task(task.id).preparing!.session_id;
  expect(handoffs).toBe(0);
  expect(f.deliveries).toHaveLength(0);
  f.host.name = name;
  await f.center.prepareAndDispatch(task.id);
  expect(f.deliveries[0].id).toBe(prepared);
  expect(f.agents.size).toBe(3);
});

test("title must be durable before handoff or task delivery", async (t) => {
  const f = fixture(t),
    task = create(f.center);
  f.archived.add("B");
  f.advance(20 * 60000);
  f.host.flush = async () => false;
  await expect(f.center.prepareAndDispatch(task.id)).rejects.toThrow(/标题.*持久化/);
  expect(f.deliveries).toHaveLength(0);
  expect(f.center.task(task.id).dispatching).toBeUndefined();
  expect(f.center.task(task.id).target_session_id).toBe("B");
});
