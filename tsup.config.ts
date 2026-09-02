import { defineConfig } from "tsup";
export default defineConfig([
  {
    // The library ships for both module systems so it drops into any Node project.
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    target: "node20",
    platform: "node",
    dts: true,
    shims: true,
    splitting: false,
    clean: true,
    sourcemap: true,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    splitting: false,
    sourcemap: true,
  },
]);
