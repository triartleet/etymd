import pc from "picocolors"

// A small, consistent palette so every command reads as one tool. picocolors auto-disables
// colour when output is not a TTY (piped/CI), so callers never branch on that.
export const theme = {
  brand: (s: string) => pc.magenta(pc.bold(s)),
  heading: (s: string) => pc.bold(s),
  dim: (s: string) => pc.dim(s),
  ok: (s: string) => pc.green(s),
  warn: (s: string) => pc.yellow(s),
  bad: (s: string) => pc.red(s),
  info: (s: string) => pc.cyan(s),
  accent: (s: string) => pc.cyan(s),
  code: (s: string) => pc.cyan(s),
  count: (s: string | number) => pc.bold(String(s)),
}

export const glyph = {
  ok: pc.green("●"),
  partial: pc.yellow("◐"),
  bad: pc.red("○"),
  bullet: pc.dim("·"),
  arrow: pc.dim("→"),
}
