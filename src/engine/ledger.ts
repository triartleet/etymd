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
  accepted: Finding[]
  /** Tracked findings in files this run excluded — held open, never counted as resolved. */
  outOfScope: LedgerEntry[]
}

/** Human-set resolutions, applied by `etymd dismiss` / `etymd accept`. */
export type HumanResolution = "dismissed" | "accepted"

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

/** A finding id names the file it came from: `<lens>/<class>:<file>[:<detail>]`. */
function belongsToAny(id: string, paths: string[]): boolean {
  return paths.some((p) => id.includes(`:${p}`))
}

/**
 * Reconcile fresh findings against the ledger. Pure: returns the updated ledger + the diff;
 * the caller decides whether to persist. A finding absent from a run is marked `done`
 * (resolved); a `done` entry that reappears becomes `regressed`; `dismissed` stays dismissed.
 *
 * `outOfScope` names files the run deliberately did not look at (config exclusions). Their
 * tracked findings are NOT absent because they were fixed — they are absent because nobody
 * looked. Recording them as resolved would let scoping rewrite unfixed problems as successes,
 * which is the same silence the exclusion disclosures exist to prevent. They are held untouched.
 */
export function reconcileLedger(
  ledger: Ledger,
  findings: Finding[],
  now = new Date().toISOString(),
  outOfScope: string[] = [],
): {
  ledger: Ledger
  diff: LedgerDiff
} {
  const byId = new Map(ledger.entries.map((e) => [e.id, e]))
  const seen = new Set<string>()
  const diff: LedgerDiff = {
    new: [],
    stillOpen: [],
    regressed: [],
    resolved: [],
    dismissed: [],
    accepted: [],
    outOfScope: [],
  }
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
    if (prev.status === "accepted") {
      // A human accepted this trade-off: keep it recorded and quiet, do not re-nag as "open".
      diff.accepted.push(f)
      entries.push({ ...prev, tier: f.tier, claim: f.claim, lastSeen: now })
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
    if (outOfScope.length && belongsToAny(prev.id, outOfScope)) {
      // Unexamined, not fixed: hold the entry exactly as it was (lastSeen untouched, so the
      // record still says when it was last actually looked at).
      diff.outOfScope.push(prev)
      entries.push(prev)
      continue
    }
    if (prev.status === "open" || prev.status === "accepted" || prev.status === "regressed") {
      diff.resolved.push(prev)
      entries.push({ ...prev, status: "done", lastSeen: now })
    } else {
      entries.push(prev)
    }
  }

  return { ledger: { version: 1, entries }, diff }
}

/**
 * Findings the report should surface: everything fresh except the human-quieted ones —
 * dismissed (a false positive) and accepted (a known trade-off) both drop out of the default
 * view. Reconcile still sees the full set, so quieted findings stay tracked and their eventual
 * fix is still counted as resolved.
 */
export function visibleFindings(findings: Finding[], ledger: Ledger): Finding[] {
  const quieted = new Set(
    ledger.entries
      .filter((e) => e.status === "dismissed" || e.status === "accepted")
      .map((e) => e.id),
  )
  return findings.filter((f) => !quieted.has(f.id))
}

/**
 * Apply a human resolution (`dismiss`/`accept`) to one ledger entry. Pure: returns the updated
 * ledger and the resulting entry, or `entry: null` when the id is not in the ledger (the caller
 * tells the human to run `etymd audit` first so the finding is on record).
 */
export function resolveEntry(
  ledger: Ledger,
  id: string,
  status: HumanResolution,
  reason: string | undefined,
  now = new Date().toISOString(),
): { ledger: Ledger; entry: LedgerEntry | null } {
  let updated: LedgerEntry | null = null
  const entries = ledger.entries.map((e) => {
    if (e.id !== id) return e
    updated = {
      ...e,
      status,
      // Keep an existing reason if none is supplied (e.g. re-accepting a once-dismissed item).
      reason: reason ?? e.reason,
      lastSeen: now,
    }
    return updated
  })
  if (!updated) return { ledger, entry: null }
  return { ledger: { version: 1, entries }, entry: updated }
}
