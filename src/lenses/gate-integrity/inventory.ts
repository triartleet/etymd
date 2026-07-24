import path from "node:path"

import YAML from "yaml"

import type { ProjectFacts } from "../../core/types.js"
import { pathExists, readJson, readText } from "../../core/util.js"

// The gate inventory: every quality gate the project runs, locally and in CI, matched against
// a tool registry. Deterministic; the lens turns it into findings. Honesty is structural here:
// what we cannot see (org-template includes, server-side thresholds) is RECORDED, not guessed.

export type GateTool =
  | "typecheck"
  | "lint"
  | "format-check"
  | "format-write"
  | "test"
  | "coverage"
  | "e2e"
  | "sonar"
  | "codecov"
  | "commitlint"
  | "size"
  | "chromatic"

export interface CiJobGate {
  job: string
  file: string
  tools: GateTool[]
  /** allow_failure / continue-on-error — an advisory job is NOT an enforced gate. */
  advisory: boolean
  /** rules/only/except present — blocking-ness may differ per branch. */
  branchScoped: boolean
  /** False when the job's script lives in an inherited template — tools are then inferred from
   * the job name/variables only and may be incomplete. */
  scriptVisible: boolean
}

export interface GateInventory {
  local: {
    source: ProjectFacts["hooks"]["source"]
    wired: boolean
    preCommit: GateTool[]
    prePush: GateTool[]
    commitMsg: GateTool[]
    lintStaged: GateTool[]
  }
  ci: {
    system: ProjectFacts["ci"]["system"]
    jobs: CiJobGate[]
    /** include: entries pointing outside the repo — jobs we cannot see. */
    inheritedIncludes: string[]
    parseErrors: string[]
  }
  thresholds: {
    sonarConfigured: boolean
    coverageThresholdLocal: boolean
    coverageCollected: boolean
  }
  commitlintDep: boolean
}

const TOOL_MATCHERS: [GateTool, RegExp][] = [
  ["sonar", /sonar-scanner|sonarqube|\bsonar\b/i],
  ["codecov", /codecov/i],
  ["commitlint", /commitlint/],
  ["chromatic", /chromatic/],
  ["size", /size-limit|bundlesize/],
  ["e2e", /\bcypress\b|\bplaywright\b/],
  ["coverage", /--coverage|\bnyc\b|\bc8\b/],
  ["format-check", /prettier[^&|;]*(\s-l\b|\s--check)|format:check/],
  ["format-write", /prettier[^&|;]*--write|--fix\b/],
  ["typecheck", /\btsc\b(?![^&|;]*--watch)/],
  ["lint", /\beslint\b/],
  ["test", /\bjest\b|\bvitest\b|react-scripts test|\bnx\b[^&|;]*\btest\b/],
]

/**
 * Expand `yarn x` / `npm run x` / `pnpm x` references into the referenced script bodies (two
 * levels) so a CI line like `yarn test:lint` is matched by what it actually runs.
 */
export function expandScriptRefs(
  command: string,
  scripts: Record<string, string>,
  depth = 2,
): string {
  if (depth <= 0) return command
  let expanded = command
  for (const m of command.matchAll(
    /(?:yarn|pnpm|npm run|bun run|npx run-s|npx run-p)\s+([A-Za-z0-9:._-]+)/g,
  )) {
    const name = m[1] as string
    const body = scripts[name]
    if (body) expanded += `\n${expandScriptRefs(body, scripts, depth - 1)}`
  }
  // Bare script-name tokens inside npm-run-all/run-s/run-p invocations.
  if (/npm-run-all|run-s|run-p/.test(command)) {
    for (const token of command.split(/\s+/)) {
      const clean = token.replace(/["']/g, "")
      const body = scripts[clean]
      if (body) expanded += `\n${expandScriptRefs(body, scripts, depth - 1)}`
    }
  }
  return expanded
}

export function matchTools(command: string, scripts: Record<string, string>): GateTool[] {
  const expanded = expandScriptRefs(command, scripts)
  const tools = new Set<GateTool>()
  for (const [tool, re] of TOOL_MATCHERS) {
    if (re.test(expanded)) tools.add(tool)
  }
  return [...tools]
}

/** GitLab CI custom tags (!reference) must parse without exploding the whole document. */
const GITLAB_TAGS: YAML.Tags = [
  { tag: "!reference", collection: "seq", resolve: () => [] } as unknown as YAML.CollectionTag,
]

const GITLAB_RESERVED = new Set([
  "stages",
  "variables",
  "include",
  "default",
  "workflow",
  "image",
  "services",
  "before_script",
  "after_script",
  "cache",
  "types",
])

interface GitlabJob {
  script?: unknown
  before_script?: unknown
  extends?: unknown
  allow_failure?: unknown
  rules?: unknown
  only?: unknown
  except?: unknown
  stage?: unknown
  image?: unknown
  trigger?: unknown
  variables?: unknown
  needs?: unknown
}

/** In GitLab CI every non-reserved, non-hidden top-level mapping IS a job. */
function looksLikeJob(job: GitlabJob): boolean {
  return (
    job.script !== undefined ||
    job.before_script !== undefined ||
    job.extends !== undefined ||
    job.stage !== undefined ||
    job.image !== undefined ||
    job.trigger !== undefined ||
    job.rules !== undefined ||
    job.needs !== undefined ||
    job.allow_failure !== undefined
  )
}

/** Tools inferable without seeing the script: the job's name and its SONAR_*-style variables. */
function inferToolsFromShape(name: string, job: GitlabJob): GateTool[] {
  const tools = new Set<GateTool>()
  if (/sonar/i.test(name)) tools.add("sonar")
  if (/chromatic/i.test(name)) tools.add("chromatic")
  if (job.variables && typeof job.variables === "object") {
    for (const key of Object.keys(job.variables as Record<string, unknown>)) {
      if (key.startsWith("SONAR_")) tools.add("sonar")
    }
  }
  return [...tools]
}

function asLines(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string")
  return []
}

function parseGitlabCi(
  text: string,
  file: string,
  scripts: Record<string, string>,
): { jobs: CiJobGate[]; inheritedIncludes: string[]; parseErrors: string[] } {
  const parseErrors: string[] = []
  let doc: Record<string, unknown>
  try {
    doc = YAML.parse(text, { customTags: GITLAB_TAGS, logLevel: "silent" }) as Record<
      string,
      unknown
    >
  } catch (err) {
    parseErrors.push(
      `${file}: ${err instanceof Error ? err.message.split("\n")[0] : "unparseable YAML"}`,
    )
    return { jobs: [], inheritedIncludes: [], parseErrors }
  }
  if (!doc || typeof doc !== "object") return { jobs: [], inheritedIncludes: [], parseErrors }

  const inheritedIncludes: string[] = []
  const include = doc.include
  const includeEntries = Array.isArray(include) ? include : include ? [include] : []
  for (const entry of includeEntries) {
    if (typeof entry === "string") inheritedIncludes.push(entry)
    else if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>
      if (typeof e.local === "string") inheritedIncludes.push(`local: ${e.local}`)
      else if (typeof e.project === "string") inheritedIncludes.push(`project: ${e.project}`)
      else if (typeof e.template === "string") inheritedIncludes.push(`template: ${e.template}`)
      else if (typeof e.remote === "string") inheritedIncludes.push(`remote: ${e.remote}`)
    }
  }

  const jobs: CiJobGate[] = []
  const resolveScript = (job: GitlabJob, seen = new Set<string>()): string[] => {
    const lines = [...asLines(job.before_script), ...asLines(job.script)]
    const bases = asLines(job.extends).length
      ? asLines(job.extends)
      : typeof job.extends === "string"
        ? [job.extends]
        : []
    for (const base of bases) {
      if (seen.has(base)) continue
      seen.add(base)
      const tpl = doc[base]
      if (tpl && typeof tpl === "object") lines.push(...resolveScript(tpl as GitlabJob, seen))
    }
    return lines
  }

  for (const [key, value] of Object.entries(doc)) {
    if (GITLAB_RESERVED.has(key) || key.startsWith(".")) continue
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const job = value as GitlabJob
    if (!looksLikeJob(job)) continue
    const lines = resolveScript(job)
    const tools = new Set<GateTool>(inferToolsFromShape(key, job))
    for (const line of lines) for (const t of matchTools(line, scripts)) tools.add(t)
    if (!lines.length && !tools.size) continue
    jobs.push({
      job: key,
      file,
      tools: [...tools],
      advisory:
        job.allow_failure === true ||
        (typeof job.allow_failure === "object" && job.allow_failure !== null),
      branchScoped: Boolean(job.rules ?? job.only ?? job.except),
      scriptVisible: lines.length > 0,
    })
  }

  return { jobs, inheritedIncludes, parseErrors }
}

function parseGithubWorkflow(
  text: string,
  file: string,
  scripts: Record<string, string>,
): { jobs: CiJobGate[]; parseErrors: string[] } {
  const parseErrors: string[] = []
  let doc: Record<string, unknown>
  try {
    doc = YAML.parse(text, { logLevel: "silent" }) as Record<string, unknown>
  } catch (err) {
    parseErrors.push(
      `${file}: ${err instanceof Error ? err.message.split("\n")[0] : "unparseable YAML"}`,
    )
    return { jobs: [], parseErrors }
  }
  const jobs: CiJobGate[] = []
  const jobsObj = (doc?.jobs ?? {}) as Record<string, unknown>
  for (const [key, value] of Object.entries(jobsObj)) {
    if (!value || typeof value !== "object") continue
    const job = value as { steps?: unknown; "continue-on-error"?: unknown }
    const steps = Array.isArray(job.steps) ? job.steps : []
    const tools = new Set<GateTool>()
    for (const step of steps) {
      const run = (step as { run?: unknown })?.run
      if (typeof run === "string") for (const t of matchTools(run, scripts)) tools.add(t)
    }
    if (!tools.size) continue
    jobs.push({
      job: key,
      file,
      tools: [...tools],
      advisory: job["continue-on-error"] === true,
      branchScoped: false,
      scriptVisible: true,
    })
  }
  return { jobs, parseErrors }
}

async function localHookTools(
  root: string,
  facts: ProjectFacts,
  scripts: Record<string, string>,
): Promise<GateInventory["local"]> {
  const hooks = facts.hooks
  const empty: GateTool[] = []
  const readHook = async (name: string): Promise<GateTool[]> => {
    if (!hooks.dir) return empty
    const text = await readText(path.join(root, hooks.dir, name))
    return text ? matchTools(text, scripts) : empty
  }

  let preCommit: GateTool[] = []
  let prePush: GateTool[] = []
  let commitMsg: GateTool[] = []

  if (hooks.dir) {
    ;[preCommit, prePush, commitMsg] = await Promise.all([
      readHook("pre-commit"),
      readHook("pre-push"),
      readHook("commit-msg"),
    ])
  } else if (hooks.source === "husky-legacy") {
    const pkg = await readJson<{ husky?: { hooks?: Record<string, string> } }>(
      path.join(root, "package.json"),
    )
    const legacy = pkg?.husky?.hooks ?? {}
    const configText = await readText(path.join(root, "husky.config.js"))
    const forHook = (name: string): GateTool[] => {
      const cmd = legacy[name] ?? (configText?.includes(name) ? configText : undefined)
      return cmd ? matchTools(cmd, scripts) : []
    }
    preCommit = forHook("pre-commit")
    prePush = forHook("pre-push")
    commitMsg = forHook("commit-msg")
  }

  // lint-staged runs at pre-commit; its config names the actual tools.
  let lintStaged: GateTool[] = []
  if (hooks.lintStaged) {
    const pkg = await readJson<{ "lint-staged"?: unknown }>(path.join(root, "package.json"))
    const config = pkg?.["lint-staged"]
    const commands: string[] = []
    const collect = (v: unknown) => {
      if (typeof v === "string") commands.push(v)
      else if (Array.isArray(v)) v.forEach(collect)
      else if (v && typeof v === "object") Object.values(v).forEach(collect)
    }
    collect(config)
    const tools = new Set<GateTool>()
    for (const cmd of commands) for (const t of matchTools(cmd, scripts)) tools.add(t)
    lintStaged = [...tools]
    // lint-staged pre-commit tools count as pre-commit enforcement.
    if (
      (hooks.preCommit || hooks.source === "husky" || hooks.source === "husky-legacy") &&
      lintStaged.length
    ) {
      preCommit = [...new Set([...preCommit, ...lintStaged])]
    }
  }

  const wired =
    hooks.source === "custom" || hooks.source === "husky" || hooks.source === "husky-legacy"
      ? true
      : hooks.source === "githooks"
        ? facts.git.hooksPath === hooks.dir
        : false

  return { source: hooks.source, wired, preCommit, prePush, commitMsg, lintStaged }
}

async function detectThresholds(
  root: string,
  scripts: Record<string, string>,
  ciJobs: CiJobGate[],
): Promise<GateInventory["thresholds"]> {
  const sonarConfigured =
    (await pathExists(path.join(root, "sonar-project.properties"))) ||
    ciJobs.some((j) => j.tools.includes("sonar"))

  let coverageThresholdLocal = false
  for (const f of [
    "jest.config.js",
    "jest.config.ts",
    "jest.config.cjs",
    "jest.config.mjs",
    "jest.config.json",
    "vitest.config.ts",
    "vitest.config.js",
    "vitest.config.mts",
  ]) {
    const text = await readText(path.join(root, f))
    if (text && /coverageThreshold|thresholds\s*:/.test(text)) {
      coverageThresholdLocal = true
      break
    }
  }
  if (!coverageThresholdLocal) {
    const pkg = await readJson<{ jest?: { coverageThreshold?: unknown } }>(
      path.join(root, "package.json"),
    )
    coverageThresholdLocal = Boolean(pkg?.jest?.coverageThreshold)
  }

  const coverageCollected =
    Object.values(scripts).some((v) => /--coverage|\bnyc\b|\bc8\b/.test(v)) ||
    ciJobs.some((j) => j.tools.includes("coverage") || j.tools.includes("sonar"))

  return { sonarConfigured, coverageThresholdLocal, coverageCollected }
}

export async function buildGateInventory(
  root: string,
  facts: ProjectFacts,
): Promise<GateInventory> {
  const scripts = facts.commands.raw
  const jobs: CiJobGate[] = []
  const inheritedIncludes: string[] = []
  const parseErrors: string[] = []

  if (facts.ci.system === "gitlab") {
    const text = await readText(path.join(root, ".gitlab-ci.yml"))
    if (text) {
      const parsed = parseGitlabCi(text, ".gitlab-ci.yml", scripts)
      jobs.push(...parsed.jobs)
      parseErrors.push(...parsed.parseErrors)
      for (const inc of parsed.inheritedIncludes) {
        // A local include we can read is followed one level; everything else is inherited-unseen.
        if (inc.startsWith("local: ")) {
          const rel = inc.slice("local: ".length).replace(/^\//, "")
          const subText = await readText(path.join(root, rel))
          if (subText) {
            const sub = parseGitlabCi(subText, rel, scripts)
            jobs.push(...sub.jobs)
            parseErrors.push(...sub.parseErrors)
            inheritedIncludes.push(...sub.inheritedIncludes)
          } else {
            inheritedIncludes.push(inc)
          }
        } else {
          inheritedIncludes.push(inc)
        }
      }
    }
  } else if (facts.ci.system === "github") {
    for (const file of facts.ci.files) {
      const text = await readText(path.join(root, file))
      if (!text) continue
      const parsed = parseGithubWorkflow(text, file, scripts)
      jobs.push(...parsed.jobs)
      parseErrors.push(...parsed.parseErrors)
    }
  }

  const [local, thresholds] = await Promise.all([
    localHookTools(root, facts, scripts),
    detectThresholds(root, scripts, jobs),
  ])

  const pkg = await readJson<{
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }>(path.join(root, "package.json"))
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies }
  const commitlintDep = Boolean(deps["@commitlint/cli"] ?? deps["commitlint"])

  return {
    local,
    ci: { system: facts.ci.system, jobs, inheritedIncludes, parseErrors },
    thresholds,
    commitlintDep,
  }
}
