import { promises as fs } from "node:fs"
import path from "node:path"

import { git, pathExists, readText } from "../core/util.js"
import { print, section } from "../ui/render.js"
import { glyph, theme } from "../ui/theme.js"

/**
 * The content screen: does this repo carry text that must never be published?
 *
 * Etymd ships the MECHANISM and no policy. There are no built-in patterns and there never will
 * be — the strings worth screening for (an employer's name, a hostname, an account identifier)
 * are themselves the sensitive material, so a shipped list would be both useless to everyone
 * else and a leak for whoever wrote it. The user supplies a pattern file; without one this
 * command is inert and says so.
 *
 * Four doors, because a leak walks through whichever is unguarded:
 *
 *   --staged   what a commit is about to add       (pre-commit)
 *   --message  the commit message itself           (commit-msg — the staged scan cannot see it)
 *   --tree     every tracked file                  (pre-push: what is about to leave the machine)
 *   --dir      an unpacked build artifact          (prepublish: what actually SHIPS)
 *
 * The last one exists because the others share a blind spot: they all answer "what is in the
 * repository?". A gitignored file can still be packaged into a published artifact — npm and
 * vsce do not honour .gitignore — so every git-scoped check can pass forever while the bytes go
 * out to users.
 */

export type ScreenScope = "staged" | "tree" | "message" | "dir"

export interface ScreenOptions {
  cwd: string
  scope: ScreenScope
  /** Message file (commit-msg hook `$1`) or the directory to walk, per scope. */
  target?: string
  patterns?: string
  /** Report without failing — the pre-push door is advisory by default. */
  advisory?: boolean
}

/** Absolute home paths name the machine (and usually the person) — checked structurally. */
const MACHINE_PATH_RE = /\/(?:Users|home)\/[A-Za-z0-9._-]+\//

/** An inline escape hatch for a line that must legitimately contain a screened string. */
const ALLOW_MARKER = "allow-published-string"

export interface ScreenHit {
  file: string
  line: number
  text: string
  reason: string
}

function compile(raw: string): RegExp[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      try {
        return new RegExp(l, "i")
      } catch {
        // A malformed pattern must never be silently dropped — match it literally instead.
        return new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
      }
    })
}

export function screenText(text: string, file: string, patterns: RegExp[]): ScreenHit[] {
  const hits: ScreenHit[] = []
  const lines = text.split("\n")
  for (const [i, line] of lines.entries()) {
    if (line.includes(ALLOW_MARKER)) continue
    for (const re of patterns) {
      if (re.test(line)) {
        hits.push({ file, line: i + 1, text: line.trim().slice(0, 160), reason: String(re) })
        break
      }
    }
    if (MACHINE_PATH_RE.test(line)) {
      hits.push({
        file,
        line: i + 1,
        text: line.trim().slice(0, 160),
        reason: "absolute home path",
      })
    }
  }
  return hits
}

async function walk(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 12) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) await walk(abs, out, depth + 1)
    else out.push(abs)
  }
}

export async function run(opts: ScreenOptions): Promise<void> {
  const patternPath =
    opts.patterns ??
    process.env.ETYMD_SCREEN_PATTERNS ??
    process.env.PUBLIC_REPO_PATTERNS ??
    path.join(process.env.HOME ?? "", ".config", "etymd", "screen-patterns")

  const rawPatterns = await readText(patternPath)
  if (rawPatterns === null) {
    // Inert without policy, and honest about it: silence here would read as "screened, clean".
    print(
      `  ${glyph.partial} ${theme.dim(`no pattern file at ${patternPath} — nothing to screen against.`)}`,
    )
    print(
      `  ${theme.dim("Etymd ships no patterns by design: the strings worth screening for are themselves sensitive. Write one line per pattern (regex or literal, # for comments).")}`,
    )
    return
  }
  const patterns = compile(rawPatterns)
  if (!patterns.length) {
    print(`  ${glyph.partial} ${theme.dim(`${patternPath} has no active patterns — skipping.`)}`)
    return
  }

  const hits: ScreenHit[] = []
  let scanned = 0

  if (opts.scope === "message") {
    const file = opts.target
    if (!file) throw new Error("--message needs the message file path (the commit-msg hook's $1)")
    const raw = await readText(file)
    if (raw === null) return
    // git strips comment lines before storing the message — screening them would be noise.
    const body = raw
      .split("\n")
      .filter((l) => !l.startsWith("#"))
      .join("\n")
    scanned = 1
    hits.push(...screenText(body, "commit message", patterns))
  } else if (opts.scope === "dir") {
    const dir = opts.target
    if (!dir) throw new Error("--dir needs a directory")
    const files: string[] = []
    await walk(dir, files)
    for (const f of files) {
      const raw = await readText(f)
      if (raw === null) continue
      scanned++
      hits.push(...screenText(raw, path.relative(dir, f), patterns))
    }
  } else {
    const listing =
      opts.scope === "tree"
        ? await git(opts.cwd, ["ls-files"])
        : await git(opts.cwd, ["diff", "--cached", "--name-only", "--diff-filter=ACM"])
    const files = (listing ?? "").split("\n").filter(Boolean)
    for (const rel of files) {
      const abs = path.join(opts.cwd, rel)
      if (!(await pathExists(abs))) continue
      const raw = await readText(abs)
      if (raw === null) continue
      scanned++
      hits.push(...screenText(raw, rel, patterns))
    }
  }

  if (!hits.length) return

  section(`Content screen ${theme.dim(`· ${opts.scope} · ${scanned} file(s)`)}`)
  for (const h of hits) {
    print(`  ${theme.warn(h.file)}${theme.dim(`:${h.line}`)}  ${theme.dim(`(${h.reason})`)}`)
    print(`    ${h.text}`)
  }
  print("")
  print(
    `  ${theme.dim("Publishing exposes ALL history, so this content would be permanent the moment it is committed.")}`,
  )
  print(
    `  ${theme.dim(`Rewrite the line, mark a deliberate one with \`${ALLOW_MARKER}\`, or bypass with --no-verify.`)}`,
  )
  if (!opts.advisory) process.exitCode = 1
}
