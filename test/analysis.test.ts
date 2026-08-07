import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { mergeGateSection } from "../src/commands/gates.js"
import { derivedCommands, planWorkflow } from "../src/core/generate.js"
import { isDriftEmpty, summarizeBaselineDrift } from "../src/core/facts.js"
import type { ProjectFacts } from "../src/core/types.js"
import {
  generateAgentsMd,
  generateCommitMsgHook,
  generatePreCommitHook,
  generatePrePushHook,
  isSafeGateCommand,
} from "../src/pack/templates.js"

export function facts(overrides: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    etymdVersion: "0.0.0",
    packVersion: "1",
    generatedAt: new Date().toISOString(),
    root: "/tmp/demo",
    name: "demo",
    git: { isRepo: true, husky: false },
    packageManager: "pnpm",
    workspace: { kind: "none", packageGlobs: [] },
    packages: [],
    frameworks: ["React"],
    commands: {
      raw: { test: "vitest", lint: "eslint", typecheck: "tsc --noEmit" },
      test: "test",
      lint: "lint",
      typecheck: "typecheck",
    },
    ci: { system: "none", files: [] },
    publishable: false,
    publishRoute: "npm",
    hooks: {
      source: "none",
      preCommit: false,
      prePush: false,
      commitMsg: false,
      lintStaged: false,
    },
    artifacts: [
      { id: "agents", label: "AGENTS.md", path: "AGENTS.md", kind: "contract", exists: false },
      { id: "claude", label: "CLAUDE.md", path: "CLAUDE.md", kind: "adapter", exists: false },
    ],
    tree: { dirs: [{ name: "src", files: 10 }], truncated: false },
    ...overrides,
  }
}

describe("generateAgentsMd (minimal scaffold)", () => {
  it("embeds only truthful facts: Done=, map re-verify, pack version", () => {
    const md = generateAgentsMd(facts())
    expect(md).toContain("# AGENTS.md")
    expect(md).toContain("pnpm typecheck")
    expect(md).toContain("pnpm test")
    expect(md).toContain("Done =")
    expect(md).toContain("Advisory, not authoritative")
    expect(md).toContain("etymd pack v")
    // The scaffold must not claim what the scan cannot know.
    expect(md).not.toContain("PROJECT_CONTEXT.md")
  })

  it("never points at package.json in a docs-only repo that has none", () => {
    // The docs-only class: no manifest, no scripts, no frameworks — the scaffold must not
    // reference a file the scan never saw.
    const md = generateAgentsMd(
      facts({
        packageManager: "unknown",
        frameworks: [],
        commands: { raw: {} },
        tree: { dirs: [], truncated: false },
      }),
    )
    expect(md).not.toContain("package.json")
    expect(md).toContain("none detected")
  })
})

describe("generatePrePushHook", () => {
  it("never wires a writing command into the correctness gate", () => {
    const f = facts({
      commands: {
        raw: {
          format: "nx format:write && eslint --fix .",
          "generate:types": "graphql-codegen",
          lint: "eslint .",
        },
        format: "format",
        lint: "lint",
      },
    })
    const hook = generatePrePushHook(f)
    expect(hook).not.toContain("format:write")
    expect(hook).not.toContain("generate:types")
    expect(hook).toContain("lint")
  })

  it("isSafeGateCommand rejects writers and accepts checks", () => {
    expect(isSafeGateCommand("prettier --check .")).toBe(true)
    expect(isSafeGateCommand("tsc --noEmit")).toBe(true)
    expect(isSafeGateCommand("prettier --write .")).toBe(false)
    expect(isSafeGateCommand("eslint --fix .")).toBe(false)
    expect(isSafeGateCommand(undefined)).toBe(false)
  })
})

describe("planWorkflow", () => {
  it("plans only what onboarding scaffolds: contract + gates", async () => {
    const plan = await planWorkflow("/nonexistent-root", facts(), { agents: true, gates: true })
    const paths = plan.map((p) => p.path)
    expect(paths).toEqual([
      "AGENTS.md",
      ".githooks/pre-commit",
      ".githooks/commit-msg",
      ".githooks/pre-push",
    ])
    expect(plan.every((p) => p.exists === false)).toBe(true)
  })

  it("offers the publish screen only where something is actually published", async () => {
    const notPublished = await planWorkflow("/nonexistent-root", facts({ publishable: false }), {
      agents: false,
      gates: true,
    })
    expect(notPublished.map((p) => p.path)).not.toContain("scripts/artifact-check.sh")

    const published = await planWorkflow("/nonexistent-root", facts({ publishable: true }), {
      agents: false,
      gates: true,
    })
    expect(published.map((p) => p.path)).toContain("scripts/artifact-check.sh")

    // An explicit option overrides the derivation both ways — a repo can publish by a route
    // npm cannot see, or decline the door entirely.
    const forcedOff = await planWorkflow("/nonexistent-root", facts({ publishable: true }), {
      agents: false,
      gates: true,
      publishGate: false,
    })
    expect(forcedOff.map((p) => p.path)).not.toContain("scripts/artifact-check.sh")
  })

  it("a recorded gate config wins over the derivation", async () => {
    // The scan's guess is a starting point; the one edit that changes it must survive the next
    // `etymd gates` run, or the tool argues with the user every time.
    const plan = await planWorkflow("/nonexistent-root", facts({ publishable: true }), {
      agents: false,
      gates: true,
      gateConfig: {
        commands: ["typecheck"],
        failOn: "gap",
        publishGate: false,
        allowWriting: [],
      },
    })
    expect(plan.map((p) => p.path)).not.toContain("scripts/artifact-check.sh")
    const prePush = plan.find((p) => p.path === ".githooks/pre-push")?.contents ?? ""
    expect(prePush).toContain("typecheck")
    expect(prePush).not.toContain("lint")
    expect(prePush).toContain("--fail-on gap")
  })

  it("PINNED: regeneration keeps a test step the existing hook already ran", async () => {
    // Found by migrating a real repo: the derived set is format/typecheck/lint, so a repo whose
    // hook ran tests lost that check on regeneration — a silent downgrade, and the reason a
    // generator that drops working checks cannot be trusted to regenerate anything. `test` is
    // still not in the DEFAULT set (a slow suite in a push gate teaches people --no-verify);
    // it is preserved only where the repo already opted in.
    const f = facts({
      commands: { raw: { test: "vitest", typecheck: "tsc" }, test: "test", typecheck: "typecheck" },
    })
    // A repo whose hook already ran tests keeps them.
    expect(derivedCommands(f, "npm test || exit 1")).toContain("test")
    // A repo that never ran them in a hook does not suddenly gain a slow step.
    expect(derivedCommands(f, "npm run typecheck || exit 1")).not.toContain("test")
    expect(derivedCommands(f)).not.toContain("test")
  })

  it("honours an explicit allowWriting override for a command that would otherwise be refused", () => {
    // isSafeGateCommand is an opinion, not a law: picking a writing command IS the override.
    const f = facts({
      commands: { raw: { "lint:fix": "eslint --fix" }, lint: "lint:fix" },
    })
    const withoutOverride = generatePrePushHook(f, {
      commands: ["lint:fix"],
      failOn: "risk",
      allowWriting: [],
    })
    expect(withoutOverride).not.toContain("lint:fix")

    const withOverride = generatePrePushHook(f, {
      commands: ["lint:fix"],
      failOn: "risk",
      allowWriting: ["lint:fix"],
    })
    expect(withOverride).toContain("lint:fix")
  })

  it("PINNED: every generated hook calls a repo-owned companion it never generates", () => {
    // The seam that makes regeneration safe. Without it, a repo with its own guards had to
    // choose between accepting the pack (losing them) and hand-maintaining the file (losing
    // regeneration) — and a trial migration of real repos destroyed working checks proving it.
    const hooks: [string, string][] = [
      ["pre-commit", generatePreCommitHook()],
      ["commit-msg", generateCommitMsgHook()],
      ["pre-push", generatePrePushHook(facts())],
    ]
    for (const [name, body] of hooks) {
      expect(body).toContain(`${name}.local`)
      // Guarded on the executable bit, so an absent companion is simply skipped.
      expect(body).toContain('if [ -x "$LOCAL" ]')
      // A failing repo-owned check must stop the operation, not be swallowed.
      expect(body).toContain('"$LOCAL" "$@" || exit 1')
    }
  })

  it("keeps the generated file free of hand-written content, so drift stays byte-exact", async () => {
    // The companion is a separate FILE, deliberately not a marked region inside the generated
    // one: drift detection is exact byte equality, and any hand-written text living in the
    // compared file would make a tampered gate indistinguishable from an edited note.
    const plan = await planWorkflow("/nonexistent-root", facts(), { agents: false, gates: true })
    for (const f of plan.filter((p) => p.executable)) {
      expect(f.contents).not.toContain("etymd:keep")
      expect(f.path).not.toContain(".local")
    }
  })

  it("PINNED: every generated gate is inert without a checker — safe to commit to a public repo", () => {
    // The hooks carry no patterns and no policy: they resolve an external checker and no-op
    // when it is absent. This is what lets the same file be committed anywhere.
    const hooks = [generatePreCommitHook(), generateCommitMsgHook(), generatePrePushHook(facts())]
    for (const hook of hooks) {
      expect(hook).toMatch(/if \[ -x "\$GATE" \]/)
      expect(hook).toMatch(/^#!\/usr\/bin\/env sh/)
    }
    // The screen must never be inlined into a tracked file — the patterns ARE the secret.
    for (const hook of hooks) {
      expect(hook).not.toMatch(/grep -[a-zA-Z]*f? ['"]?(employer|corp|@)/i)
    }
  })

  it("plans nothing when both toggles are off", async () => {
    const plan = await planWorkflow("/nonexistent-root", facts(), { agents: false, gates: false })
    expect(plan).toEqual([])
  })
})

describe("summarizeBaselineDrift", () => {
  it("is empty when nothing on the measured axes changed", () => {
    expect(isDriftEmpty(summarizeBaselineDrift(facts(), facts()))).toBe(true)
  })

  it("captures command, artifact, and layout changes with direction", () => {
    const old = facts()
    const fresh = facts({
      commands: { raw: { test: "vitest", build: "tsup" }, test: "test", build: "build" },
      artifacts: [
        { id: "agents", label: "AGENTS.md", path: "AGENTS.md", kind: "contract", exists: true },
      ],
      tree: {
        dirs: [
          { name: "src", files: 10 },
          { name: "docs", files: 3 },
        ],
        truncated: false,
      },
    })
    const drift = summarizeBaselineDrift(old, fresh)
    const byRole = Object.fromEntries(drift.commands.map((c) => [c.role, c]))
    // lint/typecheck were present in old, gone in fresh; build newly appears.
    expect(byRole.lint).toEqual({ role: "lint", from: "lint", to: undefined })
    expect(byRole.build).toEqual({ role: "build", from: undefined, to: "build" })
    expect(drift.artifactsAdded).toContain("AGENTS.md")
    expect(drift.dirsAdded).toEqual(["docs"])
    expect(drift.dirsRemoved).toEqual([])
    expect(isDriftEmpty(drift)).toBe(false)
  })
})

describe("gate config _why annotations", () => {
  const gates = {
    commands: ["typecheck"],
    failOn: "risk",
    publishGate: false,
    allowWriting: [],
  }

  it("keeps a _why whose field this run did not change", () => {
    const merged = mergeGateSection(
      { commands: ["typecheck"], failOn: "risk", _why: { commands: "lint is CI-only here" } },
      gates,
    )
    expect((merged._why as Record<string, string>).commands).toBe("lint is CI-only here")
  })

  it("PINNED: drops a _why whose field this run changed — a stale reason misleads", () => {
    // Structured prose reads as more trustworthy than a shell comment, so an explanation left
    // attached to a value it no longer explains is worse than having none.
    const merged = mergeGateSection({ failOn: "gap", _why: { failOn: "no tests here" } }, gates)
    expect(merged.failOn).toBe("risk")
    expect(merged._why).toBeUndefined()
  })

  it("drops only the stale entries, keeping the rest", () => {
    const merged = mergeGateSection(
      {
        failOn: "gap",
        commands: ["typecheck"],
        _why: { failOn: "no tests here", commands: "lint is CI-only" },
      },
      gates,
    )
    expect(merged._why).toEqual({ commands: "lint is CI-only" })
  })

  it("preserves unknown keys etymd does not define", () => {
    const merged = mergeGateSection({ _note: "hand-written", failOn: "risk" }, gates)
    expect(merged._note).toBe("hand-written")
  })
})

describe("preservation is a property of generation, not of the command", () => {
  it("PINNED: planWorkflow itself keeps a test step the existing hook ran", async () => {
    // It used to live in `etymd gates`, so every OTHER caller regenerated without it — the fleet
    // drift check compared a repo against a hook missing checks the repo really runs, reporting
    // permanent false drift and offering a silent downgrade to anyone who applied it.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-preserve-"))
    await fs.mkdir(path.join(dir, ".githooks"), { recursive: true })
    await fs.writeFile(path.join(dir, ".githooks", "pre-push"), "#!/bin/sh\nnpm test || exit 1\n")

    const plan = await planWorkflow(dir, facts(), { agents: false, gates: true })
    const prePush = plan.find((p) => p.path === ".githooks/pre-push")?.contents ?? ""
    expect(prePush).toContain("test")

    // A repo whose hook never ran tests does not silently gain a slow step.
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-preserve-"))
    const freshPlan = await planWorkflow(fresh, facts(), { agents: false, gates: true })
    const freshHook = freshPlan.find((p) => p.path === ".githooks/pre-push")?.contents ?? ""
    expect(freshHook).not.toMatch(/^pnpm test/m)
  })
})

describe("shell correctness gate — the surface package.json cannot see", () => {
  it("writes a shellcheck step for a repo with a shell surface", () => {
    const hook = generatePrePushHook(facts({ shell: { scripts: 12 } }))
    expect(hook).toContain("shellcheck -S warning")
    // Discovery happens IN the hook, at push time. A baked-in file list is correct the day it
    // is generated and silently wrong the first time someone adds a script.
    expect(hook).toContain("git ls-files")
    expect(hook).not.toContain("bootstrap/")
  })

  it("omits the step entirely where there is no shell surface", () => {
    const hook = generatePrePushHook(facts({ shell: { scripts: 0 } }))
    expect(hook).not.toContain("shellcheck")
  })

  it("treats an absent `shell` fact as not-measured, not as zero", () => {
    // A facts file written by an older etymd predates the field; regenerating from it must not
    // crash, and must not claim a surface it never looked for.
    const hook = generatePrePushHook(facts({ shell: undefined }))
    expect(hook).not.toContain("shellcheck")
  })

  it("PINNED: a missing shellcheck binary skips LOUDLY and never blocks", () => {
    // The failure this prevents: a gate that goes quiet when its tool is absent looks installed
    // on every machine and is installed on one.
    const hook = generatePrePushHook(facts({ shell: { scripts: 3 } }))
    expect(hook).toContain("command -v shellcheck")
    expect(hook).toContain("shellcheck skipped (not on PATH)")
  })

  it("PINNED: blocks at warning, so style pedantry never trains the bypass flag", () => {
    // A high false-positive gate does not make a repo careful — it teaches --no-verify, and that
    // flag is shared with the content screen, which must never be bypassed.
    const hook = generatePrePushHook(facts({ shell: { scripts: 3 } }))
    expect(hook).toContain("-S warning")
    expect(hook).not.toContain("-S style")
  })

  it("stops claiming 'no correctness commands detected' when shell IS the surface", () => {
    // The contradiction that motivated this: a repo of shell scripts was told it had nothing to
    // check, one line above a step that checks it.
    const hook = generatePrePushHook(facts({ commands: { raw: {} }, shell: { scripts: 9 } }))
    expect(hook).not.toContain("no correctness commands detected")
    expect(hook).toContain("shell is this repo's checkable surface")
  })

  it("keeps package scripts primary — shell is additive, not a replacement", () => {
    const hook = generatePrePushHook(facts({ shell: { scripts: 4 } }), {
      commands: ["typecheck"],
      failOn: "risk",
      allowWriting: [],
    })
    expect(hook).toContain("pnpm typecheck")
    expect(hook).toContain("shellcheck")
    expect(hook.indexOf("typecheck")).toBeLessThan(hook.indexOf("shellcheck"))
  })
})
