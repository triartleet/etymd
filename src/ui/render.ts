import pc from "picocolors"

import type { Finding, LensReport } from "../engine/finding.js"
import type { LedgerDiff } from "../engine/ledger.js"
import type { ContextBudget, ProjectFacts } from "../core/types.js"
import { glyph, theme } from "./theme.js"

/** Strip ANSI so column widths measure printable length, not escape codes. */
function width(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length
}

function pad(s: string, len: number): string {
  return s + " ".repeat(Math.max(0, len - width(s)))
}

function maxWidth(items: string[]): number {
  return items.length ? Math.max(...items.map(width)) : 0
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
  const keyWidth = maxWidth(rows.map(([k]) => k))
  for (const [k, v] of rows) {
    print(`  ${theme.dim(pad(k, keyWidth))}  ${v}`)
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
    const nameWidth = maxWidth(facts.tree.dirs.slice(0, 12).map((d) => d.name + "/"))
    for (const d of facts.tree.dirs.slice(0, 12)) {
      print(`  ${pad(theme.info(d.name + "/"), nameWidth + 2)} ${theme.dim(`${d.files} files`)}`)
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
  const pathWidth = maxWidth(budget.files.map((f) => f.path))
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

/** A create/exists/differs summary for a set of planned files. */
export function renderPlan(
  files: { path: string; exists: boolean; differs?: boolean; label: string }[],
): void {
  section("Plan")
  for (const f of files) {
    const tag = !f.exists
      ? theme.ok("create")
      : f.differs
        ? theme.warn("differs")
        : theme.dim("same")
    print(`  ${pc.dim("[")}${tag}${pc.dim("]")} ${theme.info(f.path)}  ${theme.dim(f.label)}`)
  }
}

const TIER_BADGE: Record<Finding["tier"], string> = {
  risk: pc.red(pc.bold("RISK  ")),
  gap: pc.yellow(pc.bold("GAP   ")),
  polish: pc.dim(pc.bold("POLISH")),
}

export function renderFindings(findings: Finding[]): void {
  if (!findings.length) {
    print(`  ${glyph.ok} ${theme.dim("no findings — everything examined holds up")}`)
    return
  }
  for (const f of findings) {
    print()
    print(`  ${TIER_BADGE[f.tier]} ${theme.heading(f.claim)}`)
    print(`         ${theme.dim("evidence")}  ${f.evidence.join(theme.dim(" · "))}`)
    print(`         ${theme.dim("why")}       ${f.why}`)
    if (f.action) print(`         ${theme.dim("action")}    ${f.action}`)
    print(
      `         ${theme.dim(`effort ${f.effort} · confidence ${f.confidence} · ${f.lens} · ${theme.dim(f.id)}`)}`,
    )
  }
}

export function renderLensCoverage(reports: LensReport[]): void {
  section("Lens coverage")
  const titleWidth = maxWidth(reports.map((r) => r.title))
  for (const r of reports) {
    const status =
      r.status === "skipped"
        ? theme.bad(`could not run — ${r.reason ?? "unknown"}`)
        : r.findings.length
          ? theme.warn(`${r.findings.length} finding(s)`)
          : theme.ok("clean")
    print(
      `  ${r.status === "skipped" ? glyph.bad : glyph.ok}  ${pad(r.title, titleWidth)}  ${status}`,
    )
    for (const d of r.disclosures) print(`       ${theme.dim(`◦ ${d}`)}`)
  }
}

export function renderLedgerDiff(diff: LedgerDiff): void {
  const parts: string[] = []
  if (diff.new.length) parts.push(theme.warn(`${diff.new.length} new`))
  if (diff.stillOpen.length) parts.push(`${diff.stillOpen.length} still open`)
  if (diff.regressed.length) parts.push(theme.bad(`${diff.regressed.length} regressed`))
  if (diff.resolved.length) parts.push(theme.ok(`${diff.resolved.length} resolved`))
  if (diff.dismissed.length) parts.push(theme.dim(`${diff.dismissed.length} dismissed (hidden)`))
  if (parts.length) {
    print()
    print(`  ${theme.dim("since last audit:")} ${parts.join(theme.dim(" · "))}`)
  }
}
