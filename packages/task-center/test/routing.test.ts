import { expect, test, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { sessionRouting } from "../src/routing.js";

// Failure modes: retries overwrite a manual title; archived Sessions are named/resumed;
// the naming call silently falls back to editing raw files instead of the host service.
test("naming uses the official service and preserves an existing title on retry", async () => {
  const rename = vi.fn();
  const get = vi.fn().mockReturnValue(undefined);
  const ctx = {
    workspaceRegistry: { archivedSessionIds: [] },
    sessionTitle: { get, rename },
  } as unknown as Context;
  const agent = { id: "new-session", session: { id: "new-session" } } as Parameters<
    ReturnType<typeof sessionRouting>["name"]
  >[0];
  const routing = sessionRouting(ctx);
  await routing.name(agent, "创建者指定");
  expect(rename).toHaveBeenCalledWith(agent.session, "创建者指定");
  get.mockReturnValue({ title: "用户随后改名" });
  await routing.name(agent, "创建者指定");
  expect(rename).toHaveBeenCalledTimes(1);
});

test("naming refuses an archived prepared Session", async () => {
  const rename = vi.fn();
  const ctx = {
    workspaceRegistry: { archivedSessionIds: ["archived"] },
    sessionTitle: { get: () => undefined, rename },
  } as unknown as Context;
  const agent = { id: "archived", session: { id: "archived" } } as Parameters<
    ReturnType<typeof sessionRouting>["name"]
  >[0];
  await expect(sessionRouting(ctx).name(agent, "new title")).rejects.toThrow(/归档/);
  expect(rename).not.toHaveBeenCalled();
});
