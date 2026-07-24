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
