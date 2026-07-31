import path from "node:path"

import { ETYMD_DIR } from "./facts.js"
import { pathExists, readText } from "./util.js"

// Optional, COMMITTED configuration — the third file in .etymd/ alongside the baseline (committed)
// and the cache (gitignored). A file, not a package.json key: the corpus already contains repos
// with no manifest at all, and a fork that must not touch upstream's manifest.
//
// Scoping is the reason this exists (a fork auditing its own instruction layer, not the ~60
// inherited upstream skills it will never fix). Because scoping can HIDE findings, every exclusion
// is counted and disclosed by the lens — a narrowed audit must never be able to look clean quietly.

export const CONFIG_FILE = path.join(ETYMD_DIR, "config.json")

export interface InstructionScope {
  /** Extra instruction files to audit beyond the auto-detected set (globs, repo-relative). */
  include: string[]
  /** Instruction files to leave out of the audit (globs, repo-relative). */
  exclude: string[]
}

export interface ContextBudgets {
  /** Words in one always-loaded file past which extraction is worth it. */
  perFileWords: number
  /** Total always-loaded words past which the footprint itself is a finding. */
  totalWords: number
}

export interface StateBudgets {
  /** Days of commit traffic a state doc may trail the repo by before it counts as stale. */
  staleAfterDays: number
  /** Chars in a state doc past which the file is a finding (session hooks truncate ~10k). */
  maxChars: number
}

export interface EtymdConfig {
  instructions: InstructionScope
  context: ContextBudgets
  state: StateBudgets
}

export interface LoadedConfig {
  config: EtymdConfig
  /** True when .etymd/config.json exists on disk (whether or not every key was usable). */
  present: boolean
  /** Malformed or ignored input — surfaced as disclosures, never silently dropped. */
  problems: string[]
}

export const DEFAULT_CONFIG: EtymdConfig = {
  instructions: { include: [], exclude: [] },
  context: { perFileWords: 4000, totalWords: 8000 },
  state: { staleAfterDays: 30, maxChars: 9500 },
}

export function configPath(root: string): string {
  return path.join(root, CONFIG_FILE)
}

function readGlobList(value: unknown, key: string, problems: string[]): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    problems.push(`${CONFIG_FILE}: \`${key}\` must be an array of glob strings — ignored.`)
    return undefined
  }
  return (value as string[]).map((g) => g.trim()).filter(Boolean)
}

function readBudget(value: unknown, key: string, problems: string[]): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    problems.push(`${CONFIG_FILE}: \`${key}\` must be a positive number — ignored.`)
    return undefined
  }
  return value
}

/**
 * Load `.etymd/config.json`, falling back to defaults per key. Unreadable or malformed input is
 * reported in `problems` rather than swallowed: config that silently fails to apply would let a
 * repo believe it is scoping an audit that is in fact running unscoped (or vice versa).
 */
export async function readConfig(root: string): Promise<LoadedConfig> {
  const target = configPath(root)
  const problems: string[] = []
  if (!(await pathExists(target))) {
    return { config: DEFAULT_CONFIG, present: false, problems }
  }

  const raw = await readText(target)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw ?? "")
  } catch (err) {
    problems.push(
      `${CONFIG_FILE} exists but is not valid JSON (${err instanceof Error ? err.message : String(err)}) — defaults used.`,
    )
    return { config: DEFAULT_CONFIG, present: true, problems }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    problems.push(`${CONFIG_FILE} must contain a JSON object — defaults used.`)
    return { config: DEFAULT_CONFIG, present: true, problems }
  }

  const obj = parsed as Record<string, unknown>
  const instructions = (obj.instructions ?? {}) as Record<string, unknown>
  const context = (obj.context ?? {}) as Record<string, unknown>
  const state = (obj.state ?? {}) as Record<string, unknown>

  return {
    present: true,
    problems,
    config: {
      instructions: {
        include:
          readGlobList(instructions.include, "instructions.include", problems) ??
          DEFAULT_CONFIG.instructions.include,
        exclude:
          readGlobList(instructions.exclude, "instructions.exclude", problems) ??
          DEFAULT_CONFIG.instructions.exclude,
      },
      context: {
        perFileWords:
          readBudget(context.perFileWords, "context.perFileWords", problems) ??
          DEFAULT_CONFIG.context.perFileWords,
        totalWords:
          readBudget(context.totalWords, "context.totalWords", problems) ??
          DEFAULT_CONFIG.context.totalWords,
      },
      state: {
        staleAfterDays:
          readBudget(state.staleAfterDays, "state.staleAfterDays", problems) ??
          DEFAULT_CONFIG.state.staleAfterDays,
        maxChars:
          readBudget(state.maxChars, "state.maxChars", problems) ?? DEFAULT_CONFIG.state.maxChars,
      },
    },
  }
}
