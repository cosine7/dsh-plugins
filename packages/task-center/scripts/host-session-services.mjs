/** Actual desktop Session Controller, workspace registry and JSONL reads; no user profile. */
export async function installSessionServices(ctx, load, root) {
  for (const [name, config] of [
    ["dsh-typert-registry", {}],
    ["dsh-storage", {}],
    ["dsh-storage-json", { root: `${root}/storages` }],
    ["dsh-storage-domain", { backend: "json" }],
    ["dsh-workspace", {}],
  ]) {
    const module = await load(name);
    await ctx.plugin(module.default ?? module, config).await();
  }
  const { default: SessionQuery } = await load("dsh-session-query");
  class Query extends SessionQuery {
    async searchSessions() {
      throw new Error("No full text index in this isolated check");
    }
    async searchEvents() {
      throw new Error("No full text index in this isolated check");
    }
  }
  new Query(ctx);
  ctx.provide("agentDefaultModel", {
    currentSelection: () => ({ provider: "test", model: "test" }),
    saveSelection: async () => {},
  });
  ctx.provide("attachments", {
    imageLimits: {
      maxImageBytes: 5000000,
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 100000000,
      maxImagePixels: 40000000,
      maxImageDimension: 2000,
      mediaTypes: ["image/png"],
    },
  });
  ctx.provide("fileUploads", { registerAgentResolver: () => () => {} });
  const { default: RemoteAccess } = await load("dsh-api-remote-access");
  new RemoteAccess(ctx);
  const { default: SessionController } = await load("dsh-api-session-controller");
  new SessionController(ctx, {});
  return ctx.workspaceRegistry.create(root);
}
