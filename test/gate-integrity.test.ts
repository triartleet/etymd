import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { scanProject } from "../src/core/scan.js"
import { CI_ENV_VARS } from "../src/core/util.js"
import { deriveGateFindings } from "../src/lenses/gate-integrity/lens.js"
import {
  buildGateInventory,
  expandScriptRefs,
  matchTools,
} from "../src/lenses/gate-integrity/inventory.js"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "etymd-gate-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function write(rel: string, contents: string) {
  const abs = path.join(dir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, contents, "utf8")
}

describe("expandScriptRefs / matchTools", () => {
  const scripts = {
    test: "yarn test:lint && yarn test:types",
    "test:lint": "eslint .",
    "test:types": "tsc --noEmit",
  }

  it("expands yarn/npm-run script references so CI lines match what they actually run", () => {
    expect(matchTools("yarn test", scripts).sort()).toEqual(["lint", "typecheck"])
  })

  it("bounds recursion depth", () => {
    const cyclic = { a: "yarn b", b: "yarn a" }
    expect(() => expandScriptRefs("yarn a", cyclic)).not.toThrow()
  })

  // Every shape below was found live in real repos. The previous
  // positional regex handled only `npm run x`, `yarn x` and `pnpm x`; the rest expanded to
  // nothing, so a hook running `pnpm run typecheck` reported as having no typecheck at all.
  const SCRIPTS = {
    typecheck: "tsc --noEmit",
    test: "vitest run",
    "format:check": 'prettier --check "src/**/*.ts"',
    build: "tsc",
    lint: "eslint src/",
    ci: "vitest run --coverage",
  }

  it.each([
    ["pnpm run typecheck", "typecheck"],
    ["pnpm -s typecheck", "typecheck"],
    ["pnpm typecheck", "typecheck"],
    ["npm run typecheck", "typecheck"],
    ["yarn run typecheck", "typecheck"],
    ["bun run typecheck", "typecheck"],
    ["pnpm -r --if-present run typecheck", "typecheck"],
    ["pnpm --filter @scope/pkg typecheck", "typecheck"],
    ["yarn workspace @scope/pkg typecheck", "typecheck"],
  ])("expands %s regardless of where the script name sits", (cmd) => {
    expect(matchTools(cmd, SCRIPTS)).toContain("typecheck")
  })

  it("never reads a package-manager built-in as a script", () => {
    // `npm ci` installs; a `ci` script cannot shadow it. Expanding it would claim a test
    // gate exists on a line that only installs dependencies.
    expect(matchTools("npm ci", SCRIPTS)).not.toContain("test")
    expect(matchTools("pnpm install --frozen-lockfile", SCRIPTS)).not.toContain("test")
    expect(matchTools("yarn install --frozen-lockfile", SCRIPTS)).not.toContain("test")
  })

  it("keeps the genuine script shortcuts", () => {
    expect(matchTools("npm test", SCRIPTS)).toContain("test")
    expect(matchTools("bun test", SCRIPTS)).toContain("test")
  })

  it("treats exec/dlx as binary invocations, not script lookups", () => {
    // `pnpm exec tsc --noEmit` runs a binary; `build` here is a path argument, not the script.
    expect(matchTools("pnpm exec eslint build", SCRIPTS)).not.toContain("typecheck")
    expect(matchTools("pnpm exec eslint build", SCRIPTS)).toContain("lint")
  })

  it("still expands run-s / run-p script lists", () => {
    expect(matchTools("npx run-s lint typecheck", SCRIPTS)).toContain("typecheck")
    expect(matchTools("npm-run-all lint typecheck", SCRIPTS)).toContain("typecheck")
  })

  it("does not treat an npx binary as a script name", () => {
    expect(matchTools("npx eslint src/", SCRIPTS)).toContain("lint")
  })

  it("distinguishes prettier check from prettier write", () => {
    expect(matchTools("prettier -l 'src/**'", {})).toContain("format-check")
    expect(matchTools("prettier --write src", {})).toContain("format-write")
    expect(matchTools("prettier --write src", {})).not.toContain("format-check")
  })
})

// The cra-legacy shape: a sonar job with NO local script (it lives
// in an org template) but SONAR_* variables + allow_failure; husky-v3 + lint-staged
// prettier-only locally; coverage collected but no threshold; commitlint installed but unwired;
// an org include the tool cannot read; !reference tags that must not break parsing.
//
// Every identifier below is INVENTED, and must stay that way. A fixture modelled on a real
// repository is exactly where a real name slips into a public one: the shape is all the test
// needs, while the name is what a reader can match against something real. Describe the shape,
// never borrow the name.
const LEGACY_SPA_CI = `
include:
  - project: "example-org/ci-includes"
    file: "/frontend.yml"

stages:
  - test
  - report

.rules_all:
  rules:
    - when: always

unit tests:
  stage: test
  script:
    - yarn test
    - sed -i 's|/app|.|' coverage/lcov.info

sonarqube:
  image: node:20-slim
  stage: report
  allow_failure: true
  rules: !reference [.rules_all, rules]
  variables:
    SONAR_EXCLUSIONS: src/graphql/*
    SONAR_SCANNER_PACKAGE_VERSION: 4.2.3
`

async function writeLegacySpaFixture() {
  await write(
    "package.json",
    JSON.stringify({
      name: "cra-legacy-like",
      scripts: {
        test: "yarn test:lint && yarn test:format && yarn test:types && yarn test:unit",
        "test:lint": "eslint . --ext .ts,.tsx",
        "test:format": "prettier -l '**/*.{ts,tsx}'",
        "test:types": "tsc --noEmit",
        "test:unit": "jest --silent",
        "test:coverage": "jest --coverage",
      },
      devDependencies: { "@commitlint/cli": "17.0.0" },
      husky: { hooks: { "pre-commit": "lint-staged" } },
      "lint-staged": { "**/*.{ts,tsx}": ["prettier --write", "git add"] },
    }),
  )
  await write("yarn.lock", "")
  await write("jest.config.js", "module.exports = { collectCoverageFrom: ['src/**'] }\n")
  await write(".gitlab-ci.yml", LEGACY_SPA_CI)
}

describe("buildGateInventory (cra-legacy-shaped fixture)", () => {
  it("parses CI with !reference tags, records inherited includes and advisory jobs", async () => {
    await writeLegacySpaFixture()
    const facts = await scanProject(dir)
    const inv = await buildGateInventory(dir, facts)

    expect(inv.ci.parseErrors).toEqual([])
    expect(inv.ci.inheritedIncludes.some((i) => i.includes("example-org/ci-includes"))).toBe(true)

    // The sonar job's script is inherited — detected from its name/SONAR_* variables, honestly
    // marked as not-locally-visible.
    const sonar = inv.ci.jobs.find((j) => j.job === "sonarqube")
    expect(sonar?.advisory).toBe(true)
    expect(sonar?.tools).toContain("sonar")
    expect(sonar?.scriptVisible).toBe(false)

    const unit = inv.ci.jobs.find((j) => j.job === "unit tests")
    expect(unit?.advisory).toBe(false)
    // `yarn test` expands to the four narrow scripts.
    expect(unit?.tools).toEqual(
      expect.arrayContaining(["lint", "format-check", "typecheck", "test"]),
    )

    expect(inv.local.source).toBe("husky-legacy")
    expect(inv.local.preCommit).toContain("format-write")
    expect(inv.thresholds.sonarConfigured).toBe(true)
    expect(inv.thresholds.coverageThresholdLocal).toBe(false)
    expect(inv.thresholds.coverageCollected).toBe(true)
    expect(inv.commitlintDep).toBe(true)
  })

  it("derives the honest findings: CI-only correctness, server-side coverage, unwired commitlint", async () => {
    await writeLegacySpaFixture()
    const facts = await scanProject(dir)
    const inv = await buildGateInventory(dir, facts)
    const findings = deriveGateFindings(inv)
    const ids = findings.map((f) => f.id)

    // Shift-left: typecheck/lint/test enforced only in CI (local pre-commit only formats).
    expect(ids).toContain("gate-integrity/ci-only-typecheck")
    expect(ids).toContain("gate-integrity/ci-only-lint")
    expect(ids).toContain("gate-integrity/ci-only-test")

    // The motivating legacy-repo case, phrased humbly about the server-side threshold.
    const coverage = findings.find((f) => f.id === "gate-integrity/coverage-no-local-threshold")
    expect(coverage).toBeDefined()
    expect(coverage?.claim).toContain("server-side")
    expect(coverage?.claim).toContain("allow_failure")

    expect(ids).toContain("gate-integrity/commitlint-unwired")

    // The advisory sonar job must never appear as an enforced CI gate source.
    const shiftLeft = findings.filter((f) => f.id.startsWith("gate-integrity/ci-only-"))
    for (const f of shiftLeft) {
      expect(f.evidence.join(" ")).not.toContain("sonarqube")
    }
  })

  it("suppresses bypass findings when inherited templates could be running the check", async () => {
    await writeLegacySpaFixture()
    const facts = await scanProject(dir)
    const inv = await buildGateInventory(dir, facts)
    const ids = deriveGateFindings(inv).map((f) => f.id)
    // format-write runs locally and CI does not re-check formatting — but with unreadable
    // includes the honest position is silence, not accusation.
    expect(ids.filter((i) => i.startsWith("gate-integrity/local-only-"))).toEqual([])
  })
})

describe("buildGateInventory (github workflow)", () => {
  it("reads job steps and continue-on-error", async () => {
    await write("package.json", JSON.stringify({ name: "gh", scripts: { lint: "eslint ." } }))
    await write(
      ".github/workflows/ci.yml",
      `on: push
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
      - run: npx tsc --noEmit
  advisory:
    continue-on-error: true
    steps:
      - run: npx chromatic
`,
    )
    const facts = await scanProject(dir)
    const inv = await buildGateInventory(dir, facts)
    const checks = inv.ci.jobs.find((j) => j.job === "checks")
    expect(checks?.tools).toEqual(expect.arrayContaining(["lint", "typecheck"]))
    expect(inv.ci.jobs.find((j) => j.job === "advisory")?.advisory).toBe(true)
  })
})

// The blind spot behind a dismissal that should never have been needed: a repo wired a check
// into the companion the generated hook calls, proved it blocks the push by running the hook,
// and the lens still reported the check as CI-only. Etymd EMITS that include, so failing to
// follow it is the tool not reading its own output — and a dismissal is for a false positive
// or an accepted trade-off, never for something the tool simply cannot see.
describe("checks wired through the <hook>.local companion", () => {
  const PACKAGE = JSON.stringify({
    name: "companion",
    scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
  })
  const CI = `on: push
jobs:
  check:
    steps:
      - run: npm test
      - run: npm run typecheck
`
  // The include exactly as the pack emits it.
  const HOOK = `#!/usr/bin/env sh
LOCAL="$(dirname "$0")/pre-push.local"
if [ -x "$LOCAL" ]; then
  "$LOCAL" "$@" || exit 1
fi
npm run typecheck || exit 1
exit 0
`
  const COMPANION = `#!/usr/bin/env sh
npm test || exit 1
`

  async function fixture(
    opts: {
      companion?: string
      executable?: boolean
      hook?: string
      hookExecutable?: boolean
    } = {},
  ) {
    await write("package.json", PACKAGE)
    await write(".github/workflows/ci.yml", CI)
    await write(".githooks/pre-push", opts.hook ?? HOOK)
    await fs.chmod(
      path.join(dir, ".githooks/pre-push"),
      opts.hookExecutable === false ? 0o644 : 0o755,
    )
    if (opts.companion !== undefined) {
      await write(".githooks/pre-push.local", opts.companion)
      await fs.chmod(path.join(dir, ".githooks/pre-push.local"), opts.executable ? 0o755 : 0o644)
    }
    const facts = await scanProject(dir)
    return buildGateInventory(dir, facts)
  }

  it("counts a check that lives in the companion as locally enforced", async () => {
    const inv = await fixture({ companion: COMPANION, executable: true })
    expect(inv.local.prePush).toContain("test")
    expect(inv.local.companions).toContain(".githooks/pre-push.local")
    expect(deriveGateFindings(inv).map((f) => f.id)).not.toContain("gate-integrity/ci-only-test")
  })

  it("discloses that the companion is where the enforcement came from", async () => {
    const inv = await fixture({ companion: COMPANION, executable: true })
    const disclosures: string[] = []
    deriveGateFindings(inv, disclosures)
    const all = [...disclosures, ...inv.local.companions].join(" ")
    expect(all).toContain(".githooks/pre-push.local")
  })

  // The two ways a companion does NOT run. Following the include must not become a blanket
  // assumption that any sibling file counts — that would trade a false accusation for a false
  // all-clear, which is the more expensive of the two for a gate.
  it("does not count a companion the hook never calls", async () => {
    const inv = await fixture({
      companion: COMPANION,
      executable: true,
      hook: "#!/usr/bin/env sh\nnpm run typecheck || exit 1\nexit 0\n",
    })
    expect(inv.local.prePush).not.toContain("test")
    expect(inv.local.companions).toEqual([])
    expect(deriveGateFindings(inv).map((f) => f.id)).toContain("gate-integrity/ci-only-test")
  })

  // Windows has no POSIX execute bit, so the detector deliberately declines to answer there
  // rather than invent a dead gate — which makes this assertion Unix-only by design.
  it.skipIf(process.platform === "win32")(
    "does not count a companion without the execute bit — the hook's own `[ -x ]` skips it",
    async () => {
      const inv = await fixture({ companion: COMPANION, executable: false })
      expect(inv.local.prePush).not.toContain("test")
      expect(inv.local.inertCompanions).toContain(".githooks/pre-push.local")
      expect(deriveGateFindings(inv).map((f) => f.id)).toContain("gate-integrity/ci-only-test")
    },
  )

  // A gate the repo believes in that cannot run is the silent failure this tool exists for, so it
  // is a finding rather than a line in the disclosures — where it does not rank, does not gate,
  // and does not reach the ledger.
  it.skipIf(process.platform === "win32")(
    "reports an unrunnable companion as a finding, with a fix that survives a fresh clone",
    async () => {
      const inv = await fixture({ companion: COMPANION, executable: false })
      const found = deriveGateFindings(inv).find(
        (f) => f.id === "gate-integrity/companion-not-executable",
      )
      expect(found).toBeDefined()
      expect(found?.evidence).toContain(".githooks/pre-push.local")
      // gap, not risk: risk is reserved for what makes an agent do the wrong thing, and shipping
      // this at risk would fail the `--fail-on risk` gate etymd recommends in a repo whose code
      // never changed.
      expect(found?.tier).toBe("gap")
      // An objective repo-state fact, not an opinion — so `doctor` must not skip it.
      expect(found?.kind).toBe("truth")
      // chmod alone does not survive a clone: git tracks exactly one permission bit.
      expect(found?.action).toContain("update-index --chmod=+x")
    },
  )

  // The guard that keeps the accusation honest. A filesystem carrying no execute bits reports
  // everything as non-executable; the claim needs the ASYMMETRY of a hook that has the bit beside
  // a companion that does not. Without it, every Windows or bit-dropping-mount checkout would be
  // told its working gate is dead.
  it.skipIf(process.platform === "win32")(
    "never accuses when the hook beside it has no execute bit either — the bits prove nothing there",
    async () => {
      const inv = await fixture({ companion: COMPANION, executable: false, hookExecutable: false })
      expect(inv.local.inertCompanions).toEqual([])
      expect(inv.local.unverifiedCompanions).toContain(".githooks/pre-push.local")
      // Counted rather than dropped, so no phantom CI-only gap either — and the uncertainty is
      // disclosed instead of hidden.
      expect(inv.local.prePush).toContain("test")
      const disclosures: string[] = []
      const ids = deriveGateFindings(inv, disclosures).map((f) => f.id)
      expect(ids).not.toContain("gate-integrity/companion-not-executable")
      expect(ids).not.toContain("gate-integrity/ci-only-test")
    },
  )

  it("is unbothered by an absent companion", async () => {
    const inv = await fixture()
    expect(inv.local.companions).toEqual([])
    expect(inv.local.inertCompanions).toEqual([])
    expect(inv.local.prePush).toContain("typecheck")
  })
})

describe("hook wiring is a developer-machine fact, not a CI one", () => {
  // A CI checkout never has git config, so core.hooksPath is ALWAYS unset there. Accusing it
  // would fail the very `etymd audit --fail-on risk` gate the README tells users to add — in
  // every repo with tracked hooks. Caught by etymd's own first CI run.
  const inv = {
    local: { source: "githooks", wired: false, preCommit: [], prePush: [], commitMsg: [] },
    ci: { system: "none", jobs: [], inheritedIncludes: [], parseErrors: [] },
    thresholds: {},
  } as unknown as Parameters<typeof deriveGateFindings>[0]

  // Clears/sets EVERY var the detector consults, driven by the exported list rather than a
  // hand-copied one — the first version of this test only cleared `CI` and so failed inside
  // GitHub Actions, which also sets GITHUB_ACTIONS.
  const withCi = <T>(inCi: boolean, fn: () => T): T => {
    const before = CI_ENV_VARS.map((v) => [v, process.env[v]] as const)
    for (const v of CI_ENV_VARS) delete process.env[v]
    if (inCi) process.env.CI = "true"
    try {
      return fn()
    } finally {
      for (const [v, value] of before) {
        if (value === undefined) delete process.env[v]
        else process.env[v] = value
      }
    }
  }

  it("flags unwired hooks on a developer machine", () => {
    const disclosures: string[] = []
    const ids = withCi(false, () => deriveGateFindings(inv, disclosures)).map((f) => f.id)
    expect(ids).toContain("gate-integrity/hooks-not-wired")
  })

  it("skips and discloses instead of flagging when running in CI", () => {
    const disclosures: string[] = []
    const ids = withCi(true, () => deriveGateFindings(inv, disclosures)).map((f) => f.id)
    expect(ids).not.toContain("gate-integrity/hooks-not-wired")
    expect(disclosures.some((d) => d.includes("Running in CI"))).toBe(true)
  })
})
