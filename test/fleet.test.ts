import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { loadFleetManifest } from "../src/core/fleet.js"
import { parseFailOnTier } from "../src/engine/finding.js"
import { sweep as sweepCmd, dismiss as fleetDismiss } from "../src/commands/fleet.js"
import {
  checkManifest,
  collectWallFindings,
  corpPersistenceRoot,
  emailMatchesCorpHosts,
  recurringClasses,
  sweepFleet,
  FLEET_JSON_SCHEMA,
  type FleetProjectSweep,
} from "../src/engine/fleet.js"
import { readLedger } from "../src/engine/ledger.js"

const pExecFile = promisify(execFile)

// Synthetic fixtures ONLY — invented names, invented hosts, temp dirs. Nothing here may carry
// real project vocabulary; the hygiene tests grep for needles that exist nowhere but here.

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-fleet-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function write(rel: string, contents: string) {
  const abs = path.join(dir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, contents, "utf8")
}

async function gitIn(
  cwd: string,
  date: string | null,
  args: string[],
  email = "fx@example.invalid",
) {
  await pExecFile("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: email,
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  })
}

async function commitAllIn(rel: string, message: string, date: string, email?: string) {
  const cwd = path.join(dir, rel)
  await gitIn(cwd, null, ["add", "-A"], email)
  await gitIn(cwd, date, ["commit", "-q", "--no-verify", "-m", message], email)
}

/** A tiny repo: one code file at `date`, optionally a state file committed earlier. */
async function initRepo(
  rel: string,
  opts: { stateAt?: string; codeAt?: string; email?: string } = {},
) {
  await gitIn(dir, null, ["init", "-q", path.join(dir, rel)])
  if (opts.stateAt) {
    await write(path.join(rel, "PROJECT_CONTEXT.md"), "# state\n\ncurrent work: alpha\n")
    await commitAllIn(rel, "state", opts.stateAt, opts.email)
  }
  await write(path.join(rel, "src.txt"), "code\n")
  await commitAllIn(rel, "code", opts.codeAt ?? "2026-06-01T10:00:00Z", opts.email)
}

async function writeHub(
  projects: unknown[],
  opts: { local?: Record<string, unknown> | null; root?: string } = {},
) {
  await write(
    "hub/registry.json",
    JSON.stringify({ registryVersion: 1, root: opts.root ?? "..", projects }, null, 2) + "\n",
  )
  if (opts.local !== null) {
    await write(
      "hub/registry.local.json",
      JSON.stringify(opts.local ?? { machineProfile: "corp", dirs: {} }, null, 2) + "\n",
    )
  }
  return path.join(dir, "hub", "registry.json")
}

async function manifestAt(manifestPath: string) {
  return loadFleetManifest(manifestPath)
}

/** Every directory named `needle` anywhere under `root`. */
async function findDirsNamed(root: string, needle: string): Promise<string[]> {
  const hits: string[] = []
  const walk = async (p: string) => {
    let entries
    try {
      entries = await fs.readdir(p, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const abs = path.join(p, e.name)
      if (e.name === needle) hits.push(abs)
      if (e.name !== ".git") await walk(abs)
    }
  }
  await walk(root)
  return hits
}

const personal = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  kind: "repo",
  profile: "personal",
  path: name,
  contract: {},
  ...extra,
})

const corp = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  kind: "repo",
  profile: "corp",
  private: true,
  ...extra,
})

describe("fleet loader — the registry shape", () => {
  it("resolves personal entries against root and corp entries via local dirs only", async () => {
    await initRepo("alpha")
    await initRepo("corp-zz-worktree")
    const manifestPath = await writeHub([personal("alpha"), corp("c-one")], {
      local: { machineProfile: "corp", dirs: { "c-one": path.join(dir, "corp-zz-worktree") } },
    })
    const manifest = await manifestAt(manifestPath)
    expect(manifest.shape).toBe("registry")
    expect(manifest.problems).toEqual([])
    expect(manifest.entries.find((e) => e.name === "alpha")?.resolvedRoot).toBe(
      path.join(dir, "alpha"),
    )
    expect(manifest.entries.find((e) => e.name === "c-one")?.resolvedRoot).toBe(
      path.join(dir, "corp-zz-worktree"),
    )
  })

  it("a corp entry with the local file absent is an explicit problem with a rebuild recipe", async () => {
    const manifestPath = await writeHub([corp("c-one")], { local: null })
    const manifest = await manifestAt(manifestPath)
    const entry = manifest.entries.find((e) => e.name === "c-one")
    expect(entry?.resolvedRoot).toBeUndefined()
    expect(entry?.unresolved).toContain("rebuild it beside the manifest")
    expect(manifest.problems.some((p) => p.kind === "local-missing")).toBe(true)
    expect(manifest.problems.find((p) => p.kind === "local-missing")?.detail).toContain(
      '"machineProfile"',
    )
  })

  it("PINNED: rejects a name that is not a single path-safe segment — a ../ name must never steer a write", async () => {
    // Names build finding ids and corp/<name>/ persistence paths; a traversal name aimed a
    // corp ledger write outside the corp zone before this guard existed.
    const manifestPath = await writeHub([
      corp("../evil-zone"),
      personal("has space"),
      personal(".hidden"),
      personal("colon:name"),
      personal("fine-name"),
    ])
    const manifest = await manifestAt(manifestPath)
    expect(manifest.entries.map((e) => e.name)).toEqual(["fine-name"])
    const details = manifest.problems.map((p) => p.detail).join("\n")
    expect(details).toContain('"../evil-zone"')
    expect(details).toContain("path-safe segment")
    // Belt-and-braces: even with a hostile name injected past the loader, the persistence
    // root refuses to resolve outside <manifestDir>/corp/.
    expect(() => corpPersistenceRoot(manifest, "../evil-zone")).toThrow(/escapes the corp/)
    expect(() => corpPersistenceRoot(manifest, "a/b")).toThrow(/escapes the corp/)
  })

  it("drops a non-string contract value as a problem instead of crashing the sweep", async () => {
    await initRepo("alpha")
    const manifestPath = await writeHub([
      personal("alpha", { contract: { state: 123, decisions: "DECISIONS.md" } }),
    ])
    const manifest = await manifestAt(manifestPath)
    expect(manifest.problems.some((p) => p.detail.includes("contract.state"))).toBe(true)
    expect(manifest.entries[0]?.contract).toEqual({ decisions: "DECISIONS.md" })
    // The sweep must survive the entry and disclose the manifest problem.
    const result = await sweepFleet(manifest, {})
    expect(result.problems.some((p) => p.includes("contract.state"))).toBe(true)
  })

  it('machineProfile "personal" resolves corp entries disclosed-absent, not as a problem', async () => {
    const manifestPath = await writeHub([corp("c-one")], {
      local: { machineProfile: "personal" },
    })
    const manifest = await manifestAt(manifestPath)
    expect(manifest.entries.find((e) => e.name === "c-one")?.unresolved).toContain(
      'machineProfile "personal"',
    )
    expect(manifest.problems).toEqual([])
    // And `fleet check` treats it as disclosed, never as a dangling mapping.
    const { findings, disclosures } = await checkManifest(manifest)
    expect(findings.filter((f) => f.id.includes("c-one"))).toEqual([])
    expect(disclosures.some((d) => d.includes("deliberately absent"))).toBe(true)
  })
})

describe("fleet sweep — pinned invariants", () => {
  it("PINNED: a sweep never creates .etymd anywhere, with and without --persist-ledgers", async () => {
    await initRepo("alpha", { stateAt: "2026-01-01T10:00:00Z" })
    await initRepo("beta")
    const manifestPath = await writeHub([personal("alpha"), personal("beta")])

    await sweepFleet(await manifestAt(manifestPath), {})
    expect(await findDirsNamed(dir, ".etymd")).toEqual([])

    await sweepFleet(await manifestAt(manifestPath), { persistLedgers: true })
    // Neither repo ever opted in — the flag persists into existing .etymd dirs, never creates.
    expect(await findDirsNamed(dir, ".etymd")).toEqual([])
  })

  it("persists a ledger only into a personal repo that already opted in", async () => {
    await initRepo("alpha")
    await fs.mkdir(path.join(dir, "alpha", ".etymd"), { recursive: true })
    const manifestPath = await writeHub([personal("alpha")])

    await sweepFleet(await manifestAt(manifestPath), {})
    expect(
      await fs.access(path.join(dir, "alpha", ".etymd", "ledger.json")).then(
        () => true,
        () => false,
      ),
    ).toBe(false)

    await sweepFleet(await manifestAt(manifestPath), { persistLedgers: true })
    const ledger = await readLedger(path.join(dir, "alpha"))
    expect(ledger.entries.length).toBeGreaterThan(0)
  })

  it("PINNED: corp persistence never writes in a corp worktree — even with an .etymd already there", async () => {
    await initRepo("corp-zz-worktree")
    // A stray pre-existing .etymd must not become a write license.
    await write(
      path.join("corp-zz-worktree", ".etymd", "ledger.json"),
      JSON.stringify({ version: 1, entries: [] }) + "\n",
    )
    const before = await fs.readFile(
      path.join(dir, "corp-zz-worktree", ".etymd", "ledger.json"),
      "utf8",
    )
    const manifestPath = await writeHub([corp("c-one")], {
      local: { machineProfile: "corp", dirs: { "c-one": path.join(dir, "corp-zz-worktree") } },
    })

    const result = await sweepFleet(await manifestAt(manifestPath), { persistLedgers: true })
    expect(result.projects[0]?.findings.length).toBeGreaterThan(0) // it WAS audited

    const etymdDir = path.join(dir, "corp-zz-worktree", ".etymd")
    expect(await fs.readdir(etymdDir)).toEqual(["ledger.json"]) // no cache/ appeared
    expect(await fs.readFile(path.join(etymdDir, "ledger.json"), "utf8")).toBe(before)
    // And the sweep itself persisted nothing manifest-side either (only dismiss/accept do).
    expect(
      await fs.access(path.join(dir, "hub", "corp")).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  })

  it("PINNED: corp dismiss writes only under <manifestDir>/corp/<name>/ and quiets the sweep", async () => {
    await initRepo("corp-zz-worktree")
    const manifestPath = await writeHub([corp("c-one")], {
      local: { machineProfile: "corp", dirs: { "c-one": path.join(dir, "corp-zz-worktree") } },
    })

    await fleetDismiss({
      cwd: path.join(dir, "hub"),
      manifest: manifestPath,
      name: "c-one",
      id: "instruction-truth/no-contract",
      reason: "fixture: contract lives beside the manifest",
    })

    const persistRoot = corpPersistenceRoot(await manifestAt(manifestPath), "c-one")
    expect(persistRoot).toBe(path.join(dir, "hub", "corp", "c-one"))
    const ledger = await readLedger(persistRoot)
    expect(ledger.entries.find((e) => e.id === "instruction-truth/no-contract")?.status).toBe(
      "dismissed",
    )
    // The worktree stayed untouched — no .etymd anywhere outside the manifest's corp zone.
    expect(await findDirsNamed(path.join(dir, "corp-zz-worktree"), ".etymd")).toEqual([])

    const swept = await sweepFleet(await manifestAt(manifestPath), {})
    expect(swept.projects[0]?.findings.some((f) => f.id === "instruction-truth/no-contract")).toBe(
      false,
    )
  })

  it("PINNED: partition invariant — a sweep leaves zero corp-resolved content under the manifest repo's tracked paths", async () => {
    await initRepo("corp-zz-worktree", { stateAt: "2026-01-01T10:00:00Z" })
    const manifestPath = await writeHub([corp("c-one")], {
      local: { machineProfile: "corp", dirs: { "c-one": path.join(dir, "corp-zz-worktree") } },
    })
    // The hub is a git repo tracking the manifest (the local file stays untracked, as designed).
    const hub = path.join(dir, "hub")
    await gitIn(dir, null, ["init", "-q", hub])
    await write("hub/.gitignore", "registry.local.json\ncorp/\n*.fleet.json\n")
    await gitIn(hub, null, ["add", ".gitignore", "registry.json"])
    await gitIn(hub, "2026-01-01T10:00:00Z", ["commit", "-q", "--no-verify", "-m", "hub"])

    await sweepFleet(await manifestAt(manifestPath), { persistLedgers: true })

    const { stdout: tracked } = await pExecFile("git", ["ls-files"], { cwd: hub })
    for (const file of tracked.split("\n").filter(Boolean)) {
      const content = await fs.readFile(path.join(hub, file), "utf8")
      expect(content).not.toContain("corp-zz-worktree") // no corp dir name
      expect(content).not.toContain(dir) // no machine-local resolved path
    }
    // No tracked file was modified or staged by the sweep.
    const { stdout: status } = await pExecFile("git", ["status", "--porcelain"], { cwd: hub })
    const dirty = status.split("\n").filter((l) => l && !l.startsWith("??"))
    expect(dirty).toEqual([])
    // And the hub gained NOTHING on disk — new untracked (possibly gitignored) paths are
    // exactly how a hostile manifest name would smuggle a write into the hub repo.
    expect((await fs.readdir(hub)).sort()).toEqual([
      ".git",
      ".gitignore",
      "registry.json",
      "registry.local.json",
    ])
  })
})

describe("fleet sweep — honesty and clocks", () => {
  it("discloses manifest problems and unresolved entries — never a silent default", async () => {
    const manifestPath = await writeHub([corp("c-one"), personal("ghost")], { local: null })
    const result = await sweepFleet(await manifestAt(manifestPath), {})
    expect(result.problems.some((p) => p.includes("rebuild it beside the manifest"))).toBe(true)
    expect(result.outOfScope).toContain("c-one")
    expect(result.outOfScope).toContain("ghost") // resolved path does not exist on disk
    const cOne = result.projects.find((p) => p.name === "c-one")
    expect(cOne?.disclosures.some((d) => d.includes("not audited"))).toBe(true)
  })

  it("honors a per-entry staleAfterDays override from the registry", async () => {
    await initRepo("alpha", { stateAt: "2026-01-01T10:00:00Z" }) // trails by ~151 days
    const manifestPath = await writeHub([personal("alpha", { staleAfterDays: 400 })])
    const result = await sweepFleet(await manifestAt(manifestPath), {})
    const project = result.projects[0]
    expect(project?.staleAfterDays).toBe(400)
    expect(project?.findings.some((f) => f.id.startsWith("state-freshness/stale-state"))).toBe(
      false,
    )
  })

  it("measures upstream entries on fork-authored commits only — a pure mirror is dormant, not stale", async () => {
    // Upstream: state in January, code in June. A clone's HEAD carries upstream's June traffic.
    await initRepo("upstream-src", { stateAt: "2026-01-01T10:00:00Z" })
    await pExecFile("git", ["clone", "-q", path.join(dir, "upstream-src"), path.join(dir, "fork")])

    // Without `upstream`, the full clock applies: the state trails by ~151 days => stale.
    const plainPath = await writeHub([personal("fork")])
    const plain = await sweepFleet(await manifestAt(plainPath), {})
    expect(
      plain.projects[0]?.findings.some((f) => f.id.startsWith("state-freshness/stale-state")),
    ).toBe(true)

    // With `upstream: origin`, every commit is reachable from the remote — the fork has not
    // moved, so its old state is current state: zero findings, and the clock is disclosed.
    const forkPath = await writeHub([personal("fork", { upstream: "origin" })])
    const forked = await sweepFleet(await manifestAt(forkPath), {})
    expect(
      forked.projects[0]?.findings.some((f) => f.id.startsWith("state-freshness/stale-state")),
    ).toBe(false)
    expect(forked.projects[0]?.disclosures.some((d) => d.includes("fork-authored"))).toBe(true)
  })

  it("falls back to the full clock with a disclosure when the upstream remote is absent", async () => {
    await initRepo("alpha", { stateAt: "2026-01-01T10:00:00Z" })
    const manifestPath = await writeHub([personal("alpha", { upstream: "origin" })])
    const result = await sweepFleet(await manifestAt(manifestPath), {})
    expect(result.projects[0]?.disclosures.some((d) => d.includes("not found"))).toBe(true)
    expect(
      result.projects[0]?.findings.some((f) => f.id.startsWith("state-freshness/stale-state")),
    ).toBe(true)
  })

  it("a configured-but-never-fetched upstream remote gets the full clock, disclosed truthfully", async () => {
    // `--not --remotes=<name>` excludes nothing when the remote has zero fetched refs — the
    // disclosure must name the clock actually applied, not the one that was asked for.
    await initRepo("alpha", { stateAt: "2026-01-01T10:00:00Z" })
    await gitIn(path.join(dir, "alpha"), null, [
      "remote",
      "add",
      "origin",
      "https://zz-fixture-host.example/alpha.git",
    ])
    const manifestPath = await writeHub([personal("alpha", { upstream: "origin" })])
    const result = await sweepFleet(await manifestAt(manifestPath), {})
    expect(result.projects[0]?.disclosures.some((d) => d.includes("no fetched refs"))).toBe(true)
    expect(result.projects[0]?.disclosures.some((d) => d.includes("fork-authored"))).toBe(false)
    expect(
      result.projects[0]?.findings.some((f) => f.id.startsWith("state-freshness/stale-state")),
    ).toBe(true)
  })

  it("a foreign-schema last.fleet.json resets the delta baseline with a disclosure — never a crash", async () => {
    await initRepo("alpha")
    const manifestPath = await writeHub([personal("alpha")])
    await write("hub/last.fleet.json", "{}\n") // valid JSON, wrong shape (e.g. an older tool)
    const chunks: string[] = []
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((s: string | Uint8Array): boolean => {
        chunks.push(String(s))
        return true
      })
    try {
      await sweepCmd({ cwd: path.join(dir, "hub"), manifest: manifestPath, json: true })
    } finally {
      spy.mockRestore()
    }
    const parsed = JSON.parse(chunks.join("")) as Record<string, unknown>
    expect(parsed.delta).toBeNull() // baseline reset — reads as a first sweep
    expect(String(parsed.deltaBaselineNote)).toContain("foreign schema")
    // The sweep replaced the foreign file with a valid baseline (atomically).
    const last = JSON.parse(
      await fs.readFile(path.join(dir, "hub", "last.fleet.json"), "utf8"),
    ) as Record<string, unknown>
    expect(last.schema).toBe(FLEET_JSON_SCHEMA)
  })

  it("rejects an unknown --fail-on tier loudly — a typo must not disarm the gate", () => {
    expect(() => parseFailOnTier("critical")).toThrow(/risk\|gap\|polish/)
    expect(parseFailOnTier("risk")).toBe("risk")
  })

  it("prints the experimental machine schema under --json", async () => {
    await initRepo("alpha")
    const manifestPath = await writeHub([personal("alpha")])
    const chunks: string[] = []
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((s: string | Uint8Array): boolean => {
        chunks.push(String(s))
        return true
      })
    try {
      await sweepCmd({ cwd: path.join(dir, "hub"), manifest: manifestPath, json: true })
    } finally {
      spy.mockRestore()
    }
    const parsed = JSON.parse(chunks.join("")) as Record<string, unknown>
    expect(parsed.schema).toBe(FLEET_JSON_SCHEMA)
    expect(Array.isArray(parsed.projects)).toBe(true)
    const project = (parsed.projects as Record<string, unknown>[])[0]
    expect(project?.name).toBe("alpha")
    expect(project?.counts).toBeDefined()
    expect(Array.isArray(parsed.wall)).toBe(true)
    expect(parsed.delta).toBeNull() // first sweep — no baseline yet
    // The sweep stored its delta baseline beside the manifest for the next run.
    const last = JSON.parse(
      await fs.readFile(path.join(dir, "hub", "last.fleet.json"), "utf8"),
    ) as Record<string, unknown>
    expect(last.schema).toBe(FLEET_JSON_SCHEMA)
  })
})

describe("fleet check — manifest truth", () => {
  it("catches a dangling local dir, a duplicate name, a private path leak, and a machine path", async () => {
    await initRepo("alpha")
    await write(
      "hub/registry.json",
      JSON.stringify({
        registryVersion: 1,
        root: "..",
        projects: [
          personal("alpha"),
          personal("alpha"), // duplicate
          corp("c-one"), // dangling local dir below
          corp("c-two", { path: "secret-dir" }), // a private entry carrying a path = leak
          personal("mach", { path: "/Users/someone/projects/mach" }), // machine path
        ],
      }) + "\n",
    )
    await write(
      "hub/registry.local.json",
      JSON.stringify({
        machineProfile: "corp",
        dirs: { "c-one": path.join(dir, "no-such-dir"), "zz-ghost": path.join(dir, "alpha") },
      }) + "\n",
    )
    const manifest = await manifestAt(path.join(dir, "hub", "registry.json"))
    const { findings } = await checkManifest(manifest)
    const ids = findings.map((f) => f.id)
    expect(ids).toContain("fleet-manifest/duplicate-name:alpha")
    expect(ids).toContain("fleet-manifest/dangling-dir:c-one")
    expect(ids).toContain("fleet-manifest/private-path-leak:c-two")
    expect(ids).toContain("fleet-manifest/registry-machine-path:registry.json")
    expect(ids).toContain("fleet-manifest/orphan-dir:zz-ghost")
    expect(findings.find((f) => f.id.includes("private-path-leak"))?.tier).toBe("risk")
    expect(findings.find((f) => f.id.includes("registry-machine-path"))?.tier).toBe("risk")
  })

  it("catches a dangling personal path (the ghost-entry class) and a dead link target", async () => {
    const manifestPath = await writeHub([
      personal("ghost"),
      personal("linker", { links: { "guided-by": "nobody" } }),
    ])
    await initRepo("linker")
    const { findings } = await checkManifest(await manifestAt(manifestPath))
    const ids = findings.map((f) => f.id)
    expect(ids).toContain("fleet-manifest/dangling-path:ghost")
    expect(ids).toContain("fleet-manifest/dangling-link:linker:nobody")
  })

  it("reports a parse error as a finding instead of defaulting", async () => {
    await write("hub/registry.json", "{ not json")
    const manifest = await manifestAt(path.join(dir, "hub", "registry.json"))
    const { findings } = await checkManifest(manifest)
    expect(findings.some((f) => f.id === "fleet-manifest/parse-error:registry.json")).toBe(true)
    expect(findings.find((f) => f.id.includes("parse-error"))?.tier).toBe("risk")
  })
})

describe("fleet wall findings", () => {
  it("flags a corp worktree carrying PROJECT_CONTEXT.md or DECISIONS.md at its root", async () => {
    await initRepo("corp-zz-worktree", { stateAt: "2026-01-01T10:00:00Z" })
    const manifestPath = await writeHub([corp("c-one")], {
      local: { machineProfile: "corp", dirs: { "c-one": path.join(dir, "corp-zz-worktree") } },
    })
    const { findings } = await collectWallFindings(await manifestAt(manifestPath))
    const hit = findings.find(
      (f) => f.id === "fleet-manifest/corp-artifact-in-repo:c-one:PROJECT_CONTEXT.md",
    )
    expect(hit).toBeDefined()
    expect(hit?.tier).toBe("risk")
  })

  it("flags an unregistered directory under the fleet root with a corp remote; skips disclosed without corpHosts", async () => {
    await initRepo("alpha")
    await initRepo("rogue")
    await gitIn(path.join(dir, "rogue"), null, [
      "remote",
      "add",
      "origin",
      "https://git.zz-fixture-corp.example/rogue.git",
    ])
    const manifestPath = await writeHub([personal("alpha")], {
      root: dir,
      local: { machineProfile: "corp", corpHosts: ["git.zz-fixture-corp.example"] },
    })
    const withHosts = await collectWallFindings(await manifestAt(manifestPath))
    expect(
      withHosts.findings.some((f) => f.id === "fleet-manifest/unregistered-corp-remote:rogue"),
    ).toBe(true)
    expect(withHosts.findings.some((f) => f.id.includes("unregistered-corp-remote:alpha"))).toBe(
      false,
    )

    const bare = await writeHub([personal("alpha")], {
      root: dir,
      local: { machineProfile: "corp" },
    })
    const withoutHosts = await collectWallFindings(await manifestAt(bare))
    expect(withoutHosts.findings.some((f) => f.id.includes("unregistered-corp-remote"))).toBe(false)
    expect(withoutHosts.disclosures.some((d) => d.includes("Coverage check skipped"))).toBe(true)
  })

  it("flags a tracked /Users/ path in the manifest's own repo — but never prose ABOUT the ban", async () => {
    const manifestPath = await writeHub([])
    const hub = path.join(dir, "hub")
    await gitIn(dir, null, ["init", "-q", hub])
    await write("hub/.gitignore", "registry.local.json\n")
    await write("hub/notes.md", "scratch: /Users/someone/projects/x carried a stale path\n")
    // Rule prose: an ellipsis stand-in and a bare mention must NOT fire — a convention
    // documenting the machine-path ban would otherwise flag itself forever.
    await write(
      "hub/rules.md",
      "Absolute `/Users/…` paths are banned in tracked files.\nBare /Users/ mentions like this one are prose.\n",
    )
    await gitIn(hub, null, ["add", "-A"])
    await gitIn(hub, "2026-01-01T10:00:00Z", ["commit", "-q", "--no-verify", "-m", "hub"])
    const { findings } = await collectWallFindings(await manifestAt(manifestPath))
    const hit = findings.find((f) => f.id === "fleet-manifest/machine-path:notes.md")
    expect(hit).toBeDefined()
    expect(hit?.tier).toBe("risk")
    expect(findings.some((f) => f.id === "fleet-manifest/machine-path:rules.md")).toBe(false)
  })

  it("flags a public-repo entry whose tracked files carry a private needle — needle out of id and claim", async () => {
    await gitIn(dir, null, ["init", "-q", path.join(dir, "beta")])
    await write("beta/notes.md", "deploy notes for zz-needle-dir\n")
    await commitAllIn("beta", "notes", "2026-01-01T10:00:00Z")
    const manifestPath = await writeHub([personal("beta", { trust: "public-repo" })], {
      local: { machineProfile: "corp", labels: { "c-one": "zz-needle-dir" } },
    })
    const { findings } = await collectWallFindings(await manifestAt(manifestPath))
    const hit = findings.find((f) => f.id === "fleet-manifest/hygiene-needle:beta:notes.md")
    expect(hit).toBeDefined()
    expect(hit?.tier).toBe("risk")
    expect(hit?.claim).not.toContain("zz-needle-dir") // the finding must not itself leak
    expect(hit?.evidence.join(" ")).toContain("zz-needle-dir") // local evidence names it
  })

  it("flags recent corp-host-domain commit emails on a personal entry", async () => {
    await gitIn(dir, null, ["init", "-q", path.join(dir, "gamma")])
    await write("gamma/src.txt", "code\n")
    await commitAllIn("gamma", "code", "2026-06-01T10:00:00Z", "dev@zz-fixture-corp.example")
    const manifestPath = await writeHub([personal("gamma")], {
      local: { machineProfile: "corp", corpHosts: ["git.zz-fixture-corp.example"] },
    })
    const { findings } = await collectWallFindings(await manifestAt(manifestPath))
    const hit = findings.find((f) => f.id === "fleet-manifest/corp-email:gamma")
    expect(hit).toBeDefined()
    expect(hit?.tier).toBe("risk")
    expect(hit?.evidence.join(" ")).toContain("dev@zz-fixture-corp.example")
  })

  it("matches email domains against corp hosts at label boundaries only", () => {
    const hosts = ["git.zz-fixture-corp.example"]
    expect(emailMatchesCorpHosts("a@git.zz-fixture-corp.example", hosts)).toBe(true)
    expect(emailMatchesCorpHosts("a@zz-fixture-corp.example", hosts)).toBe(true)
    expect(emailMatchesCorpHosts("a@example", hosts)).toBe(false)
    expect(emailMatchesCorpHosts("a@other.example", hosts)).toBe(false)
    expect(emailMatchesCorpHosts("a@sub.git.zz-fixture-corp.example", hosts)).toBe(true)
  })

  it("climbs at most one label above the host — a generic parent domain is never a corp identity", () => {
    // A corp host on a hosted/multi-label domain must not flag every commit from the generic
    // parent (git.corp.example.com ↛ @example.com).
    const deep = ["git.corp.zz-generic.example"]
    expect(emailMatchesCorpHosts("a@corp.zz-generic.example", deep)).toBe(true) // one label up
    expect(emailMatchesCorpHosts("a@zz-generic.example", deep)).toBe(false) // two labels up
  })
})

// The built CLI (skipped when dist/ is absent; `npm ci` builds it via `prepare`, so CI has it).
const CLI = path.resolve(import.meta.dirname, "..", "dist", "cli.js")

describe.skipIf(!existsSync(CLI))("fleet CLI wiring (built binary)", () => {
  it("binds --manifest and --json placed after a subcommand — the parent/child flag-shadowing regression", async () => {
    // The parent `fleet` command declares the same flags; commander binds a post-subcommand
    // flag onto the parent, so the subcommand must read merged options. Run from a cwd WITHOUT
    // a registry.json: if the binding regresses, check errors out asking for --manifest.
    await initRepo("alpha")
    const manifestPath = await writeHub([personal("alpha")])
    const { stdout } = await pExecFile(
      "node",
      [CLI, "fleet", "check", "--json", "--manifest", manifestPath],
      { cwd: dir },
    )
    const parsed = JSON.parse(stdout) as Record<string, unknown>
    expect(parsed.schema).toBe(FLEET_JSON_SCHEMA)
    expect(parsed.findings).toEqual([])
  })
})

describe("recurringClasses", () => {
  const sweep = (name: string, ids: [string, "risk" | "gap" | "polish"][]) =>
    ({
      name,
      profile: "personal" as const,
      staleAfterDays: 30,
      stateAgeDays: null,
      counts: { risk: 0, gap: 0, polish: 0 },
      findings: ids.map(([id, tier]) => ({
        id,
        lens: id.split("/")[0] ?? id,
        tier,
        claim: "c",
        evidence: [],
        why: "w",
        effort: "S" as const,
        confidence: "high" as const,
      })),
      disclosures: [],
    }) satisfies FleetProjectSweep

  it("groups by the engine-minted class prefix and keeps only classes open in ≥2 projects", () => {
    const rc = recurringClasses([
      sweep("alpha", [
        ["context-economy/heavy-file:AGENTS.md", "gap"],
        ["instruction-truth/stale-path:AGENTS.md:src/x", "gap"],
      ]),
      sweep("beta", [["context-economy/heavy-file:AGENTS.md", "gap"]]),
      sweep("gamma", [
        ["context-economy/heavy-file:README.md", "risk"],
        ["gate-integrity/hooks-not-wired", "risk"],
      ]),
    ])
    // heavy-file spans 3 projects (different files — same CLASS); stale-path and
    // hooks-not-wired are single-project and must not appear.
    expect(rc).toHaveLength(1)
    expect(rc[0]?.classId).toBe("context-economy/heavy-file")
    expect(rc[0]?.projects).toEqual(["alpha", "beta", "gamma"])
    // The class inherits its worst open tier across the fleet.
    expect(rc[0]?.tier).toBe("risk")
  })

  it("a class in one project only is a repo problem, not a fleet lesson — empty result", () => {
    const rc = recurringClasses([
      sweep("alpha", [["context-economy/heavy-file:AGENTS.md", "gap"]]),
      sweep("beta", [["gate-integrity/ci-only-typecheck", "gap"]]),
    ])
    expect(rc).toEqual([])
  })
})
