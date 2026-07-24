import { promises as fs } from "node:fs"
import path from "node:path"

import type { Finding } from "./finding.js"
import { readJson } from "../core/util.js"

// The ledger is COMMITTED (unlike the scan cache): it is the project's improvement memory.
// Re-runs reconcile against it so resolved work stays resolved, dismissed items never
// resurface, and a regression is named as one instead of appearing "new".

export type LedgerStatus = "open" | "accepted" | "done" | "dismissed" | "regressed"

export interface LedgerEntry {
  id: string
  status: LedgerStatus
  tier: Finding["tier"]
  claim: string
  /** Only for dismissed — the human's reason, so the decision survives. */
  reason?: string
  firstSeen: string
  lastSeen: string
}

export interface Ledger {
  version: 1
  entries: LedgerEntry[]
}

export interface LedgerDiff {
  new: Finding[]
  stillOpen: Finding[]
  regressed: Finding[]
  resolved: LedgerEntry[]
  dismissed: Finding[]
}

export function ledgerPath(root: string): string {
  return path.join(root, ".etymd", "ledger.json")
}

export async function readLedger(root: string): Promise<Ledger> {
  return (await readJson<Ledger>(ledgerPath(root))) ?? { version: 1, entries: [] }
}

export async function writeLedger(root: string, ledger: Ledger): Promise<void> {
  const target = ledgerPath(root)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, JSON.stringify(ledger, null, 2) + "\n", "utf8")
}

/**
 * Reconcile fresh findings against the ledger. Pure: returns the updated ledger + the diff;
 * the caller decides whether to persist. A finding absent from a run is marked `done`
 * (resolved); a `done` entry that reappears becomes `regressed`; `dismissed` stays dismissed.
 */
export function reconcileLedger(
  ledger: Ledger,
  findings: Finding[],
  now = new Date().toISOString(),
): {
  ledger: Ledger
  diff: LedgerDiff
} {
  const byId = new Map(ledger.entries.map((e) => [e.id, e]))
  const seen = new Set<string>()
  const diff: LedgerDiff = { new: [], stillOpen: [], regressed: [], resolved: [], dismissed: [] }
  const entries: LedgerEntry[] = []

  for (const f of findings) {
    seen.add(f.id)
    const prev = byId.get(f.id)
    if (!prev) {
      diff.new.push(f)
      entries.push({
        id: f.id,
        status: "open",
        tier: f.tier,
        claim: f.claim,
        firstSeen: now,
        lastSeen: now,
      })
      continue
    }
    if (prev.status === "dismissed") {
      diff.dismissed.push(f)
      entries.push({ ...prev, lastSeen: now })
      continue
    }
    if (prev.status === "done") {
      diff.regressed.push(f)
      entries.push({ ...prev, status: "regressed", tier: f.tier, claim: f.claim, lastSeen: now })
      continue
    }
    diff.stillOpen.push(f)
    entries.push({ ...prev, tier: f.tier, claim: f.claim, lastSeen: now })
  }

  for (const prev of ledger.entries) {
    if (seen.has(prev.id)) continue
    if (prev.status === "open" || prev.status === "accepted" || prev.status === "regressed") {
      diff.resolved.push(prev)
      entries.push({ ...prev, status: "done", lastSeen: now })
    } else {
      entries.push(prev)
    }
  }

  return { ledger: { version: 1, entries }, diff }
}

/** Findings the report should surface: everything fresh except dismissed ones. */
export function visibleFindings(findings: Finding[], ledger: Ledger): Finding[] {
  const dismissed = new Set(ledger.entries.filter((e) => e.status === "dismissed").map((e) => e.id))
  return findings.filter((f) => !dismissed.has(f.id))
}
