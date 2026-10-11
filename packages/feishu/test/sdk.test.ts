import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import * as lark from "@larksuiteoapi/node-sdk";
import { Bridge } from "../src/bridge.js";
import { Store } from "../src/store.js";
import { Transport, parseAction, parseMessage, type Credentials } from "../src/transport.js";
import { Setup } from "../src/setup.js";
import type { MaintenanceAgent } from "../src/types.js";

const originalAdapter = lark.defaultHttpInstance.defaults.adapter;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  lark.defaultHttpInstance.defaults.adapter = originalAdapter;
  vi.restoreAllMocks();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dsh-feishu-sdk-"));
  const agent: MaintenanceAgent = { runMaintenance: (fn) => fn(), whenIdle: async () => {} };
  const bridge = new Bridge(new Store(directory), {
    get: () => agent,
    flush: async () => true,
    deliver: vi.fn(),
    warn: vi.fn(),
  });
  const values = new Map<string, string>([
    ["TEST_ID", "cli_test"],
    ["TEST_SECRET", "PRIVATE_SECRET_SENTINEL"],
  ]);
  const credentials: Credentials = {
    resolve: async (ref) =>
      values.has(ref) ? { value: values.get(ref)!, source: "managed" } : undefined,
    set: async (ref, value) => {
      values.set(ref, value);
    },
    describe: async (ref) => ({ configured: values.has(ref), writable: true }),
  };
  const transport = new Transport(bridge, credentials);
  const channel = bridge.configure({
    label: "test",
    appIdRef: "TEST_ID",
    appSecretRef: "TEST_SECRET",
    openId: "ou_owner",
  });
  bridge.subscribe(channel.id, "A", channel.revision);
  const requests: { url?: string; method?: string; data?: unknown; timeout?: number }[] = [];
  let failure = false;
  const adapter = vi.fn(async (config: (typeof requests)[number]) => {
    requests.push(config);
    if (failure && config.url?.includes("/im/"))
      throw Object.assign(new Error("PRIVATE_SECRET_SENTINEL"), { code: "ETIMEDOUT", config });
    const data = config.url?.includes("token")
      ? {
          code: 0,
          tenant_access_token: "fake_access",
          app_access_token: "fake_access",
          expire: 7200,
        }
      : { code: 0, data: { message_id: "om_sent" } };
    return { data, status: 200, statusText: "OK", headers: {}, config };
  });
  lark.defaultHttpInstance.defaults.adapter =
    adapter as unknown as typeof lark.defaultHttpInstance.defaults.adapter;
  cleanup.push(async () => {
    await transport.close();
    await bridge.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const input = {
    title: "测试确认",
    content: "完整上下文",
    choices: [
      { id: "execute", label: "执行" },
      { id: "ignore", label: "忽略" },
    ],
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  };
  return {
    bridge,
    transport,
    credentials,
    values,
    channel,
    requests,
    input,
    directory,
    fail: () => {
      failure = true;
    },
  };
}

test("real SDK text send and concurrent idempotency use one API request", async () => {
  const f = fixture();
  const results = await Promise.all([
    f.transport.send(f.channel.id, "A", "你好", "same"),
    f.transport.send(f.channel.id, "A", "你好", "same"),
  ]);
  expect(results.some((r) => r.state === "sent")).toBe(true);
  expect(f.requests.filter((r) => r.url?.includes("/im/v1/messages"))).toHaveLength(1);
  expect(f.bridge.store.data.outbound).toHaveLength(1);
  await expect(f.transport.send(f.channel.id, "A", "different", "same")).rejects.toThrow(
    "其他消息",
  );
  expect(f.requests.every((r) => r.timeout === 30000)).toBe(true);
  expect(readFileSync(f.bridge.store.file, "utf8")).not.toContain("PRIVATE_SECRET_SENTINEL");
});
test("real SDK card send, callback acknowledgement and patch payload remove buttons", async () => {
  const f = fixture();
  const [sent] = await Promise.all([
    f.transport.sendCard(f.channel.id, "A", f.input, "card_same"),
    f.transport.sendCard(f.channel.id, "A", f.input, "card_same"),
  ]);
  expect(f.bridge.store.data.cards).toHaveLength(1);
  const response = f.bridge.receiveAction(f.channel.id, {
    eventId: "e",
    cardId: sent!.card.id,
    actionId: "execute",
    openId: "ou_owner",
    chatId: "oc_chat",
    messageId: "om_sent",
  });
  expect(JSON.stringify(response)).not.toContain('"tag":"button"');
  await vi.waitFor(() => expect(f.requests.some((r) => r.method === "patch")).toBe(true));
  const patch = f.requests.find((r) => r.method === "patch")!;
  expect(JSON.stringify(patch.data)).toContain("待 Agent 处理");
  expect(JSON.stringify(patch.data)).not.toContain('\\"tag\\":\\"button\\"');
  await vi.waitFor(() => expect(f.bridge.card(sent!.card.id).dirty).toBe(false));
});
test("network uncertainty is durable, redacted and never automatically resent", async () => {
  const f = fixture();
  f.fail();
  await expect(f.transport.send(f.channel.id, "A", "hello", "uncertain")).rejects.toThrow("不确定");
  expect(f.bridge.store.data.outbound[0]?.state).toBe("uncertain");
  const retried = await f.transport.send(f.channel.id, "A", "hello", "uncertain");
  expect(retried.state).toBe("uncertain");
  expect(f.requests.filter((r) => r.url?.includes("/im/v1/messages"))).toHaveLength(1);
  expect(readFileSync(f.bridge.store.file, "utf8")).not.toContain("PRIVATE_SECRET_SENTINEL");
});
test("real SDK EventDispatcher receives current text and card event envelopes", async () => {
  const f = fixture();
  let dispatcher: lark.EventDispatcher | undefined;
  vi.spyOn(lark.WSClient.prototype, "start").mockImplementation(async (options) => {
    dispatcher = options.eventDispatcher;
  });
  vi.spyOn(lark.WSClient.prototype, "close").mockImplementation(() => {});
  await f.transport.connect(f.channel.id);
  expect(dispatcher).toBeDefined();
  await dispatcher!.invoke(
    {
      schema: "2.0",
      header: { event_type: "im.message.receive_v1", event_id: "event_one" },
      event: {
        sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
        message: {
          message_type: "text",
          message_id: "om_incoming",
          chat_id: "oc_chat",
          chat_type: "p2p",
          content: '{"text":"hello"}',
        },
      },
    },
    { needCheck: false },
  );
  expect(f.bridge.events()).toHaveLength(1);
  const sent = await f.transport.sendCard(f.channel.id, "A", f.input, "dispatch_card");
  const response = await dispatcher!.invoke(
    {
      schema: "2.0",
      header: { event_type: "card.action.trigger", event_id: "card_event" },
      event: {
        operator: { open_id: "ou_owner" },
        action: { value: { dsh_card_id: sent.card.id, action_id: "ignore" } },
        context: { open_message_id: "om_sent", open_chat_id: "oc_chat" },
        token: "DO_NOT_PERSIST_CALLBACK_TOKEN",
      },
    },
    { needCheck: false },
  );
  expect(response.toast.type).toBe("success");
  expect(f.bridge.events()).toHaveLength(2);
  expect(readFileSync(f.bridge.store.file, "utf8")).not.toContain("DO_NOT_PERSIST_CALLBACK_TOKEN");
});
test("malformed and non-text events do not parse as incoming text", () => {
  expect(parseMessage({ message: { message_type: "image" }, sender: {} })).toBeUndefined();
  expect(parseMessage({})).toBeUndefined();
  expect(parseAction({ action: {} })).toBeUndefined();
});

test("a failing card update does not block other robot channels", async () => {
  const f = fixture();
  f.values.set("OTHER_ID", "cli_other");
  const second = f.bridge.configure({
    label: "other",
    appIdRef: "OTHER_ID",
    appSecretRef: "TEST_SECRET",
    openId: "ou_owner",
  });
  f.bridge.subscribe(second.id, "A", second.revision);
  const firstCard = f.bridge.createCard(f.channel.id, "A", f.input);
  const secondCard = f.bridge.createCard(second.id, "A", f.input);
  f.bridge.store.transaction(() => {
    Object.assign(f.bridge.card(firstCard.id), { message_id: "om_bad", dirty: true });
    Object.assign(f.bridge.card(secondCard.id), { message_id: "om_good", dirty: true });
  });
  const adapter = lark.defaultHttpInstance.defaults.adapter;
  lark.defaultHttpInstance.defaults.adapter = (async (config) => {
    if (config.url?.includes("om_bad")) throw new Error("simulated unavailable message");
    return await (adapter as (value: typeof config) => Promise<unknown>)(config);
  }) as typeof lark.defaultHttpInstance.defaults.adapter;
  f.transport.syncCards();
  await vi.waitFor(() => expect(f.bridge.card(secondCard.id).dirty).toBe(false));
  expect(f.bridge.card(firstCard.id).dirty).toBe(true);
});
test("QR onboarding stores only references outside DSH credentials", async () => {
  const f = fixture();
  let finish!: (result: Awaited<ReturnType<typeof lark.registerApp>>) => void;
  const registered = new Promise<Awaited<ReturnType<typeof lark.registerApp>>>((resolve) => {
    finish = resolve;
  });
  const register: typeof lark.registerApp = async (options) => {
    options.onQRCodeReady?.({
      url: "https://open.feishu.cn/test?opaque=a%2Bb",
      expireIn: 600,
    });
    return registered;
  };
  const setup = new Setup(f.bridge, f.credentials, async () => {}, register);
  cleanup.unshift(() => setup.close());
  const job = await setup.start({ mode: "create", label: "new" });
  expect(job.state).toBe("awaiting_scan");
  expect(job.verification_url).toContain("a%2Bb");
  finish({
    client_id: "cli_created",
    client_secret: "NEW_PRIVATE_SECRET",
    user_info: { open_id: "ou_owner" },
  });
  await vi.waitFor(async () =>
    expect(((await setup.status(job.job_id)) as { state: string }).state).toBe("completed"),
  );
  expect([...f.values.values()]).toContain("NEW_PRIVATE_SECRET");
  expect(JSON.stringify(await setup.status())).not.toContain("NEW_PRIVATE_SECRET");
  expect(readFileSync(f.bridge.store.file, "utf8")).not.toContain("cli_created");
  expect(readFileSync(f.bridge.store.file, "utf8")).not.toContain("NEW_PRIVATE_SECRET");
});
