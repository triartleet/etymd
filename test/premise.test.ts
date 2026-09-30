import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { run as premiseCommand } from "../src/commands/premise.js"
import { meetsFailOn } from "../src/engine/finding.js"
import {
  PREMISE_BRIEF_FILE,
  promoteBareTokens,
  renderBrief,
  runPremise,
} from "../src/engine/premise.js"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-premise-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function write(rel: string, contents: string) {
  const abs = path.join(dir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, contents, "utf8")
}

async function fixture() {
  await write("package.json", JSON.stringify({ name: "demo", scripts: { build: "tsup" } }))
  // An installed node_modules makes unknown commands checkable rather than "unverifiable".
  await write("node_modules/.bin/.keep", "")
  await write("src/real.ts", "export const x = 1\n")
  await write("AGENTS.md", "# AGENTS.md\n")
  await write("DECISIONS.md", "# Decisions\n\n## D-001 — 2026-01-01 — first\n\nScope: repo.\n")
}

/** The shape the false positives came from: `bootstrap/` and `docs/` exist, no `src/`. */
async function noSrcFixture() {
  await write("package.json", JSON.stringify({ name: "nosrc", private: true }))
  await write("bootstrap/setup.sh", "#!/bin/sh\n")
  await write("docs/fleet.md", "# Fleet\n")
}

const ctx = { rootedDirs: new Set(["src", "docs"]) }

describe("promoteBareTokens", () => {
  it("wraps bare paths, dirs and `run` invocations, leaving code spans alone", () => {
    const { text: out, skips } = promoteBareTokens(
      "Fix src/a.ts and docs/design/, then run npm run build; keep `src/b.ts` and Node.js as is. Skim docs/ too.",
      ctx,
    )
    expect(out).toContain("`src/a.ts`")
    expect(out).toContain("`docs/design/`")
    // A single segment with a trailing slash (`docs/`) is prose to the extractor as well.
    expect(out).not.toContain("`docs/`")
    expect(out).toContain("`npm run build`")
    expect(out).toContain("`src/b.ts`")
    expect(out).not.toContain("``src/b.ts``")
    // A bare file name without a directory is prose unless the author backticks it.
    expect(out).not.toContain("`Node.js`")
    expect(skips).toEqual({
      bareInvocations: 0,
      proseScripts: 0,
      hostnameLike: 0,
      unrootedDirs: 0,
      namespaced: 0,
    })
  })

  it("keeps trailing punctuation outside the span and skips URLs", () => {
    const { text: out } = promoteBareTokens(
      "Look at (src/x/y.ts). See https://example.com/a/b.ts too.",
      ctx,
    )
    expect(out).toContain("(`src/x/y.ts`).")
    expect(out).not.toContain("`https://example.com/a/b.ts`")
  })

  it("reads a bare `pnpm X` / `bun X` / `yarn X` in prose as a phrase, and counts it", () => {
    const { text: out, skips } = promoteBareTokens(
      "Migrate the pnpm monorepo to the bun runtime; regenerate the yarn lockfile; then npm run build and npm test.",
      ctx,
    )
    expect(out).not.toContain("`pnpm monorepo`")
    expect(out).not.toContain("`bun runtime`")
    expect(out).not.toContain("`yarn lockfile`")
    expect(out).toContain("`npm run build`")
    expect(out).toContain("`npm test`")
    expect(skips.bareInvocations).toBe(3)
  })

  it("leaves a function word or a one-letter stand-in after `run` as prose", () => {
    const { text: out, skips } = promoteBareTokens(
      "Make npm run the tests pass; the docs say `npm run X` where X is any script, e.g. pnpm run x.",
      ctx,
    )
    expect(out).not.toContain("`npm run the`")
    expect(out).not.toContain("`pnpm run x`")
    // The author's own code span is untouched.
    expect(out).toContain("`npm run X`")
    expect(skips.proseScripts).toBe(2)
  })

  it("reads a host-shaped first segment as a URL, not a repo path", () => {
    const { text: out, skips } = promoteBareTokens(
      "See github.com/acme/repo/blob/main/src/x.ts and docs.example.co.uk/guide.md; compare v1.2/notes.md and .github/workflows/ci.yml.",
      ctx,
    )
    expect(out).not.toContain("`github.com/acme/repo/blob/main/src/x.ts`")
    expect(out).not.toContain("`docs.example.co.uk/guide.md`")
    // A dotted segment that is not host-shaped (version, hidden dir) still promotes.
    expect(out).toContain("`v1.2/notes.md`")
    expect(out).toContain("`.github/workflows/ci.yml`")
    expect(skips.hostnameLike).toBe(2)
  })

  it("promotes a directory claim only when it starts where a real directory does", () => {
    const { text: out, skips } = promoteBareTokens(
      "The input/output/ flow (read/write/ too) lives beside src/legacy/ now.",
      ctx,
    )
    expect(out).not.toContain("`input/output/`")
    expect(out).not.toContain("`read/write/`")
    expect(out).toContain("`src/legacy/`")
    expect(skips.unrootedDirs).toBe(2)
  })

  it("never promotes a namespace-prefixed path — attached, separated, or before a code span", () => {
    const { text: out, skips } = promoteBareTokens(
      "Compare pc:src/other-kit/services/stt_service.py and lk: Sources/OtherKit/x.swift, but the note: src/real.ts line stays ours.",
      ctx,
    )
    expect(out).not.toContain("`pc:src/other-kit")
    expect(out).not.toContain("`src/other-kit")
    expect(out).not.toContain("`Sources/OtherKit")
    // A prose introducer is not a namespace — the path after it is still this repo's.
    expect(out).toContain("`src/real.ts`")
    expect(skips.namespaced).toBe(2)
  })
})

describe("runPremise", () => {
  it("ranks a missing named path as risk, a dead script as risk, a dead decision as gap", async () => {
    await fixture()
    const result = await runPremise({
      root: dir,
      task: "Fix the flaky test in src/legacy/foo.test.ts, make npm run lint pass, and update src/real.ts per D-009.",
    })
    const ids = result.findings.map((f) => f.id)
    expect(ids).toContain("premise/stale-path:task:src/legacy/foo.test.ts")
    expect(ids).toContain("premise/stale-command:task:lint")
    expect(ids).toContain("premise/dead-decision-ref:task:D-009")
    const byId = Object.fromEntries(result.findings.map((f) => [f.id, f]))
    expect(byId["premise/stale-path:task:src/legacy/foo.test.ts"]?.tier).toBe("risk")
    expect(byId["premise/stale-command:task:lint"]?.tier).toBe("risk")
    expect(byId["premise/dead-decision-ref:task:D-009"]?.tier).toBe("gap")
    // The existing path is reported as checked and present, not as a finding.
    expect(result.entities).toContainEqual({ kind: "path", value: "src/real.ts", exists: true })
    expect(result.entities).toContainEqual({ kind: "decision", value: "D-009", exists: false })
    expect(ids).not.toContain("premise/stale-path:task:src/real.ts")
    expect(meetsFailOn(result.findings, "risk")).toBe(true)
  })

  it("ranks a missing directory the task is about as risk when it starts at a real one", async () => {
    await fixture()
    const result = await runPremise({ root: dir, task: "Delete src/legacy/ and its tests." })
    expect(result.findings.map((f) => f.id)).toEqual(["premise/stale-path:task:src/legacy"])
    expect(result.findings[0]?.tier).toBe("risk")
  })

  it("treats a path quoted from another repo as outside this one, never as missing", async () => {
    await noSrcFixture()
    const result = await runPremise({
      root: dir,
      task: "Port the gate from src/other-kit/services/stt_service.py (see pc:src/other-kit/services/stt_service.py and oc: `docs/gateway/protocol.md`) to bootstrap/does-not-exist.sh.",
    })
    // Only the path rooted in THIS repo is accused; the quoted ones are not missing here.
    expect(result.findings.map((f) => f.id)).toEqual([
      "premise/stale-path:task:bootstrap/does-not-exist.sh",
    ])
    // Outside the repo is "could not be checked", never "missing here".
    expect(result.entities).toContainEqual({
      kind: "path",
      value: "src/other-kit/services/stt_service.py",
      exists: null,
    })
    const joined = result.disclosures.join("\n")
    expect(joined).toMatch(/outside this repo/)
    expect(joined).toMatch(/namespace prefix/)
  })

  it("reports a clean task with no findings and the premises handed to the agent", async () => {
    await fixture()
    const result = await runPremise({ root: dir, task: "Tidy src/real.ts and run npm run build." })
    expect(result.findings).toEqual([])
    expect(result.entities.map((e) => e.value).sort()).toEqual(["build", "src/real.ts"])
    expect(result.brief).toContain("Premises only you can verify")
    expect(result.brief).toContain("Tidy src/real.ts")
    expect(result.disclosures.some((d) => d.includes("no ledger"))).toBe(true)
  })

  it("does not accuse prose — and discloses every class it read as prose", async () => {
    await fixture()
    const result = await runPremise({
      root: dir,
      task: "Migrate the pnpm monorepo; see github.com/acme/repo/src/x.ts; the input/output/ flow; make npm run the tests pass; read ~/.claude/CLAUDE.md first, then AGENTS.md.",
    })
    expect(result.findings).toEqual([])
    expect(result.entities).toEqual([{ kind: "doc", value: "AGENTS.md", exists: true }])
    const joined = result.disclosures.join("\n")
    expect(joined).toMatch(/1 bare `pnpm X`/)
    expect(joined).toMatch(/1 `… run X` mention/)
    expect(joined).toMatch(/1 slash token\(s\) start with a host name/)
    expect(joined).toMatch(/1 slash-joined phrase/)
    expect(joined).toMatch(/1 well-known doc mention\(s\) sit inside `~\/` home paths/)
  })

  it("names the nothing-to-check case instead of looking clean by silence", async () => {
    await fixture()
    const result = await runPremise({ root: dir, task: "Make the onboarding feel less abrupt." })
    expect(result.findings).toEqual([])
    expect(result.entities).toEqual([])
    expect(result.disclosures[0]).toMatch(/nothing etymd can check/)
  })

  it("leaves zero trace in a repo that never opted in, and writes the brief where it did", async () => {
    await fixture()
    const cold = await runPremise({ root: dir, task: "Touch src/real.ts" })
    expect(cold.briefPath).toBeNull()
    await expect(fs.access(path.join(dir, ".etymd"))).rejects.toThrow()

    await fs.mkdir(path.join(dir, ".etymd"), { recursive: true })
    const warm = await runPremise({ root: dir, task: "Touch src/real.ts" })
    expect(warm.briefPath).toBe(PREMISE_BRIEF_FILE)
    const written = await fs.readFile(path.join(dir, PREMISE_BRIEF_FILE), "utf8")
    expect(written).toBe(warm.brief)

    const silent = await runPremise({ root: dir, task: "Touch src/real.ts", writeBrief: false })
    expect(silent.briefPath).toBeNull()
  })

  it("reads the task from a file source label unchanged", async () => {
    await fixture()
    const result = await runPremise({ root: dir, task: "Read src/real.ts", source: "PLAN.md" })
    expect(result.source).toBe("PLAN.md")
    expect(result.schema).toBe("premise/1")
  })
})

describe("renderBrief", () => {
  it("keeps the heading on one line for a multi-line task", () => {
    const task = "Plan:\n\n- run npm run build\n\n```sh\nnpm run build\n```"
    const [heading = ""] = renderBrief(task, [], []).split("\n")
    expect(heading).toBe("# Premise brief — Plan: - run npm run build ```sh npm run build ```")
  })
})

describe("premise command", () => {
  it("reads the task with --file, reports it as the source, and gates on --fail-on", async () => {
    await fixture()
    await write("PLAN.md", "Fix src/legacy/foo.test.ts\n")
    const out: string[] = []
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk))
      return true
    })
    const exitBefore = process.exitCode
    try {
      await premiseCommand({ cwd: dir, file: "PLAN.md", json: true, brief: false, failOn: "risk" })
      const result = JSON.parse(out.join(""))
      expect(result.source).toBe("PLAN.md")
      expect(result.findings.map((f: { id: string }) => f.id)).toEqual([
        "premise/stale-path:task:src/legacy/foo.test.ts",
      ])
      expect(process.exitCode).toBe(1)
    } finally {
      spy.mockRestore()
      process.exitCode = exitBefore
    }
  })

  it("refuses a bad --fail-on tier before running, and an empty task", async () => {
    await fixture()
    await expect(premiseCommand({ cwd: dir, task: "x", failOn: "bogus" })).rejects.toThrow(
      /--fail-on must be/,
    )
    await expect(premiseCommand({ cwd: dir, task: "  " })).rejects.toThrow(/--file -/)
  })
})
