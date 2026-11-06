/** Actual desktop Session Controller, workspace registry and JSONL reads; no user profile. */
export async function installSessionServices(ctx, load, root) {
  for (const [name, config] of [
    ["dsh-typert-registry", {}],
    ["dsh-fs-local", {}],
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
  await ctx.plugin(Query).await();
  // Without an explicit title, plugin-source prompts must not trigger human-prompt naming.
  await ctx
    .plugin((await load("dsh-session-title")).default, {
      fallbackMaxWords: 10,
      fallbackMaxBytes: 100,
      maxTitleBytes: 1024,
    })
    .await();
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
  await ctx.plugin(RemoteAccess).await();
  await ctx.plugin((await load("dsh-api-gateway")).default, {}).await();
  const { default: SessionController } = await load("dsh-api-session-controller");
  await ctx.plugin(SessionController, {}).await();
  return ctx.workspaceRegistry.create(root);
}
