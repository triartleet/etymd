import { defineConfig } from "tsup"

// Two entries: the `clothaid` binary (cli) and a small programmatic surface (index).
// ESM-only, Node 18 target. Runtime deps stay external (installed alongside the package),
// so the bundle is thin and startup stays fast; command modules are code-split so only the
// invoked command's chunk is parsed.
export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  dts: true,
  splitting: true,
  treeshake: true,
  clean: true,
  minify: false,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
})
