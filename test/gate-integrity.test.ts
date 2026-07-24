import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { scanProject } from "../src/core/scan.js"
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

  it("distinguishes prettier check from prettier write", () => {
    expect(matchTools("prettier -l 'src/**'", {})).toContain("format-check")
    expect(matchTools("prettier --write src", {})).toContain("format-write")
    expect(matchTools("prettier --write src", {})).not.toContain("format-check")
  })
})

// The cra-legacy-shaped fixture, faithful to the real repo: sonar job with NO local script (it lives
// in the org template) but SONAR_* variables + allow_failure; husky-v3 + lint-staged
// prettier-only locally; coverage collected but no threshold; commitlint installed but unwired;
// an org include the tool cannot read; !reference tags that must not break parsing.
const RMTP_LIKE_CI = `
include:
  - project: "org/pipeline-templates"
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

async function writeRmtpLikeFixture() {
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
  await write(".gitlab-ci.yml", RMTP_LIKE_CI)
}

describe("buildGateInventory (cra-legacy-shaped fixture)", () => {
  it("parses CI with !reference tags, records inherited includes and advisory jobs", async () => {
    await writeRmtpLikeFixture()
    const facts = await scanProject(dir)
    const inv = await buildGateInventory(dir, facts)

    expect(inv.ci.parseErrors).toEqual([])
    expect(inv.ci.inheritedIncludes.some((i) => i.includes("org/pipeline-templates"))).toBe(true)

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
    await writeRmtpLikeFixture()
    const facts = await scanProject(dir)
    const inv = await buildGateInventory(dir, facts)
    const findings = deriveGateFindings(inv)
    const ids = findings.map((f) => f.id)

    // Shift-left: typecheck/lint/test enforced only in CI (local pre-commit only formats).
    expect(ids).toContain("gate-integrity/ci-only-typecheck")
    expect(ids).toContain("gate-integrity/ci-only-lint")
    expect(ids).toContain("gate-integrity/ci-only-test")

    // The motivating cra-legacy case, phrased humbly about the server-side threshold.
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
    await writeRmtpLikeFixture()
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
