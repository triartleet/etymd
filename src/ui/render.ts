import pc from "picocolors"

import type { ContextBudget, ProjectFacts, Scorecard, ScoreLevel } from "../core/types.js"
import { glyph, theme } from "./theme.js"

/** Strip ANSI so column widths measure printable length, not escape codes. */
function width(s: string): number {
  return s.replace(/\[[0-9;]*m/g, "").length
}

function pad(s: string, len: number): string {
  return s + " ".repeat(Math.max(0, len - width(s)))
}

export function print(line = ""): void {
  process.stdout.write(line + "\n")
}

export function section(title: string): void {
  print()
  print(theme.heading(title))
}

/** Aligned key/value rows. */
export function keyValues(rows: [string, string][]): void {
  const keyWidth = Math.max(...rows.map(([k]) => width(k)))
  for (const [k, v] of rows) {
    print(`  ${theme.dim(pad(k, keyWidth))}  ${v}`)
  }
}

const LEVEL_GLYPH: Record<ScoreLevel, string> = {
  present: glyph.ok,
  partial: glyph.partial,
  absent: glyph.bad,
}

/** A horizontal score meter, e.g. ████████░░░░  67%. */
export function meter(score: number, cols = 24): string {
  const filled = Math.round((score / 100) * cols)
  const colour = score >= 70 ? theme.ok : score >= 40 ? theme.warn : theme.bad
  const bar = colour("█".repeat(filled)) + theme.dim("░".repeat(cols - filled))
  return `${bar}  ${colour(`${score}%`)}`
}

export function renderScorecard(card: Scorecard): void {
  section("Maturity")
  print(`  ${meter(card.score)}`)
  print()
  const labelWidth = Math.max(...card.dimensions.map((d) => width(d.label)))
  for (const d of card.dimensions) {
    print(`  ${LEVEL_GLYPH[d.level]}  ${pad(d.label, labelWidth)}  ${theme.dim(d.detail)}`)
  }
  const recs = card.dimensions.filter((d) => d.level !== "present" && d.recommendation)
  if (recs.length) {
    section("Recommendations")
    for (const d of recs) print(`  ${glyph.arrow} ${d.recommendation}`)
  }
}

export function renderFacts(facts: ProjectFacts): void {
  section(`Reckoning — ${theme.brand(facts.name)}`)
  keyValues([
    ["package manager", theme.info(facts.packageManager)],
    [
      "workspace",
      facts.workspace.kind === "none"
        ? "single package"
        : `${theme.info(facts.workspace.kind)}${facts.packages.length ? ` (${facts.packages.length} packages)` : ""}`,
    ],
    [
      "frameworks",
      facts.frameworks.length
        ? facts.frameworks.map((f) => theme.info(f)).join(theme.dim(", "))
        : theme.dim("none detected"),
    ],
    ["ci", facts.ci.system === "none" ? theme.dim("none") : theme.info(facts.ci.system)],
    [
      "git hooks",
      facts.hooks.source === "none" ? theme.dim("none") : theme.info(facts.hooks.source),
    ],
    [
      "branch",
      facts.git.branch
        ? `${facts.git.branch}${facts.git.head ? theme.dim(` @ ${facts.git.head}`) : ""}`
        : theme.dim("—"),
    ],
  ])

  const cmds = facts.commands
  const cmdRows: [string, string][] = []
  for (const role of [
    "test",
    "lint",
    "typecheck",
    "format",
    "formatCheck",
    "build",
    "dev",
  ] as const) {
    if (cmds[role]) cmdRows.push([role, theme.code(cmds[role] as string)])
  }
  if (cmdRows.length) {
    section("Discovered commands (Done =)")
    keyValues(cmdRows)
  }

  const present = facts.artifacts.filter((a) => a.exists)
  section("Agent artifacts")
  if (present.length) {
    for (const a of present) print(`  ${glyph.ok} ${a.label} ${theme.dim(a.path)}`)
  } else {
    print(`  ${theme.dim("none — this is a fresh project for agentic setup")}`)
  }

  if (facts.tree.dirs.length) {
    section("Top-level layout")
    for (const d of facts.tree.dirs.slice(0, 12)) {
      print(`  ${pad(theme.info(d.name + "/"), 22)} ${theme.dim(`${d.files} files`)}`)
    }
    if (facts.tree.truncated) print(`  ${theme.dim("… counts capped (large repo)")}`)
  }
}

export function renderContext(budget: ContextBudget, threshold: number): void {
  section("Context budget (always-loaded footprint)")
  if (!budget.files.length) {
    print(`  ${theme.dim("no always-loaded agent files found — nothing loads every session yet")}`)
    return
  }
  const pathWidth = Math.max(...budget.files.map((f) => width(f.path)))
  for (const f of budget.files) {
    const heavy = f.words >= threshold
    const words = heavy ? theme.warn(`${f.words} w`) : `${f.words} w`
    print(`  ${pad(theme.info(f.path), pathWidth)}  ${pad(words, 12)} ${theme.dim(f.role)}`)
  }
  print()
  keyValues([
    [
      "total",
      `${theme.count(budget.totalWords)} words ${theme.dim(`(~${budget.totalApproxTokens} tokens)`)} loaded every session`,
    ],
  ])
  if (budget.extractionCandidates.length) {
    section("Extraction candidates")
    print(
      `  ${theme.dim("These load every session but are rarely all needed. Move to an on-demand skill:")}`,
    )
    for (const f of budget.extractionCandidates) {
      print(`  ${glyph.arrow} ${theme.info(f.path)} ${theme.dim(`(${f.words} words)`)}`)
    }
  } else {
    print(`  ${glyph.ok} ${theme.dim("lean — no single file is heavy enough to extract yet")}`)
  }
}

/** A create/exists/skip diff summary for a set of planned files. */
export function renderPlan(files: { path: string; exists: boolean; label: string }[]): void {
  section("Plan")
  for (const f of files) {
    const tag = f.exists ? theme.warn("exists") : theme.ok("create")
    print(`  ${pc.dim("[")}${tag}${pc.dim("]")} ${theme.info(f.path)}  ${theme.dim(f.label)}`)
  }
}
