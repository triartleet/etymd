import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { applyFiles } from "../src/core/apply.js"
import { rankFindings, type Finding } from "../src/engine/finding.js"
import {
  reconcileLedger,
  resolveEntry,
  visibleFindings,
  type Ledger,
} from "../src/engine/ledger.js"

function f(id: string, tier: Finding["tier"] = "gap", effort: Finding["effort"] = "M"): Finding {
  return {
    id,
    lens: id.split("/")[0] ?? "test",
    tier,
    claim: id,
    evidence: ["x"],
    why: "because",
    effort,
    confidence: "high",
  }
}

describe("rankFindings", () => {
  it("orders risk before gap before polish, cheapest first within a tier", () => {
    const ranked = rankFindings([
      f("a/1", "polish", "S"),
      f("a/2", "risk", "L"),
      f("a/3", "gap", "S"),
      f("a/4", "gap", "L"),
    ])
    expect(ranked.map((x) => x.id)).toEqual(["a/2", "a/3", "a/4", "a/1"])
  })
})

describe("reconcileLedger", () => {
  const empty: Ledger = { version: 1, entries: [] }

  it("new findings open; disappeared findings resolve; done reappearing regresses", () => {
    const first = reconcileLedger(empty, [f("l/a"), f("l/b")], "2026-01-01")
    expect(first.diff.new.map((x) => x.id)).toEqual(["l/a", "l/b"])

    // l/a disappears (fixed); l/b persists.
    const second = reconcileLedger(first.ledger, [f("l/b")], "2026-01-02")
    expect(second.diff.resolved.map((e) => e.id)).toEqual(["l/a"])
    expect(second.diff.stillOpen.map((x) => x.id)).toEqual(["l/b"])
    expect(second.ledger.entries.find((e) => e.id === "l/a")?.status).toBe("done")

    // l/a comes back — that is a regression, not a new finding.
    const third = reconcileLedger(second.ledger, [f("l/a"), f("l/b")], "2026-01-03")
    expect(third.diff.regressed.map((x) => x.id)).toEqual(["l/a"])
    expect(third.ledger.entries.find((e) => e.id === "l/a")?.status).toBe("regressed")
  })

  it("dismissed findings never resurface in the visible set", () => {
    const withDismissed: Ledger = {
      version: 1,
      entries: [
        {
          id: "l/x",
          status: "dismissed",
          tier: "gap",
          claim: "x",
          reason: "accepted trade-off",
          firstSeen: "t",
          lastSeen: "t",
        },
      ],
    }
    const fresh = [f("l/x"), f("l/y")]
    expect(visibleFindings(fresh, withDismissed).map((x) => x.id)).toEqual(["l/y"])
    const { ledger, diff } = reconcileLedger(withDismissed, fresh)
    expect(diff.dismissed.map((x) => x.id)).toEqual(["l/x"])
    expect(ledger.entries.find((e) => e.id === "l/x")?.status).toBe("dismissed")
    expect(ledger.entries.find((e) => e.id === "l/x")?.reason).toBe("accepted trade-off")
  })

  it("accepted findings are hidden and bucketed, not re-nagged as open", () => {
    const withAccepted: Ledger = {
      version: 1,
      entries: [
        {
          id: "l/x",
          status: "accepted",
          tier: "gap",
          claim: "x",
          firstSeen: "t",
          lastSeen: "t",
        },
      ],
    }
    const fresh = [f("l/x"), f("l/y")]
    expect(visibleFindings(fresh, withAccepted).map((x) => x.id)).toEqual(["l/y"])
    const { ledger, diff } = reconcileLedger(withAccepted, fresh)
    expect(diff.accepted.map((x) => x.id)).toEqual(["l/x"])
    expect(diff.stillOpen.map((x) => x.id)).toEqual([])
    expect(ledger.entries.find((e) => e.id === "l/x")?.status).toBe("accepted")
  })

  it("an accepted finding that disappears is counted resolved", () => {
    const withAccepted: Ledger = {
      version: 1,
      entries: [
        { id: "l/x", status: "accepted", tier: "gap", claim: "x", firstSeen: "t", lastSeen: "t" },
      ],
    }
    const { diff, ledger } = reconcileLedger(withAccepted, [], "2026-02-02")
    expect(diff.resolved.map((e) => e.id)).toEqual(["l/x"])
    expect(ledger.entries.find((e) => e.id === "l/x")?.status).toBe("done")
  })
})

describe("resolveEntry", () => {
  const base: Ledger = {
    version: 1,
    entries: [
      { id: "l/x", status: "open", tier: "gap", claim: "x", firstSeen: "t", lastSeen: "t" },
    ],
  }

  it("dismiss sets status + reason; accept sets status and keeps a prior reason", () => {
    const dismissed = resolveEntry(base, "l/x", "dismissed", "false alarm", "2026-03-03")
    expect(dismissed.entry?.status).toBe("dismissed")
    expect(dismissed.entry?.reason).toBe("false alarm")

    const accepted = resolveEntry(dismissed.ledger, "l/x", "accepted", undefined, "2026-03-04")
    expect(accepted.entry?.status).toBe("accepted")
    // No new reason supplied → the prior one survives rather than being wiped.
    expect(accepted.entry?.reason).toBe("false alarm")
  })

  it("returns entry:null for an id that is not in the ledger", () => {
    const { entry, ledger } = resolveEntry(base, "l/nope", "accepted", undefined)
    expect(entry).toBeNull()
    expect(ledger).toBe(base)
  })
})

describe("applyFiles", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-apply-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("skips existing files unless named in overwrite; chmods executables; mkdirs deep paths", async () => {
    await fs.writeFile(path.join(dir, "KEEP.md"), "mine\n", "utf8")
    const files = [
      { path: "KEEP.md", contents: "generated\n", exists: true, label: "keep" },
      { path: "deep/dir/NEW.md", contents: "new\n", exists: false, label: "new" },
      {
        path: "hooks/pre-push",
        contents: "#!/bin/sh\n",
        exists: false,
        executable: true,
        label: "hook",
      },
    ]
    const result = await applyFiles(dir, files)
    expect(result.skipped).toEqual(["KEEP.md"])
    expect(result.written.sort()).toEqual(["deep/dir/NEW.md", "hooks/pre-push"])
    expect(await fs.readFile(path.join(dir, "KEEP.md"), "utf8")).toBe("mine\n")
    const mode = (await fs.stat(path.join(dir, "hooks/pre-push"))).mode & 0o111
    expect(mode).not.toBe(0)

    const again = await applyFiles(dir, files, new Set(["KEEP.md"]))
    expect(again.written).toContain("KEEP.md")
    expect(await fs.readFile(path.join(dir, "KEEP.md"), "utf8")).toBe("generated\n")
  })
})
