import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/bridge.ts", "src/store.ts", "src/transport.ts", "src/setup.ts"],
  format: "esm",
  fixedExtension: false,
  platform: "node",
  target: "node24",
  sourcemap: true,
  minify: false,
  clean: true,
  dts: true,
  deps: { neverBundle: true },
});
