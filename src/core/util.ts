import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

const pExecFile = promisify(execFile)

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function readJson<T = unknown>(p: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(p, "utf8")
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function readText(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8")
  } catch {
    return null
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** Run git in a repo, returning trimmed stdout or null on any failure (never throws). */
export async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await pExecFile("git", args, { cwd: root, timeout: 4000 })
    return stdout.trim()
  } catch {
    return null
  }
}

/** Prose word count — the unit etymd measures contract weight in (stable across tokenizers). */
export function wordCount(text: string): number {
  const m = text.trim().match(/\S+/g)
  return m ? m.length : 0
}

/** A deliberately rough token estimate (~0.75 words/token) for context-budget headroom talk. */
export function approxTokens(words: number): number {
  return Math.round(words / 0.75)
}

export function relativizePath(root: string, p: string): string {
  const r = path.relative(root, p)
  return r === "" ? "." : r
}

/**
 * True inside a CI runner. Some facts are properties of a DEVELOPER's machine (git hook wiring,
 * local tool installs) and are absent from an ephemeral checkout by design — judging them from CI
 * would fail the very gate this tool tells people to add. `CI` is set by every mainstream runner;
 * the named vars are belt-and-braces.
 */
export function isCiEnvironment(): boolean {
  const env = process.env
  return Boolean(
    env.CI ||
      env.GITHUB_ACTIONS ||
      env.GITLAB_CI ||
      env.BUILDKITE ||
      env.CIRCLECI ||
      env.JENKINS_URL ||
      env.TF_BUILD,
  )
}

/** Repo-relative POSIX form: `\` → `/`, no leading `./`, no trailing `/`. */
export function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
}

function globToRegExp(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 1
        // `a/**/b` must also match `a/b` — swallow the separator so `**` can span zero segments.
        if (glob[i + 1] === "/") {
          i += 1
          re += "(?:.*/)?"
        } else {
          re += ".*"
        }
      } else {
        re += "[^/]*"
      }
    } else if (c === "?") {
      re += "[^/]"
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    }
  }
  return new RegExp(`^${re}$`)
}

/**
 * Match a repo-relative path against a minimal glob (`*` within a segment, `**` across segments,
 * `?` one character). Bounded and dependency-free, like the workspace-glob expansion in detect.ts.
 * A wildcard-free pattern is a path prefix — `.claude/skills` covers everything under it, which is
 * how a human writing an exclude list expects it to read.
 */
export function matchesGlob(p: string, glob: string): boolean {
  const target = normalizeRelPath(p)
  const pattern = normalizeRelPath(glob)
  if (!pattern) return false
  if (!/[*?]/.test(pattern)) return target === pattern || target.startsWith(pattern + "/")
  return globToRegExp(pattern).test(target)
}

export function matchesAnyGlob(p: string, globs: string[]): boolean {
  return globs.some((g) => matchesGlob(p, g))
}
