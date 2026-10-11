import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

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
    .plugin((await load("dsh-session-persistence-jsonl")).default, {
      root: path.join(root, "sessions"),
      compression: "none",
    })
    .await();
  await ctx
    .plugin((await load("dsh-agent-loop")).default, { agents: [], maxParallelToolCalls: 1 })
    .await();
  const pluginFork = ctx.plugin(plugin);
  await pluginFork.await();
  const a = await ctx.agents.create({
    sessionId: "compat-A",
    options: { provider: "test", model: "test" },
    meta: { cwd: root },
  });
  const b = await ctx.agents.create({
    sessionId: "compat-B",
    options: { provider: "test", model: "test" },
  });
  assert.equal(
    a.agent.ctx.tools.schemas(a.agent).filter((tool) => tool.name.startsWith("task_center_"))
      .length,
    8,
  );
  const invoke = async (agent, name, args = {}) => {
    const result = await agent.ctx.tools.execute({
      name,
      arguments: args,
      callId: randomUUID(),
      agent,
      signal: new AbortController().signal,
    });
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result)}`);
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
  assert(
    (await activity("compat-A")).some(
      (entry) => entry.kind === "schedule" && entry.items.some((item) => item.id === task.id),
    ),
  );
  assert(!(await activity("compat-B")).some((entry) => entry.kind === "schedule"));
  await ctx.parallel("workspace/session-stop", { sessionId: "compat-A" });
  const archived = (await invoke(b.agent, "task_center_list")).find(
    (entry) => entry.id === task.id,
  );
  assert.equal(archived.enabled, false);
  assert.equal(archived.revision, moved.revision + 1);
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
      "DSH host integration: 8 tools, skills, transfer, no-cwd session, quit activity, archive stop, timer and durable inbox passed.",
    );
  } finally {
    a.agent.cancel({ kind: "user" });
    release();
  }
  await a.agent.whenIdle();
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
