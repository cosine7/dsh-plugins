import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { installSessionServices } from "./host-session-services.mjs";

// Use the actual host's services, rather than a second plugin-local runtime.
const modules = process.env.DSH_HOST_MODULES;
assert(
  modules,
  "Set DSH_HOST_MODULES to Desktop's app.asar/dsh/node_modules directory and run with Electron Node mode.",
);
const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
for (const name of ["dsh-tools", "dsh-llm", "dsh-home-paths", "dsh-session", "dsh-agent-loop"]) {
  const host = JSON.parse(
    fs.readFileSync(path.join(modules, "@deepseek-ai", name, "package.json"), "utf8"),
  );
  assert.equal(
    host.version,
    manifest.peerDependencies["@deepseek-ai/dsh-tools"],
    `${name} host version`,
  );
}
const load = (name) =>
  import(pathToFileURL(path.join(modules, "@deepseek-ai", name, "lib/index.js")));
const { Context, Service } = await load("cordis");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-task-center-host-"));
process.env.DSH_HOME = root;
const ctx = new Context();
const errors = [];
ctx.on("internal/error", (error) => errors.push(String(error)));
const plugin = await import("../dist/index.js");
try {
  for (const name of [
    "dsh-session",
    "dsh-agent",
    "dsh-system-prompt",
    "dsh-tools",
    "dsh-session-projection",
    "dsh-skill",
  ]) {
    await ctx.plugin((await load(name)).default, {}).await();
  }
  // Native execution is a separate scoped plugin starting with DSH 0.2.2.
  await ctx.plugin(await load("dsh-tool-executor-native")).await();
  // An inert LLM prevents network requests while exercising real inbox delivery.
  await ctx
    .plugin(
      class extends Service {
        constructor(context) {
          super(context, "llm");
          this.call = async () => {
            throw new Error("No model calls in host verification");
          };
        }
      },
    )
    .await();
  await ctx
    .plugin(await load("dsh-session-persistence-jsonl"), {
      root: path.join(root, "sessions"),
      compression: "none",
    })
    .await();
  await ctx.plugin((await load("dsh-agent-loop")).default, { agents: [] }).await();
  const workspace = await installSessionServices(ctx, load, root);
  const pluginFork = ctx.plugin(plugin);
  await pluginFork.await();
  const a = await ctx.agents.create({
    sessionId: "compat-A",
    agentOptions: { provider: "test", model: "test" },
    meta: { cwd: root },
  });
  const b = await ctx.agents.create({
    sessionId: "compat-B",
    agentOptions: { provider: "test", model: "test" },
  });
  assert.equal(
    a.agent.ctx.tools.schemas(a.agent).filter((tool) => tool.name.startsWith("task_center_"))
      .length,
    8,
  );
  const invoke = async (agent, name, args = {}) => {
    const batch = await agent.ctx.tools.execute({
      calls: [{ type: "tool-call", id: randomUUID(), name, arguments: JSON.stringify(args) }],
      agent,
      signal: new AbortController().signal,
    });
    const result = batch.results[0].result;
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result)}`);
    assert(!result.value.error, `${name}: ${JSON.stringify(result.value)}`);
    return result.value;
  };
  assert.equal((await invoke(a.agent, "task_center_list")).length, 0);
  const sessions = await invoke(a.agent, "task_center_sessions");
  assert.equal(sessions.sessions.length, 2);
  assert(
    !Object.hasOwn(
      sessions.sessions.find((session) => session.session_id === "compat-B"),
      "cwd",
    ),
  );
  assert.equal((await ctx.skills.get("dsh-task-center")).name, "dsh-task-center");
  const task = await invoke(b.agent, "task_center_create", {
    title: "compat",
    prompt: "delivery check",
    rule: { kind: "interval", every_minutes: 20 },
  });
  assert.equal(task.target_session_id, "compat-B");
  const moved = await invoke(a.agent, "task_center_transfer", {
    id: task.id,
    revision: task.revision,
  });
  assert.equal(moved.target_session_id, "compat-A");
  const activity = (sessionId) =>
    ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([]));
  assert(!(await activity("compat-A")).some((entry) => entry.kind === "schedule"));
  assert(!(await activity("compat-B")).some((entry) => entry.kind === "schedule"));
  await ctx.parallel("workspace/session-stop", { sessionId: "compat-A" });
  const archived = (await invoke(b.agent, "task_center_list")).find(
    (entry) => entry.id === task.id,
  );
  assert.equal(archived.enabled, true);
  assert.equal(archived.revision, moved.revision);
  assert(!(await activity("compat-A")).some((entry) => entry.kind === "schedule"));
  const resumed = await invoke(a.agent, "task_center_update", {
    id: task.id,
    revision: archived.revision,
    changes: { enabled: true },
  });
  const paused = await invoke(a.agent, "task_center_update", {
    id: task.id,
    revision: resumed.revision,
    changes: { enabled: false },
  });
  await invoke(b.agent, "task_center_delete", { id: task.id, revision: paused.revision });
  const preview = await invoke(a.agent, "task_center_preview", {
    rule: { kind: "interval", every_minutes: 20 },
  });
  assert(preview.upcoming.length > 0);
  // Park the driver at pre-step so a durable followup can be inspected without a provider.
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  a.agent.ctx.on("agent/pre-step", async (_proposal, next) => {
    await barrier;
    return next();
  });
  const once = await invoke(a.agent, "task_center_create", {
    title: "once",
    prompt: "delivery check",
    rule: { kind: "once", at: new Date(Date.now() + 300).toISOString() },
  });
  try {
    let history;
    const deadline = Date.now() + 5000;
    do {
      history = await invoke(b.agent, "task_center_history", { id: once.id });
      if (history.length) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    } while (Date.now() < deadline);
    assert.equal(
      history.length,
      1,
      `Timer delivered exactly once: ${JSON.stringify(await invoke(b.agent, "task_center_list"))}`,
    );
    assert.equal(history[0].state, "delivered");
    assert(
      a.agent.session
        .ownEvents()
        .some(
          (event) =>
            event.type === "agent/inbox/spliced" &&
            JSON.stringify(event.data).includes("delivery check"),
        ),
    );
    assert.equal(await ctx.sessions.flush(a.agent.session), true);
    const reader = await ctx.sessionPersistence.open(a.agent.session.id, "read");
    try {
      const persisted = await reader.read();
      const messages = persisted.events
        .filter((event) => event.type === "agent/inbox/spliced")
        .flatMap((event) => event.data.inserted);
      assert.equal(
        messages.filter(
          (message) =>
            message.source.kind === plugin.name &&
            message.content.some((block) => block.text?.includes("delivery check")),
        ).length,
        1,
      );
    } finally {
      await reader.close();
    }
    assert(
      !(await activity("compat-A")).some((entry) => entry.kind === "schedule"),
      "Completed one-shot is not armed",
    );
    console.log(
      "DSH host integration: tools, skills, transfer, archive preserves tasks, timer and durable inbox passed.",
    );
  } finally {
    a.agent.cancel({ kind: "user" });
    release();
  }
  await a.agent.whenIdle();

  // Both plugins share the real Cordis event routing seam; no external network is used.
  const { Bridge } = await import("../../feishu/dist/bridge.js");
  const { Store: FeishuStore } = await import("../../feishu/dist/store.js");
  const feishu = new Bridge(new FeishuStore(path.join(root, "feishu-test")), {
    get: (id) => ctx.agents.get(id),
    flush: (agent) => ctx.sessions.flush(agent.session),
    deliver() {},
    warn() {},
  });
  const bot = feishu.configure({
    label: "test",
    appIdRef: "TEST_ID",
    appSecretRef: "TEST_SECRET",
    openId: "ou_test",
  });
  feishu.subscribe(bot.id, "compat-A", bot.revision);
  ctx.on("cosine/feishu-bindings", async ({ sessionId }) => feishu.bindings(sessionId));
  ctx.on("cosine/feishu-handoff", async ({ bindings, targetSessionId }) =>
    feishu.handoff(bindings, targetSessionId),
  );
  ctx.on("workspace/session-stop", ({ sessionId }) => feishu.stopSession(String(sessionId)));
  const waitHistory = async (taskId) => {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      const history = await invoke(b.agent, "task_center_history", { id: taskId });
      if (history.length) return history;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.fail(
      `Task was not delivered: ${JSON.stringify(await invoke(b.agent, "task_center_list"))}`,
    );
  };
  try {
    await workspace.attachSession(a.agent.session.id);
    // Failure modes: a default create/transfer captures Feishu implicitly; callers
    // cannot explicitly attach/detach channels; stale optional handoffs block work.
    const independent = await invoke(a.agent, "task_center_create", {
      title: "independent",
      prompt: "not linked",
      cwd: root,
      target_mode: "new",
      rule: { kind: "interval", every_minutes: 20 },
    });
    assert.deepEqual(independent.feishu_bindings, []);
    const linked = await invoke(a.agent, "task_center_update", {
      id: independent.id,
      revision: independent.revision,
      changes: { feishu_channel_ids: [bot.id] },
    });
    assert.equal(linked.feishu_bindings[0].channel_id, bot.id);
    const onlyTask = await invoke(a.agent, "task_center_transfer", {
      id: linked.id,
      revision: linked.revision,
      target_session_id: "compat-B",
    });
    assert.equal(feishu.channel(bot.id).session_id, "compat-A");
    assert.deepEqual(onlyTask.feishu_bindings, []);
    await invoke(a.agent, "task_center_delete", { id: onlyTask.id, revision: onlyTask.revision });
    const replacement = await invoke(a.agent, "task_center_create", {
      title: "archive replacement",
      prompt: "isolated archive task",
      cwd: root,
      feishu_channel_ids: [bot.id],
      rule: { kind: "once", at: new Date(Date.now() + 350).toISOString() },
    });
    await ctx.workspaceRegistry.archiveSession(a.agent.id);
    const [receipt] = await waitHistory(replacement.id);
    assert.notEqual(receipt.target_session_id, "compat-A");
    assert.equal(receipt.replacement_reason, "archived");
    assert.equal(
      ctx.sessionTitle.get(ctx.agents.get(receipt.target_session_id).session).title,
      "archive replacement",
    );
    assert(ctx.workspaceRegistry.archivedSessionIds.includes(a.agent.id));
    assert(
      workspace.sessionIds.includes(receipt.target_session_id),
      "new Session belongs to Workspace",
    );
    assert.equal(feishu.channel(bot.id).session_id, receipt.target_session_id);
    assert.equal(
      (await ctx.sessionQuery.readSession(a.agent.id)).session.id,
      a.agent.id,
      "archived history is readable without unarchiving",
    );
    const cold = await ctx.agents.create({
      sessionId: "cold-target",
      meta: { cwd: root },
      agentOptions: { provider: "test", model: "test" },
    });
    const coldId = cold.agent.id;
    const coldTask = await invoke(b.agent, "task_center_create", {
      title: "cold",
      prompt: "isolated cold task",
      target_session_id: coldId,
      cwd: root,
      rule: { kind: "once", at: new Date(Date.now() + 350).toISOString() },
    });
    await ctx.sessions.flush(cold.agent.session);
    await cold.dispose();
    assert.equal(ctx.agents.get(coldId), undefined);
    assert.equal((await waitHistory(coldTask.id))[0].target_session_id, coldId);
    const fresh = await invoke(b.agent, "task_center_create", {
      title: "new",
      session_title: "创建者指定的验收标题",
      prompt: "isolated new task",
      target_mode: "new",
      cwd: root,
      rule: { kind: "once", at: new Date(Date.now() + 200).toISOString() },
    });
    const [created] = await waitHistory(fresh.id);
    assert.equal(
      ctx.sessionTitle.get(ctx.agents.get(created.target_session_id).session).title,
      "创建者指定的验收标题",
    );
    const titled = await ctx.sessionPersistence.open(created.target_session_id, "read");
    try {
      const persisted = await titled.read();
      const named = persisted.events.find((e) => e.type === "session/title");
      const taskInput = persisted.events.find((e) => e.type === "agent/inbox/spliced");
      assert.equal(named.data.title, "创建者指定的验收标题");
      assert(named.seq < taskInput.seq, "title must be persisted before the task message");
    } finally {
      await titled.close();
    }
    assert(workspace.sessionIds.includes(created.target_session_id));
    assert.equal(
      (await invoke(b.agent, "task_center_list")).find((t) => t.id === fresh.id).target_mode,
      "new",
    );
    const missing = await invoke(b.agent, "task_center_create", {
      title: "missing",
      prompt: "isolated missing task",
      target_session_id: "deleted-target",
      cwd: root,
      rule: { kind: "once", at: new Date(Date.now() + 200).toISOString() },
    });
    assert.equal((await waitHistory(missing.id))[0].replacement_reason, "missing");
    const owner = ctx.agents.get(feishu.channel(bot.id).session_id);
    const conflict = await invoke(owner, "task_center_create", {
      title: "conflicting optional handoff",
      prompt: "still execute despite Feishu conflict",
      target_mode: "new",
      cwd: root,
      feishu_channel_ids: [bot.id],
      rule: { kind: "once", at: new Date(Date.now() + 350).toISOString() },
    });
    const beforeNoop = feishu.channel(bot.id).revision;
    feishu.subscribe(bot.id, owner.id, beforeNoop, true);
    assert.equal(feishu.channel(bot.id).revision, beforeNoop);
    feishu.subscribe(bot.id, "compat-B", beforeNoop, true);
    const [conflictReceipt] = await waitHistory(conflict.id);
    assert.equal(conflictReceipt.feishu_handoff.state, "failed");
    assert.equal(feishu.channel(bot.id).session_id, "compat-B");
    const failedReader = await ctx.sessionPersistence.open(
      conflictReceipt.target_session_id,
      "read",
    );
    try {
      assert(JSON.stringify((await failedReader.read()).events).includes("飞书订阅转交失败"));
    } finally {
      await failedReader.close();
    }
    console.log(
      "DSH host Session Controller: cold resume, archive replacement, missing replacement, new Session, durable creator titles, workspace membership and Feishu handoff passed.",
    );
  } finally {
    await feishu.close();
  }
  await pluginFork.dispose();
  assert.equal(fs.existsSync(path.join(root, "storages/cosine-task-center/owner.lock")), false);
  const tools = a.agent.ctx.tools.schemas(a.agent);
  assert(!tools.some((tool) => tool.name.startsWith("task_center_")));
  assert(!(await activity("compat-A")).some((entry) => entry.kind === "schedule"));
  await a.dispose();
  await b.dispose();
  assert.equal(errors.length, 0, errors.join("\n"));
} finally {
  await ctx.fiber.dispose();
  const resolved = path.resolve(root);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
}
