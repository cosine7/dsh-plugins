import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/center.ts", "src/rules.ts", "src/store.ts"],
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
