import { defineConfig } from "tsup"

// Two separate builds so the shebang lands ONLY on the executable: the cli (binary, code-split
// per command, no dts) and the programmatic index (dts, no shebang). Runtime deps stay external
// so the bundle is thin and startup fast.
export default defineConfig([
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    target: "node18",
    platform: "node",
    splitting: true,
    treeshake: true,
    clean: true,
    minify: false,
    sourcemap: false,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node18",
    platform: "node",
    dts: true,
    splitting: false,
    treeshake: true,
    clean: false,
    minify: false,
    sourcemap: false,
  },
])
