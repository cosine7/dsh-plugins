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
  const deliveries: { id: string; text: string }[] = [];
  for (const id of ["A", "B"])
    agents.set(id, { id, runMaintenance: (fn) => fn(), whenIdle: () => Promise.resolve() });
  const host: TaskCenterHost<TestAgent> = {
    get: (id) => agents.get(id),
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
    agent,
    deliveries,
    host,
    center,
    advance: (delta: number) => (now += delta),
  };
}
const create = (c: TaskCenter<TestAgent>) =>
  c.create({ title: "test", prompt: "check", rule: { kind: "interval", every_minutes: 20 } }, "B");
test("global list, revision checks, transfer targets one session, persistence", async (t) => {
  const f = fixture(t);
  const task = create(f.center);
  expect(f.center.list().length).toBe(1);
  f.center.transfer(task.id, 1, "A");
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
  f.center.transfer(task.id, 1, "A");
  release(true);
  await pending;
  expect(f.deliveries.length).toBe(0);
  f.host.flush = async () => true;
  await f.center.dispatch(task.id, f.agent("A"));
  expect(f.deliveries.length).toBe(1);
  expect(f.deliveries[0].id).toBe("A");
});
test("busy session waits without injecting or spinning; cold session not resumed", async (t) => {
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
  await f.center.tick();
  expect(f.deliveries.length).toBe(0);
  f.agents.set("B", agent);
  await f.center.dispatch(task.id, agent);
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
test("desktop archive stop pauses only its session and blocks delivery awaiting preflight", async (t) => {
  const f = fixture(t),
    task = create(f.center);
  const other = f.center.create(
    { title: "other", prompt: "keep", rule: { kind: "interval", every_minutes: 20 } },
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
  f.center.stopSession("B");
  release(true);
  await pending;
  expect(f.deliveries.length).toBe(0);
  expect(f.center.task(task.id).revision).toBe(2);
  expect(f.center.task(task.id).enabled).toBe(false);
  expect(f.center.task(other.id).enabled).toBe(true);
  expect(f.center.sessionActivity("B").length).toBe(0);
  f.center.stopSession("B");
  expect(f.center.task(task.id).revision).toBe(2);
  expect(
    (JSON.parse(fs.readFileSync(f.store.file, "utf8")) as StoreData).tasks.find(
      (entry) => entry.id === task.id,
    )?.enabled,
  ).toBe(false);
});
