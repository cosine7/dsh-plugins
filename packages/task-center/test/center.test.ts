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

test("preparation survives handoff failure without creating another Session", async (t) => {
  const f = fixture(t),
    task = create(f.center);
  f.archived.add("B");
  f.advance(20 * 60000);
  const handoff = f.host.handoff.bind(f.host);
  f.host.handoff = async () => {
    throw new Error("subscription changed");
  };
  await expect(f.center.prepareAndDispatch(task.id)).rejects.toThrow("subscription changed");
  const preparing = f.center.task(task.id).preparing!.session_id;
  f.host.handoff = handoff;
  await f.center.prepareAndDispatch(task.id);
  expect(f.deliveries[0].id).toBe(preparing);
  expect(f.agents.size).toBe(3);
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
