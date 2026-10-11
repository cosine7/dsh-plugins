import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../dist/store.js";
import { TaskCenter } from "../dist/center.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-task-center-test-"));
  const store = new Store(dir);
  let now = Date.parse("2026-09-10T00:00:00Z");
  const agents = new Map(),
    deliveries = [];
  for (const id of ["A", "B"])
    agents.set(id, { id, runMaintenance: (fn) => fn(), whenIdle: () => Promise.resolve() });
  const host = {
    get: (id) => agents.get(id),
    flush: async () => true,
    warn: () => {},
    deliver: (agent, text) => deliveries.push({ id: agent.id, text }),
  };
  const center = new TaskCenter(store, host, () => now);
  center.kick = () => {};
  t.after(async () => {
    await center.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, agents, deliveries, host, center, advance: (delta) => (now += delta) };
}
const create = (c) =>
  c.create({ title: "test", prompt: "check", rule: { kind: "interval", every_minutes: 20 } }, "B");
test("global list, revision checks, transfer targets one session, persistence", async (t) => {
  const f = fixture(t);
  const task = create(f.center);
  assert.equal(f.center.list().length, 1);
  f.center.transfer(task.id, 1, "A");
  assert.throws(() => f.center.remove(task.id, 1), /revision/);
  f.advance(65 * 60000);
  await f.center.dispatch(task.id, f.agents.get("A"));
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].id, "A");
  assert.match(f.deliveries[0].text, /2026-09-10T01:00:00.000Z/);
  assert.equal(f.center.task(task.id).next_at, Date.parse("2026-09-10T01:20:00Z"));
  assert.equal(JSON.parse(fs.readFileSync(f.store.file)).history.length, 1);
});
test("transfer during persistence preflight rechecks destination", async (t) => {
  const f = fixture(t);
  const task = create(f.center);
  f.advance(20 * 60000);
  let release;
  f.host.flush = () => new Promise((r) => (release = r));
  const pending = f.center.dispatch(task.id, f.agents.get("B"));
  f.center.transfer(task.id, 1, "A");
  release(true);
  await pending;
  assert.equal(f.deliveries.length, 0);
  f.host.flush = async () => true;
  await f.center.dispatch(task.id, f.agents.get("A"));
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].id, "A");
});
test("busy session waits without injecting or spinning; cold session not resumed", async (t) => {
  const f = fixture(t);
  const task = create(f.center);
  f.advance(20 * 60000);
  let release;
  const agent = f.agents.get("B");
  agent.runMaintenance = () => {
    throw new Error("busy");
  };
  agent.whenIdle = () => new Promise((r) => (release = r));
  await f.center.dispatch(task.id, agent);
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.center.waiters.size, 1);
  agent.runMaintenance = (fn) => fn();
  release();
  await new Promise((r) => setImmediate(r));
  f.agents.delete("B");
  await f.center.tick();
  assert.equal(f.deliveries.length, 0);
  f.agents.set("B", agent);
  await f.center.dispatch(task.id, agent);
  assert.equal(f.deliveries.length, 1);
});
test("pause/resume starts from now, delete prevents delivery", async (t) => {
  const f = fixture(t);
  const task = create(f.center);
  f.center.update(task.id, 1, { enabled: false });
  f.advance(65 * 60000);
  await f.center.dispatch(task.id, f.agents.get("B"));
  assert.equal(f.deliveries.length, 0);
  const active = f.center.update(task.id, 2, { enabled: true });
  assert.equal(active.next_at, Date.parse("2026-09-10T01:20:00Z"));
  f.center.remove(task.id, 3);
  f.advance(20 * 60000);
  await f.center.dispatch(task.id, f.agents.get("B"));
  assert.equal(f.deliveries.length, 0);
});
test("unconfirmed delivery pauses; restart retains uncertainty and lock excludes second owner", async (t) => {
  const f = fixture(t);
  const task = create(f.center);
  f.advance(20 * 60000);
  assert.throws(() => new Store(f.dir), /另一个/);
  let calls = 0;
  f.host.flush = async () => ++calls === 1;
  await f.center.dispatch(task.id, f.agents.get("B"));
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.center.task(task.id).enabled, false);
  f.store.close();
  const reopened = new Store(f.dir);
  assert.equal(reopened.data.tasks[0].enabled, false);
  assert.match(reopened.data.tasks[0].error, /不确定/);
  reopened.close();
});
test("shutdown blocks future dispatch and releases store", async (t) => {
  const f = fixture(t);
  const task = create(f.center);
  f.advance(20 * 60000);
  await f.center.close();
  await f.center.dispatch(task.id, f.agents.get("B"));
  assert.equal(f.deliveries.length, 0);
  assert.equal(fs.existsSync(f.store.lock), false);
});
test("corrupt database is not overwritten", (t) => {
  const f = fixture(t);
  f.store.close();
  fs.writeFileSync(f.store.file, "BROKEN");
  assert.throws(() => new Store(f.dir));
  assert.equal(fs.readFileSync(f.store.file, "utf8"), "BROKEN");
});
test("deletion while preflight is awaiting prevents delivery", async (t) => {
  const f = fixture(t),
    task = create(f.center);
  f.advance(20 * 60000);
  let release;
  f.host.flush = () => new Promise((r) => (release = r));
  const pending = f.center.dispatch(task.id, f.agents.get("B"));
  f.center.remove(task.id, 1);
  release(true);
  await pending;
  assert.equal(f.deliveries.length, 0);
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
  await assert.rejects(f.center.dispatch(task.id, f.agents.get("B")), /disk full/);
  f.store.save = save;
  await f.center.dispatch(task.id, f.agents.get("B"));
  assert.equal(f.deliveries.length, 1);
  assert(f.center.task(task.id).dispatching);
});
test("desktop archive stop pauses only its session and blocks delivery awaiting preflight", async (t) => {
  const f = fixture(t),
    task = create(f.center);
  const other = f.center.create(
    { title: "other", prompt: "keep", rule: { kind: "interval", every_minutes: 20 } },
    "A",
  );
  f.advance(20 * 60000);
  let release;
  f.host.flush = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = f.center.dispatch(task.id, f.agents.get("B"));
  assert.equal(f.center.sessionActivity("B").length, 1);
  f.center.stopSession("B");
  release(true);
  await pending;
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.center.task(task.id).revision, 2);
  assert.equal(f.center.task(task.id).enabled, false);
  assert.equal(f.center.task(other.id).enabled, true);
  assert.equal(f.center.sessionActivity("B").length, 0);
  f.center.stopSession("B");
  assert.equal(f.center.task(task.id).revision, 2);
  assert.equal(
    JSON.parse(fs.readFileSync(f.store.file)).tasks.find((entry) => entry.id === task.id).enabled,
    false,
  );
});
