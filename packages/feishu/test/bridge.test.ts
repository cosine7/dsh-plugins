import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { Bridge } from "../src/bridge.js";
import { Store } from "../src/store.js";
import { renderCard, deadline } from "../src/cards.js";
import type { IncomingMessage, MaintenanceAgent } from "../src/types.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dsh-feishu-test-"));
  const store = new Store(directory);
  const deliveries: { target: MaintenanceAgent; message: string }[] = [];
  const a: MaintenanceAgent = {
    runMaintenance: (operation) => operation(),
    whenIdle: async () => {},
  };
  const b: MaintenanceAgent = { ...a };
  const agents = new Map([
    ["A", a],
    ["B", b],
  ]);
  const flush = vi.fn(async () => true);
  let now = Date.now();
  const bridge = new Bridge(
    store,
    {
      get: (id) => agents.get(id),
      flush,
      warn: vi.fn(),
      deliver: (target, message) => deliveries.push({ target, message }),
    },
    () => now,
  );
  const channel = bridge.configure({
    label: "test",
    appIdRef: "TEST_APP_ID",
    appSecretRef: "TEST_APP_SECRET",
    openId: "ou_owner",
  });
  const msg: IncomingMessage = {
    messageId: "om_one",
    openId: "ou_owner",
    chatId: "oc_test",
    chatType: "p2p",
    senderType: "user",
    text: "你好",
  };
  const subscribe = (target = "A") =>
    bridge.subscribe(channel.id, target, bridge.channel(channel.id).revision, true);
  const create = () =>
    bridge.createCard(channel.id, "A", {
      title: "测试",
      content: "完整上下文",
      choices: [
        { id: "execute", label: "执行" },
        { id: "ignore", label: "忽略" },
      ],
      expires_at: new Date(now + 3600000).toISOString(),
    });
  const action = (cardId: string) => ({
    eventId: "one",
    cardId,
    actionId: "execute",
    messageId: "om_card",
    openId: "ou_owner",
    chatId: "oc_test",
  });
  cleanup.push(async () => {
    await bridge.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    bridge,
    store,
    channel,
    a,
    b,
    agents,
    deliveries,
    flush,
    msg,
    subscribe,
    create,
    action,
    time: (value: number) => {
      now = value;
    },
    directory,
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("unassigned messages stay recorded and are not backfilled on subscription", async () => {
  const f = fixture();
  expect(f.bridge.receiveMessage(f.channel.id, f.msg)).toBe(true);
  f.subscribe();
  await settle();
  expect(f.deliveries).toHaveLength(0);
  expect(f.bridge.events()[0]?.state).toBe("unassigned");
});
test("only authorized direct user messages are accepted; message IDs deduplicate", async () => {
  const f = fixture();
  f.subscribe();
  for (const patch of [{ openId: "ou_other" }, { chatType: "group" }, { senderType: "app" }])
    expect(f.bridge.receiveMessage(f.channel.id, { ...f.msg, ...patch })).toBe(false);
  expect(f.bridge.receiveMessage(f.channel.id, f.msg)).toBe(true);
  expect(f.bridge.receiveMessage(f.channel.id, f.msg)).toBe(false);
  await settle();
  expect(f.deliveries).toHaveLength(1);
  expect(f.bridge.events()[0]?.state).toBe("delivered");
});
test("one subscriber, explicit transfer and optimistic revisions", () => {
  const f = fixture();
  const first = f.subscribe();
  expect(() => f.bridge.subscribe(first.id, "B", first.revision)).toThrow("转交");
  const moved = f.subscribe("B");
  expect(moved.session_id).toBe("B");
  expect(() => f.bridge.unsubscribe(first.id, first.revision)).toThrow("revision");
  expect(() => f.bridge.subscribe(first.id, "cold", moved.revision)).toThrow("已加载");
});
test("a card created by A follows the current subscriber B with full context", async () => {
  const f = fixture();
  f.subscribe();
  const card = f.create();
  f.subscribe("B");
  const response = f.bridge.receiveAction(f.channel.id, f.action(card.id));
  expect(JSON.stringify(response)).toContain("待 Agent 处理");
  expect(JSON.stringify(response)).not.toContain('"tag":"button"');
  f.bridge.receiveAction(f.channel.id, {
    ...f.action(card.id),
    eventId: "two",
    actionId: "ignore",
  });
  await settle();
  expect(f.deliveries).toHaveLength(1);
  expect(f.deliveries[0]?.target).toBe(f.b);
  expect(f.deliveries[0]?.message).toContain("完整上下文");
  expect(f.bridge.events()[0]?.action_id).toBe("execute");
});
test("forged actor, message or chat cannot resolve a card", () => {
  const f = fixture();
  f.subscribe();
  const card = f.create();
  f.bridge.card(card.id).message_id = "om_card";
  expect(f.bridge.receiveAction(f.channel.id, { ...f.action(card.id), openId: "ou_bad" })).toEqual(
    {},
  );
  expect(
    f.bridge.receiveAction(f.channel.id, { ...f.action(card.id), messageId: "om_other" }),
  ).toEqual({});
  f.bridge.receiveMessage(f.channel.id, f.msg);
  expect(
    f.bridge.receiveAction(f.channel.id, { ...f.action(card.id), chatId: "oc_other" }),
  ).toEqual({});
  expect(f.bridge.card(card.id).state).toBe("pending");
});
test("Agent chooses expiry and late clicks never dispatch", async () => {
  const f = fixture();
  f.subscribe();
  const card = f.create();
  f.time(card.expires_at + 1);
  f.bridge.receiveAction(f.channel.id, f.action(card.id));
  await settle();
  expect(f.deliveries).toHaveLength(0);
  expect(f.bridge.card(card.id).state).toBe("expired");
  expect(f.bridge.events()[0]?.state).toBe("expired");
  expect(() => deadline("2027-01-01T12:00:00", Date.now())).toThrow("时区");
});
test("unsubscribed card clicks are recorded without automatically restoring creator", async () => {
  const f = fixture();
  f.subscribe();
  const card = f.create();
  f.bridge.unsubscribe(f.channel.id, f.bridge.channel(f.channel.id).revision);
  f.bridge.receiveAction(f.channel.id, f.action(card.id));
  f.subscribe("B");
  await settle();
  expect(f.bridge.events()[0]?.state).toBe("unassigned");
  expect(f.deliveries).toHaveLength(0);
});

test("a click after the expiry timer is still audited without delivery", async () => {
  const f = fixture();
  f.subscribe();
  const card = f.create();
  f.time(card.expires_at + 1);
  f.bridge.expireCards();
  f.bridge.receiveAction(f.channel.id, f.action(card.id));
  f.bridge.receiveAction(f.channel.id, f.action(card.id));
  await settle();
  expect(f.bridge.events()).toHaveLength(1);
  expect(f.bridge.events()[0]?.state).toBe("expired");
  expect(f.deliveries).toHaveLength(0);
});
test("transfer during pre-delivery persistence cannot deliver to the former subscriber", async () => {
  const f = fixture();
  f.subscribe();
  f.flush.mockImplementationOnce(async () => {
    f.subscribe("B");
    return true;
  });
  f.bridge.receiveMessage(f.channel.id, f.msg);
  await settle();
  expect(f.deliveries.some((d) => d.target === f.a)).toBe(false);
  f.bridge.kick();
  await settle();
  expect(f.deliveries[0]?.target).toBe(f.b);
});
test("failed post-delivery persistence is uncertain and never blindly repeated", async () => {
  const f = fixture();
  f.subscribe();
  f.flush.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  f.bridge.receiveMessage(f.channel.id, f.msg);
  await settle();
  f.bridge.kick();
  await settle();
  expect(f.bridge.events()[0]?.state).toBe("uncertain");
  expect(f.deliveries).toHaveLength(1);
});
test("busy Session waits for idle and receives without polling", async () => {
  const f = fixture();
  let idle!: () => void;
  const idlePromise = new Promise<void>((resolve) => {
    idle = resolve;
  });
  let busy = true;
  f.a.runMaintenance = (operation) => {
    if (busy) throw new Error("busy");
    return operation();
  };
  f.a.whenIdle = () => idlePromise;
  f.subscribe();
  f.bridge.receiveMessage(f.channel.id, f.msg);
  await settle();
  expect(f.deliveries).toHaveLength(0);
  busy = false;
  idle();
  await settle();
  await settle();
  expect(f.deliveries).toHaveLength(1);
});
test("cold sessions do not automatically load; archive removes subscription", async () => {
  const f = fixture();
  f.subscribe();
  f.agents.delete("A");
  f.bridge.receiveMessage(f.channel.id, f.msg);
  await settle();
  expect(f.deliveries).toHaveLength(0);
  f.bridge.stopSession("A");
  expect(f.bridge.channel(f.channel.id).session_id).toBeUndefined();
  expect(f.bridge.events()[0]?.state).toBe("unassigned");
});
test("card state updates use revision and do not claim click executed anything", () => {
  const f = fixture();
  f.subscribe();
  const card = f.create();
  f.bridge.receiveAction(f.channel.id, f.action(card.id));
  expect(() => f.bridge.updateCard(card.id, "A", card.revision, "未执行")).toThrow("revision");
  const updated = f.bridge.updateCard(
    card.id,
    "A",
    f.bridge.card(card.id).revision,
    "条件已变，未执行",
  );
  expect(JSON.stringify(renderCard(updated))).toContain("条件已变");
  expect(JSON.stringify(renderCard(updated))).not.toContain('"tag":"button"');
});
test("restart preserves bindings, deduplication and marks unfinished delivery uncertain", async () => {
  const f = fixture();
  f.subscribe();
  f.bridge.receiveMessage(f.channel.id, f.msg);
  await settle();
  f.store.transaction((data) => {
    data.events[0]!.state = "dispatching";
  });
  await f.bridge.close();
  const reopened = new Store(f.directory);
  try {
    expect(reopened.data.channels[0]?.session_id).toBe("A");
    expect(reopened.data.events[0]?.state).toBe("uncertain");
    expect(reopened.data.seen).toHaveLength(1);
  } finally {
    reopened.close();
  }
});
test("one writer lock and malformed state are fail closed", async () => {
  const f = fixture();
  expect(() => new Store(f.directory)).toThrow("另一个");
  await f.bridge.close();
  writeFileSync(f.store.file, "{broken");
  expect(() => new Store(f.directory)).toThrow();
  expect(readFileSync(f.store.file, "utf8")).toBe("{broken");
});
test("transaction errors roll back both memory and disk", () => {
  const f = fixture();
  const before = readFileSync(f.store.file, "utf8");
  expect(() =>
    f.store.transaction((data) => {
      data.channels[0]!.label = "broken";
      throw new Error("write failed");
    }),
  ).toThrow();
  expect(f.store.data.channels[0]?.label).toBe("test");
  expect(readFileSync(f.store.file, "utf8")).toBe(before);
});

test("configuration changes cannot overwrite a newer subscription revision", () => {
  const f = fixture();
  const before = f.channel.revision;
  f.subscribe();
  expect(() =>
    f.bridge.configure({
      id: f.channel.id,
      revision: before,
      label: "changed",
      appIdRef: "TEST_APP_ID",
      appSecretRef: "TEST_APP_SECRET",
      openId: "ou_owner",
    }),
  ).toThrow("revision");
  expect(f.bridge.channel(f.channel.id).label).toBe("test");
});
