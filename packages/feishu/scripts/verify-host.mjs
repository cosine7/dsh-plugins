import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import * as lark from "@larksuiteoapi/node-sdk";

// Actual desktop services, isolated user data, inert model and simulated Feishu network.
const modules = process.env.DSH_HOST_MODULES;
assert(modules, "Set DSH_HOST_MODULES and run with Desktop Electron in Node mode.");
const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
for (const name of ["dsh-tools", "dsh-llm", "dsh-credentials", "dsh-agent-loop"]) {
  const host = JSON.parse(
    fs.readFileSync(path.join(modules, "@deepseek-ai", name, "package.json"), "utf8"),
  );
  assert.equal(host.version, manifest.peerDependencies["@deepseek-ai/dsh-tools"]);
}
const load = (name) =>
  import(pathToFileURL(path.join(modules, "@deepseek-ai", name, "lib/index.js")));
const { Context, Service } = await load("cordis");
const { credentialRef } = await load("dsh-credentials");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-feishu-host-"));
process.env.DSH_HOME = root;
const ctx = new Context();
const errors = [];
ctx.on("internal/error", (error) => errors.push(String(error)));
let dispatcher;
const start = Object.getOwnPropertyDescriptor(lark.WSClient.prototype, "start");
const close = Object.getOwnPropertyDescriptor(lark.WSClient.prototype, "close");
const status = Object.getOwnPropertyDescriptor(lark.WSClient.prototype, "getConnectionStatus");
const adapter = lark.defaultHttpInstance.defaults.adapter;
lark.WSClient.prototype.start = async function (options) {
  dispatcher = options.eventDispatcher;
};
lark.WSClient.prototype.close = function () {};
lark.WSClient.prototype.getConnectionStatus = function () {
  return { state: "connected" };
};
lark.defaultHttpInstance.defaults.adapter = async (config) => ({
  config,
  status: 200,
  statusText: "OK",
  headers: {},
  data: config.url.includes("token")
    ? { code: 0, tenant_access_token: "fake", app_access_token: "fake", expire: 7200 }
    : { code: 0, data: { message_id: "om_host_card" } },
});
let release;
try {
  for (const name of [
    "dsh-session",
    "dsh-agent",
    "dsh-system-prompt",
    "dsh-tools",
    "dsh-session-projection",
    "dsh-skill",
  ])
    await ctx.plugin((await load(name)).default, {}).await();
  await ctx.plugin((await load("dsh-credentials-local")).default, { watch: false }).await();
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
  const plugin = await import("../dist/index.js");
  const fork = ctx.plugin(plugin);
  await fork.await();
  const a = await ctx.agents.create({
    sessionId: "feishu-A",
    options: { provider: "test", model: "test" },
    meta: { cwd: root },
  });
  const b = await ctx.agents.create({
    sessionId: "feishu-B",
    options: { provider: "test", model: "test" },
  });
  const invoke = async (agent, name, args = {}) => {
    const result = await agent.ctx.tools.execute({
      name,
      arguments: args,
      callId: randomUUID(),
      agent,
      signal: new AbortController().signal,
    });
    assert.equal(result.isError, false, name);
    assert(!result.value.error, JSON.stringify(result.value));
    return result.value;
  };
  assert.equal(
    a.agent.ctx.tools.schemas(a.agent).filter((t) => t.name.startsWith("feishu_")).length,
    18,
  );
  assert.equal((await invoke(a.agent, "feishu_status")).length, 0);
  assert.equal((await ctx.skills.get("dsh-feishu")).name, "dsh-feishu");
  await ctx.credentials.set(credentialRef("FEISHU_TEST_ID"), "cli_hosttest");
  await ctx.credentials.set(credentialRef("FEISHU_TEST_SECRET"), "host_test_secret");
  const channel = await invoke(a.agent, "feishu_configure", {
    label: "host-test",
    app_id_ref: "FEISHU_TEST_ID",
    app_secret_ref: "FEISHU_TEST_SECRET",
    authorized_open_id: "ou_host",
  });
  assert(dispatcher, "WS dispatcher registered");
  await dispatcher.invoke(
    {
      schema: "2.0",
      header: { event_type: "im.message.receive_v1", event_id: "unassigned" },
      event: {
        sender: { sender_type: "user", sender_id: { open_id: "ou_host" } },
        message: {
          message_type: "text",
          message_id: "om_unassigned",
          chat_id: "oc_host",
          chat_type: "p2p",
          content: '{"text":"unassigned message"}',
        },
      },
    },
    { needCheck: false },
  );
  const subscribed = await invoke(a.agent, "feishu_subscribe", {
    channel_id: channel.id,
    revision: channel.revision,
  });
  assert.equal((await invoke(b.agent, "feishu_events"))[0].state, "unassigned");
  const sent = await invoke(a.agent, "feishu_send_card", {
    channel_id: channel.id,
    title: "host confirmation",
    content: "original full context",
    choices: [
      { id: "execute", label: "执行" },
      { id: "ignore", label: "忽略" },
    ],
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    request_id: "host_card",
  });
  const moved = await invoke(b.agent, "feishu_transfer", {
    channel_id: channel.id,
    revision: subscribed.revision,
  });
  assert.equal(moved.session_id, "feishu-B");
  const activity = (id) =>
    ctx.waterfall("workspace/session-activity", { sessionId: id }, () => Promise.resolve([]));
  assert(
    (await activity("feishu-B")).some((e) =>
      e.items.some((item) => item.id === `feishu:${channel.id}`),
    ),
  );
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  b.agent.ctx.on("agent/pre-step", async (_proposal, next) => {
    await barrier;
    return next();
  });
  const event = {
    schema: "2.0",
    header: { event_type: "card.action.trigger", event_id: "host_click" },
    event: {
      operator: { open_id: "ou_host" },
      action: { value: { dsh_card_id: sent.card.id, action_id: "execute" } },
      context: { open_message_id: "om_host_card", open_chat_id: "oc_host" },
    },
  };
  const response = await dispatcher.invoke(event, { needCheck: false });
  assert.equal(response.toast.type, "success");
  await dispatcher.invoke(event, { needCheck: false });
  const deadline = Date.now() + 5000;
  let events;
  do {
    events = await invoke(a.agent, "feishu_events", { state: "delivered" });
    if (events.length) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(events.length, 1, "card delivered exactly once");
  assert.equal(events[0].target_session_id, "feishu-B");
  assert.equal(await ctx.sessions.flush(b.agent.session), true);
  const reader = await ctx.sessionPersistence.open(b.agent.session.id, "read");
  try {
    const persisted = await reader.read();
    const messages = persisted.events
      .filter((e) => e.type === "agent/inbox/spliced")
      .flatMap((e) => e.data.inserted);
    assert.equal(
      messages.filter(
        (m) =>
          m.source.kind === plugin.name &&
          m.content.some((block) => block.text?.includes("original full context")),
      ).length,
      1,
    );
  } finally {
    await reader.close();
  }
  assert(!a.agent.session.ownEvents().some((e) => e.type === "agent/inbox/spliced"));
  const state = fs.readFileSync(path.join(root, "storages/cosine-feishu/state.json"), "utf8");
  assert(!state.includes("host_test_secret"));
  assert(!state.includes("cli_hosttest"));
  assert(
    fs.readFileSync(path.join(root, ".credentials.yaml"), "utf8").includes("host_test_secret"),
  );
  await ctx.parallel("workspace/session-stop", { sessionId: "feishu-B" });
  assert(!(await invoke(a.agent, "feishu_status"))[0].session_id);
  b.agent.cancel({ kind: "user" });
  release();
  await b.agent.whenIdle();
  await fork.dispose();
  assert(!fs.existsSync(path.join(root, "storages/cosine-feishu/owner.lock")));
  assert(!a.agent.ctx.tools.schemas(a.agent).some((t) => t.name.startsWith("feishu_")));
  await a.dispose();
  await b.dispose();
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(
    "DSH desktop host integration passed: real credentials, 18 tools, skills, unique subscription, transfer, SDK callbacks, deduplication, durable inbox, archive and disposal. Feishu network simulated; no trading agent used.",
  );
} finally {
  release?.();
  await ctx.fiber.dispose();
  Object.defineProperty(lark.WSClient.prototype, "start", start);
  Object.defineProperty(lark.WSClient.prototype, "close", close);
  Object.defineProperty(lark.WSClient.prototype, "getConnectionStatus", status);
  lark.defaultHttpInstance.defaults.adapter = adapter;
  const resolved = path.resolve(root);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
}
