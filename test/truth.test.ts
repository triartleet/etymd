import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { scanProject } from "../src/core/scan.js"
import { git } from "../src/core/util.js"
import {
  extractCommandClaims,
  extractDocRefs,
  extractPathClaims,
} from "../src/lenses/instruction-truth/claims.js"
import { instructionTruthLens } from "../src/lenses/instruction-truth/lens.js"
import { contextEconomyLens, TOTAL_BUDGET_WORDS } from "../src/lenses/context-economy.js"
import type { LensContext } from "../src/engine/finding.js"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-truth-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function write(rel: string, contents: string) {
  const abs = path.join(dir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, contents, "utf8")
}

async function runTruth(): Promise<ReturnType<typeof instructionTruthLens.run>> {
  const facts = await scanProject(dir)
  const ctx: LensContext = { root: dir, facts, profile: "solo", baseline: null }
  return instructionTruthLens.run(ctx)
}

describe("claim extraction", () => {
  it("extracts script claims from pm invocations, skipping builtins and flagged calls", () => {
    const { scripts, filteredSkipped } = extractCommandClaims(
      [
        "Run `pnpm dev` then `pnpm install` and `npm run build`.",
        "```bash",
        "yarn test:unit",
        "pnpm --filter @x/api test",
        "```",
      ].join("\n"),
    )
    expect([...scripts.keys()].sort()).toEqual(["build", "dev", "test:unit"])
    expect(filteredSkipped).toBe(1)
  })

  it("treats `npm test` as a script claim but bare `npm foo` as nothing", () => {
    const { scripts } = extractCommandClaims("`npm test` and `npm foo`")
    expect([...scripts.keys()]).toEqual(["test"])
  })

  it("ignores pm names mentioned mid-phrase (prose, not instructions)", () => {
    const { scripts } = extractCommandClaims(
      "```sh\nfor t in pnpm node psql curl; do echo $t; done\n```",
    )
    expect([...scripts.keys()]).toEqual([])
  })

  it("extracts conservative path claims only", () => {
    const { paths } = extractPathClaims(
      [
        "See `src/core/detect.ts` and `docs/design/` for details.",
        "Routes live at `/admin/batches` and `~/home` and `@scope/pkg`.",
        "Globs like `src/**/*.ts` and urls `https://x.dev/a/b` and `$VAR/x` are skipped.",
        "Route params `p/$slug` are skipped.",
        // Dotted prose is not a file claim: dotted hook notation from corpus prose.
        "Hooks fire on `create/update.after` once an address is proven.",
        "Unrecognized extensions like `pkg/mod.xyz9` stay prose.",
      ].join("\n"),
    )
    expect(paths.sort()).toEqual(["docs/design", "src/core/detect.ts"])
  })

  it("treats create-this paths as prospective, not claims (the forked-repo skill class)", () => {
    const { paths, prospective } = extractPathClaims(
      [
        "Create `migrations/quarantine/` before starting the move.",
        "The build writes to `dist/report.json` on every run.",
        "Files this step generates:",
        "- `docs/generated/api.md`",
        "- `docs/generated/cli.md`",
        "The engine lives in `src/engine/run.ts`.",
      ].join("\n"),
    )
    expect(prospective.sort()).toEqual([
      "dist/report.json",
      "docs/generated/api.md",
      "docs/generated/cli.md",
      "migrations/quarantine",
    ])
    expect(paths).toEqual(["src/engine/run.ts"])
  })

  it("still verifies a path that is also referenced outside create-this prose", () => {
    const { paths, prospective } = extractPathClaims(
      ["Create `src/gen/out.ts` first.", "Then read `src/gen/out.ts` to check the result."].join(
        "\n",
      ),
    )
    // One plain reference makes it a live claim — a stale path must not hide behind one mention.
    expect(paths).toEqual(["src/gen/out.ts"])
    expect(prospective).toEqual([])
  })

  it("treats naming stand-ins as placeholders, never claims", () => {
    const { paths, placeholder } = extractPathClaims(
      "Add `.claude/skills/my-custom-skill/SKILL.md` alongside `.claude/skills/deploy/SKILL.md`.",
    )
    expect(placeholder).toEqual([".claude/skills/my-custom-skill/SKILL.md"])
    expect(paths).toEqual([".claude/skills/deploy/SKILL.md"])
  })

  it("keeps every backticked span as a claim for instruction files — a prose introducer is not a namespace", () => {
    // Corpus find: `facts: `docs/seo-strategy.md`` in a committed skill file — the label reads
    // as prose, and only the task surface (opts.namespaces) reads prefixes at all.
    const text = "Two facts: `docs/seo-strategy.md` locks the cadence; see pc: `docs/other.md` too."
    const plain = extractPathClaims(text)
    expect(plain.paths).toEqual(["docs/seo-strategy.md", "docs/other.md"])
    expect(plain.namespaced).toEqual([])
    const task = extractPathClaims(text, { namespaces: true })
    expect(task.namespaced).toEqual(["docs/other.md"])
    expect(task.paths).toEqual(["docs/seo-strategy.md"])
  })
})

describe("doc-ref extraction (home paths are not repo paths)", () => {
  it("a `~/` home-path mention is not a repo doc reference", () => {
    const { refs, tildeSkipped } = extractDocRefs(
      "Global rules in `~/.claude/CLAUDE.md` apply on top of this file.",
    )
    expect(refs).toEqual([])
    expect(tildeSkipped).toBe(1)
  })

  it("one ordinary occurrence still makes the doc a live claim", () => {
    const { refs, tildeSkipped } = extractDocRefs(
      "Global rules in `~/.claude/CLAUDE.md` apply on top; for this repo see CLAUDE.md.",
    )
    expect(refs).toEqual(["CLAUDE.md"])
    expect(tildeSkipped).toBe(1)
  })

  it("an unadorned mention is a claim, as before", () => {
    const { refs } = extractDocRefs("State is tracked in PROJECT_CONTEXT.md.")
    expect(refs).toEqual(["PROJECT_CONTEXT.md"])
  })

  it("a mention whose point is the doc's deliberate absence is not a dangling claim", () => {
    // The observed defect: a repo that dropped its CLAUDE.md pointer and wrote down why stood
    // accused of a dangling ref until it worded around the very filename its convention was
    // about. Both absence shapes on one line — the "no X" prefix and create-this prose.
    const { refs, absenceSkipped } = extractDocRefs(
      "There is no `CLAUDE.md` here on purpose: creating a `CLAUDE.md` would reintroduce two-file drift.",
    )
    expect(refs).toEqual([])
    expect(absenceSkipped).toBe(2)
  })

  it("an explicit absence statement alone also skips", () => {
    const { refs, absenceSkipped } = extractDocRefs(
      "`DECISIONS.md` does not exist in this repo — decisions are recorded upstream.",
    )
    expect(refs).toEqual([])
    expect(absenceSkipped).toBe(1)
  })

  it("a true stale pointer still flags: the skip needs absence prose on the mention's line", () => {
    const { refs, absenceSkipped } = extractDocRefs("See `CLAUDE.md` for details.")
    expect(refs).toEqual(["CLAUDE.md"])
    expect(absenceSkipped).toBe(0)
  })

  it("one plain mention on its own line still claims the doc beside an absence note", () => {
    // Same line granularity as the path scanner: the context is the mention's line, so the
    // absence prose must sit on the mention itself, not somewhere else in the file.
    const { refs, absenceSkipped } = extractDocRefs(
      "Creating a `CLAUDE.md` is forbidden.\n\nHistorically CLAUDE.md held the same rules.",
    )
    expect(refs).toEqual(["CLAUDE.md"])
    expect(absenceSkipped).toBe(1)
  })
})

describe("instruction-truth lens (the lying-AGENTS.md fixture)", () => {
  async function writeLyingFixture() {
    await write(
      "package.json",
      JSON.stringify({
        name: "liar",
        scripts: { "dev:web": "vite", test: "vitest run" },
      }),
    )
    await write("pnpm-lock.yaml", "")
    // node_modules is installed: unknown commands are checkable (script or binary — neither).
    await write("node_modules/.bin/.keep", "")
    await write("src/real.ts", "export {}\n")
    await write(
      "AGENTS.md",
      [
        "# AGENTS.md",
        "Run `pnpm dev` to start.", // stale command (renamed dev:web)
        "The engine lives in `src/legacy/engine.ts`.", // stale path
        "Also see `src/real.ts`.", // true path
        "Use `yarn build:all` and `yarn deploy:prod` here.", // pm conflict (repo is pnpm)
        "State is tracked in PROJECT_CONTEXT.md.", // dangling doc ref
      ].join("\n\n"),
    )
  }

  it("reports each lie class with evidence, and nothing for true claims", async () => {
    await writeLyingFixture()
    const report = await runTruth()
    const ids = report.findings.map((f) => f.id)

    expect(ids).toContain("instruction-truth/stale-command:AGENTS.md:dev")
    expect(ids).toContain("instruction-truth/stale-path:AGENTS.md:src/legacy/engine.ts")
    expect(ids).toContain("instruction-truth/pm-conflict:AGENTS.md")
    expect(ids).toContain("instruction-truth/dangling-ref:AGENTS.md:PROJECT_CONTEXT.md")

    // True claims must not be flagged.
    expect(ids.filter((i) => i.includes("src/real.ts"))).toEqual([])
    // A stale command is the top severity: an agent will RUN it.
    const cmd = report.findings.find((f) => f.id.includes("stale-command"))
    expect(cmd?.tier).toBe("risk")
    // No baseline → disclosed, not silently skipped.
    expect(report.disclosures.some((d) => d.includes("baseline"))).toBe(true)
  })

  it("a truthful file produces no findings", async () => {
    await write(
      "package.json",
      JSON.stringify({ name: "honest", scripts: { dev: "vite", test: "vitest run" } }),
    )
    await write("pnpm-lock.yaml", "")
    await write("src/index.ts", "export {}\n")
    await write(
      "AGENTS.md",
      "# AGENTS.md\n\nRun `pnpm dev`. Tests: `pnpm test`. Code in `src/index.ts`.\n",
    )
    const report = await runTruth()
    expect(report.findings).toEqual([])
  })

  it("reports a missing contract when no instruction files exist", async () => {
    await write("package.json", JSON.stringify({ name: "bare" }))
    const report = await runTruth()
    expect(report.findings.map((f) => f.id)).toContain("instruction-truth/no-contract")
  })

  it("a tilde-home doc mention is skipped and disclosed, never a dangling ref", async () => {
    // The observed defect: prose pointing at the reader's machine accused the repo of a missing
    // file. The home file is real; the repo never had one — nothing to verify here.
    await write("package.json", JSON.stringify({ name: "homedoc", private: true }))
    await write(
      "AGENTS.md",
      "# AGENTS.md\n\nGlobal rules in `~/.claude/CLAUDE.md` apply on top of this file.\n",
    )
    const report = await runTruth()
    expect(report.findings.filter((f) => f.id.includes("dangling-ref"))).toEqual([])
    expect(report.disclosures.some((d) => d.includes("`~/` home paths"))).toBe(true)
  })

  it("a deliberate-absence note is not a dangling ref; a plain pointer still is", async () => {
    // The extensions case: naming the file your convention is ABOUT ("creating a CLAUDE.md
    // would reintroduce drift") must not read as pointing agents at it. The skip is disclosed,
    // and a genuine stale pointer in the same fixture still flags.
    await write("package.json", JSON.stringify({ name: "absentdoc", private: true }))
    await write(
      "AGENTS.md",
      "# AGENTS.md\n\nThere is no CLAUDE.md here: creating a `CLAUDE.md` would reintroduce two-file drift.\n",
    )
    const clean = await runTruth()
    expect(clean.findings.filter((f) => f.id.includes("dangling-ref"))).toEqual([])
    expect(clean.disclosures.some((d) => d.includes("deliberately does not exist"))).toBe(true)

    await write("AGENTS.md", "# AGENTS.md\n\nSee `CLAUDE.md` for details.\n")
    const flagged = await runTruth()
    expect(flagged.findings.map((f) => f.id)).toContain(
      "instruction-truth/dangling-ref:AGENTS.md:CLAUDE.md",
    )
  })

  it("resolves workspace scripts and package-relative paths in a monorepo (no false lies)", async () => {
    await write("package.json", JSON.stringify({ name: "mono", private: true }))
    await write("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n")
    await write("pnpm-lock.yaml", "")
    await write(
      "apps/api/package.json",
      JSON.stringify({ name: "@mono/api", scripts: { "db:generate": "drizzle-kit" } }),
    )
    await write("apps/api/src/db/schema.ts", "export {}\n")
    await write(
      "AGENTS.md",
      "# AGENTS.md\n\nAfter editing the schema run `pnpm db:generate`. The schema lives in `db/schema.ts`.\n",
    )
    const report = await runTruth()
    // Both claims resolve in the workspace — flagging them would be the false-positive class
    // a live run on a pnpm workspace exposed.
    expect(report.findings).toEqual([])
  })

  it("treats an installed .bin binary as a true command, not a stale script", async () => {
    await write("package.json", JSON.stringify({ name: "nxish", scripts: { build: "nx build" } }))
    await write("pnpm-lock.yaml", "")
    await write("node_modules/.bin/nx", "#!/bin/sh\n")
    await write("AGENTS.md", "# AGENTS.md\n\nInspect the graph with `pnpm nx graph`.\n")
    const report = await runTruth()
    expect(report.findings.map((f) => f.id)).toEqual([])
    expect(report.disclosures.some((d) => d.includes("installed binaries"))).toBe(true)
  })

  it("skips (does not flag) unknown commands when node_modules is absent", async () => {
    await write("package.json", JSON.stringify({ name: "uninstalled", scripts: { test: "jest" } }))
    await write("pnpm-lock.yaml", "")
    await write("AGENTS.md", "# AGENTS.md\n\nRun `pnpm nx build` for the app.\n")
    const report = await runTruth()
    // `nx` might be an uninstalled binary — we cannot know, so we must not accuse.
    expect(report.findings.map((f) => f.id)).toEqual([])
    expect(report.disclosures.some((d) => d.includes("node_modules is not installed"))).toBe(true)
  })

  it("skips gitignored path claims (machine-local) instead of accusing them", async () => {
    await write("package.json", JSON.stringify({ name: "envy", scripts: {} }))
    await write("pnpm-lock.yaml", "")
    await write("node_modules/.bin/.keep", "")
    await write(".gitignore", "apps/api/.env\n")
    await write(
      "AGENTS.md",
      "# AGENTS.md\n\nNeeds `apps/api/.env` locally. Helpers in `apps/api/gone.ts`.\n",
    )
    await git(dir, ["init"])
    const report = await runTruth()
    const ids = report.findings.map((f) => f.id)
    // The corpus case: a skill honestly says a gitignored file is "present on this machine" —
    // its absence in a fresh checkout is not a lie.
    expect(ids).not.toContain("instruction-truth/stale-path:AGENTS.md:apps/api/.env")
    expect(ids).toContain("instruction-truth/stale-path:AGENTS.md:apps/api/gone.ts")
    expect(report.disclosures.some((d) => d.includes("gitignored"))).toBe(true)
  })

  it("skips a dir-only gitignore pattern even when the directory does not exist", async () => {
    // check-ignore matches a trailing-slash pattern only against an EXISTING directory, so
    // fresh checkouts lost the gitignored skip until the slash-terminated probe was added.
    await write("package.json", JSON.stringify({ name: "cardgen", scripts: {} }))
    await write("pnpm-lock.yaml", "")
    await write("node_modules/.bin/.keep", "")
    await write(".gitignore", "assets/cards/\n")
    await write(
      "AGENTS.md",
      "# AGENTS.md\n\nLocal decks sit in `assets/cards/` on this machine.\nSource art lives in `assets/gone.ts`.\n",
    )
    await git(dir, ["init"])
    const report = await runTruth()
    const ids = report.findings.map((f) => f.id)
    expect(ids).not.toContain("instruction-truth/stale-path:AGENTS.md:assets/cards")
    expect(ids).toContain("instruction-truth/stale-path:AGENTS.md:assets/gone.ts")
    expect(report.disclosures.some((d) => d.includes("gitignored"))).toBe(true)
  })

  it("does not accuse a path the file tells the agent to create", async () => {
    await write("package.json", JSON.stringify({ name: "prospective", scripts: {} }))
    await write("pnpm-lock.yaml", "")
    await write("node_modules/.bin/.keep", "")
    await write(
      ".claude/skills/migrate/SKILL.md",
      [
        "# Migrate",
        "Create `migrations/quarantine/` and move the legacy files there.",
        "Scaffold your own step at `.claude/skills/my-custom-skill/SKILL.md`.",
        "The rollback notes live in `docs/rollback.md`.",
      ].join("\n\n"),
    )
    const report = await runTruth()
    const ids = report.findings.map((f) => f.id)
    // Neither the dir the skill creates nor the naming stand-in is a stale reference…
    expect(ids).not.toContain(
      "instruction-truth/stale-path:.claude/skills/migrate/SKILL.md:migrations/quarantine",
    )
    expect(ids.some((i) => i.includes("my-custom-skill"))).toBe(false)
    // …but a plain missing reference in the same file still is.
    expect(ids).toContain(
      "instruction-truth/stale-path:.claude/skills/migrate/SKILL.md:docs/rollback.md",
    )
    expect(report.disclosures.some((d) => d.includes("create-this prose"))).toBe(true)
    expect(report.disclosures.some((d) => d.includes("naming stand-ins"))).toBe(true)
  })

  it("covers cursor rules and skills files too", async () => {
    await write("package.json", JSON.stringify({ name: "multi", scripts: {} }))
    await write("pnpm-lock.yaml", "")
    await write("node_modules/.bin/.keep", "")
    await write(".cursor/rules/build.mdc", "Run `pnpm compile` before review.\n")
    await write(".claude/skills/deploy/SKILL.md", "See `scripts/deploy.sh` for the steps.\n")
    const report = await runTruth()
    const ids = report.findings.map((f) => f.id)
    expect(ids).toContain("instruction-truth/stale-command:.cursor/rules/build.mdc:compile")
    expect(ids).toContain(
      "instruction-truth/stale-path:.claude/skills/deploy/SKILL.md:scripts/deploy.sh",
    )
  })
})

describe("state-document truth (the lying-state-doc fixture)", () => {
  it("flags a state doc's dead command, dead path, and dead decision reference", async () => {
    await write("package.json", JSON.stringify({ name: "stateful", scripts: { lint: "eslint ." } }))
    await write("pnpm-lock.yaml", "")
    await write("node_modules/.bin/.keep", "")
    await write("src/real.ts", "export {}\n")
    await write("AGENTS.md", "# AGENTS.md\n\nRun `pnpm lint` before finishing.\n")
    await write(
      "DECISIONS.md",
      "# Decisions\n\n## D-001 — first\n\nScope: repo.\n\n## D-002 — second\n\nScope: repo.\n",
    )
    await write(
      "PROJECT_CONTEXT.md",
      [
        "# State",
        "Pre-push runs `pnpm verify:all` and blocks on failure.", // no such script
        "The engine lives in `src/engine/core.ts`.", // no such path
        "Also see `src/real.ts`.", // true path
        "Latest ruling: D-014 locked the approach.", // record stops at D-002
        "Superseded by D-002 later.", // resolves — no finding
      ].join("\n\n"),
    )
    const report = await runTruth()
    const ids = report.findings.map((f) => f.id)
    expect(ids).toContain("instruction-truth/stale-command:PROJECT_CONTEXT.md:verify:all")
    expect(ids).toContain("instruction-truth/stale-path:PROJECT_CONTEXT.md:src/engine/core.ts")
    expect(ids).toContain("instruction-truth/dead-decision-ref:PROJECT_CONTEXT.md:D-014")
    expect(ids.filter((i) => i.includes("src/real.ts"))).toEqual([])
    expect(ids.filter((i) => i.includes("D-002"))).toEqual([])
    expect(report.findings.find((f) => f.id.includes("dead-decision-ref"))?.tier).toBe("gap")
    expect(report.disclosures.some((d) => /Checked 1 state document/.test(d))).toBe(true)
  })

  it("flags a script claim in a repo with no package manifest at all (nothing could satisfy it)", async () => {
    await write("AGENTS.md", "# AGENTS.md\n\nDocs-only repo.\n")
    await write(
      "PROJECT_CONTEXT.md",
      "# State\n\n`git push` runs `npm run lint` and blocks on failure.\n",
    )
    const report = await runTruth()
    expect(report.findings.map((f) => f.id)).toContain(
      "instruction-truth/stale-command:PROJECT_CONTEXT.md:lint",
    )
  })

  it("skips decision refs that name another record, and discloses the skip", async () => {
    await write("AGENTS.md", "# AGENTS.md\n\nNothing to run.\n")
    await write("DECISIONS.md", "# Decisions\n\n## D-001 — only\n\nScope: repo.\n")
    await write(
      "PROJECT_CONTEXT.md",
      "# State\n\nThe convention is peer D-050; upstream D-016 names the file. Local ruling (D-001) applies.\n",
    )
    const report = await runTruth()
    expect(report.findings.filter((f) => f.id.includes("dead-decision-ref"))).toEqual([])
    expect(report.disclosures.some((d) => d.includes("name another record"))).toBe(true)
  })

  it("discloses unresolvable refs when decisions live in a directory convention", async () => {
    await write("AGENTS.md", "# AGENTS.md\n\nNothing to run.\n")
    await write("docs/decisions/001-founding.md", "# 001\n\nA record.\n")
    await write("PROJECT_CONTEXT.md", "# State\n\nSee D-014 for the ruling.\n")
    const report = await runTruth()
    // No file carries `## D-NNN` entries, so the citation is unverifiable — never accused.
    expect(report.findings.filter((f) => f.id.includes("dead-decision-ref"))).toEqual([])
    expect(report.disclosures.some((d) => d.includes("could not be resolved"))).toBe(true)
  })

  it("a truthful state doc adds no findings", async () => {
    await write("package.json", JSON.stringify({ name: "honest", scripts: { test: "vitest" } }))
    await write("pnpm-lock.yaml", "")
    await write("node_modules/.bin/.keep", "")
    await write("src/index.ts", "export {}\n")
    await write("AGENTS.md", "# AGENTS.md\n\nRun `pnpm test`.\n")
    await write("DECISIONS.md", "# Decisions\n\n## D-001 — shipped\n\nScope: repo.\n")
    await write(
      "PROJECT_CONTEXT.md",
      "# State\n\n`pnpm test` is green; code in `src/index.ts`; per D-001 this stays.\n",
    )
    const report = await runTruth()
    expect(report.findings).toEqual([])
  })
})

describe("context-economy lens", () => {
  it("flags a heavy always-loaded file and the total budget", async () => {
    await write("package.json", JSON.stringify({ name: "heavy" }))
    const words = Array.from({ length: TOTAL_BUDGET_WORDS + 500 }, (_, i) => `word${i}`).join(" ")
    await write("AGENTS.md", `# AGENTS.md\n\n${words}\n`)
    const facts = await scanProject(dir)
    const report = await contextEconomyLens.run({
      root: dir,
      facts,
      profile: "solo",
      baseline: null,
    })
    const ids = report.findings.map((f) => f.id)
    expect(ids).toContain("context-economy/heavy-file:AGENTS.md")
    expect(ids).toContain("context-economy/total-over-budget")
  })

  it("stays quiet on a lean footprint", async () => {
    await write("package.json", JSON.stringify({ name: "lean" }))
    await write("AGENTS.md", "# AGENTS.md\n\nShort and lean.\n")
    const facts = await scanProject(dir)
    const report = await contextEconomyLens.run({
      root: dir,
      facts,
      profile: "solo",
      baseline: null,
    })
    expect(report.findings).toEqual([])
  })
})

describe("instruction-truth path resolution (the false-positive shapes)", () => {
  async function baseFixture(name: string) {
    await write("package.json", JSON.stringify({ name, scripts: {} }))
    await write("pnpm-lock.yaml", "")
    await write("node_modules/.bin/.keep", "")
  }

  it("does not accuse a domain-qualified URL in prose (a schemeless host is not a path)", async () => {
    await baseFixture("urlish")
    await write(
      "AGENTS.md",
      "# AGENTS.md\n\nThe sitemap `example.com/sitemap.xml` is served at the edge. The API root is `api.example.com/client/v4/`.\n",
    )
    const report = await runTruth()
    expect(report.findings.filter((f) => f.id.includes("stale-path"))).toEqual([])
  })

  it("skips a path named beside the URL it is fetched from (another tree), and says so", async () => {
    await baseFixture("fetched")
    await write(
      "AGENTS.md",
      "# AGENTS.md\n\nFetch `docs/email.md` from `https://github.com/example/agents/tree/main/docs` before extending the skill.\n",
    )
    const report = await runTruth()
    expect(report.findings.filter((f) => f.id.includes("stale-path"))).toEqual([])
    expect(report.disclosures.some((d) => d.includes("fetched from"))).toBe(true)
  })

  it("resolves a nested instruction file's reference against its own directory — and still flags a genuinely missing sibling", async () => {
    await baseFixture("nested")
    await write(
      ".claude/skills/demo/SKILL.md",
      "Details in `references/kv/`. Old drafts sit in `references/gone/`.\n",
    )
    await write(".claude/skills/demo/references/kv/README.md", "kv\n")
    const report = await runTruth()
    const ids = report.findings.map((f) => f.id)
    expect(ids.some((i) => i.endsWith(":references/kv"))).toBe(false)
    expect(ids).toContain(
      "instruction-truth/stale-path:.claude/skills/demo/SKILL.md:references/gone",
    )
  })

  it("resolves a reference written relative to a directory the same file names", async () => {
    await baseFixture("prosebase")
    await write(
      "PROJECT_CONTEXT.md",
      [
        "# Project context",
        "Private run state is `corpus/raw/review/v3/`.",
        "",
        "`v3/CHECKPOINT-2000.json` records the verified milestone.",
      ].join("\n"),
    )
    await write("corpus/raw/review/v3/CHECKPOINT-2000.json", "{}\n")
    const report = await runTruth()
    expect(report.findings.filter((f) => f.id.includes("stale-path"))).toEqual([])
  })

  it("judges existence on the working tree: gitignored-and-present is true, gitignored-and-absent is skipped", async () => {
    await baseFixture("wttruth")
    await write(".gitignore", "state/\n")
    await write("state/notes.md", "local notes\n")
    await write(
      "AGENTS.md",
      "# AGENTS.md\n\nLocal notes live in `state/notes.md`. Drafts land in `state/drafts.md`.\n",
    )
    await git(dir, ["init"])
    const report = await runTruth()
    expect(report.findings.filter((f) => f.id.includes("stale-path"))).toEqual([])
    expect(report.disclosures.some((d) => d.includes("gitignored"))).toBe(true)
  })
})
