import { promises as fs } from "node:fs"
import path from "node:path"

import { ETYMD_DIR } from "../core/facts.js"
import { scanProject } from "../core/scan.js"
import { pathExists } from "../core/util.js"
import {
  buildTruthEnv,
  checkDecisionRefs,
  checkDocRefs,
  checkTextClaims,
  emptyCounters,
  loadDecisionLedger,
  type ExaminedClaim,
  type TruthEnv,
} from "../lenses/instruction-truth/checks.js"
import {
  HOSTNAME_RE,
  KNOWN_EXTENSIONS,
  NAMESPACE_IDENT,
  NAMESPACE_STOP,
  PATH_TOKEN_RE,
} from "../lenses/instruction-truth/claims.js"
import { rankFindings, type Finding } from "./finding.js"

// `etymd premise` — the task an agent is about to be handed is an instruction too (decision 010).
// Before anything acts on it, the things it NAMES are checked against the repo with the same
// precision rules instruction files get — except that a task routinely QUOTES other people's
// trees (a scratchpad clone, a legend-prefixed token), so a path is only accused of missing when
// it is plausibly repo-relative: no namespace prefix on the mention, and a first segment that
// starts where a directory of this repo does. The premises only an agent can verify — that the
// named things are the ones meant, that the mechanism the task assumes actually runs, that the
// state it assumes holds — are handed over in a brief, never guessed at here. Reading files is
// the whole of what this command does (decision 005: anything beyond that is out of scope by
// construction).

export const PREMISE_LENS = "premise"
export const PREMISE_BRIEF_FILE = path.join(ETYMD_DIR, "premise-brief.md")
const TASK_LABEL = "task"
const MAX_PATH_FINDINGS = 15

/** One thing the task named, found or not — the checked half of the brief. */
export type PremiseEntity = ExaminedClaim

export interface PremiseResult {
  /** The `--json` schema version. */
  schema: "premise/1"
  task: string
  /** Where the task came from: `argument`, `stdin`, or the file path it was read from. */
  source: string
  /** The project name from the reckoning. */
  name: string
  findings: Finding[]
  disclosures: string[]
  /** Everything the task named that etymd could look for — found or not. */
  entities: PremiseEntity[]
  brief: string
  /** Repo-relative path the brief was written to, or `null` when the repo never opted in. */
  briefPath: string | null
}

export interface PremiseOptions {
  root: string
  task: string
  source?: string
  /** Write the brief under `.etymd/` when that directory exists (default true). */
  writeBrief?: boolean
}

/** What the prose promotion declined to read as a claim — counted, then disclosed. */
export interface PromotionSkips {
  /** `pnpm X` / `yarn X` / `bun X` in prose without `run` — a phrase as often as an invocation. */
  bareInvocations: number
  /** `… run the`, `… run X` — a function word or a one-letter stand-in where a script would be. */
  proseScripts: number
  /** `github.com/org/repo/…` — a scheme-less URL, not a repo path. */
  hostnameLike: number
  /** `input/output/` — a slash-joined phrase whose first segment is no directory here. */
  unrootedDirs: number
  /** `pc:src/x.ts`, `lk: src/x.ts` — a namespace-prefixed mention of ANOTHER repo's tree. */
  namespaced: number
}

export interface PromotionContext {
  /** Directory names that exist at the root, in a workspace package, or under their src/ scripts/. */
  rootedDirs: ReadonlySet<string>
}

export interface PromotedText {
  text: string
  skips: PromotionSkips
}

const CODE_SPAN_RE = /(```[\s\S]*?```|`[^`\n]+`)/g
// In prose only `<pm> run <script>` (and the `npm test` / `npm start` shorthands) reads as an
// invocation. A bare `pnpm X` / `yarn X` / `bun X` is a phrase as often as a command ("the pnpm
// workspace", "bun will …"), so it stays prose unless the author backticked it — the extractor's
// bare form is for code spans, where the backtick itself was the author's signal.
const RUN_RE = /\b(?:pnpm|yarn|npm|bun)\s+run\s+(?!-)([A-Za-z0-9:._-]+)|\bnpm\s+(?:test|start)\b/g
const BARE_PM_RE = /\b(?:pnpm|yarn|bun)\s+(?!run\b)(?!-)[A-Za-z0-9:._-]+/g
// Function words that follow "run" in prose ("npm run the tests") — never script names.
const STOP_WORDS = new Set(
  (
    "a an the this that these those it its them all any both each every some your our my their " +
    "and or but to in on at of for with from by as is are was were be will would can could should " +
    "may might must do does did not no so if then than when where which who what how also again " +
    "now first once twice after before via into over only just too very"
  ).split(" "),
)
const WRAP_RE = /^([([{"']*)(.*?)([.,;:!?)\]}"']*)$/
const TRAIL_RE = /[.,;:!?)\]}"']*$/
// A first segment shaped like a host is a scheme-dropped URL, not a repo path — HOSTNAME_RE in
// claims.ts is the one definition; the extractor applies it to backticked tokens too.

/**
 * People do not backtick paths in a prompt. Promote the bare mentions the claim extractors would
 * otherwise treat as prose — `src/x.ts`, `docs/design/`, `npm run lint` — into code spans, leaving
 * anything already in a code span untouched. Precision over recall: only what an instruction
 * file's extractor would accept is promoted, and every class left as prose is counted.
 */
export function promoteBareTokens(text: string, ctx: PromotionContext): PromotedText {
  const skips: PromotionSkips = {
    bareInvocations: 0,
    proseScripts: 0,
    hostnameLike: 0,
    unrootedDirs: 0,
    namespaced: 0,
  }
  const promoted = text
    .split(CODE_SPAN_RE)
    .map((segment, i) => (i % 2 === 1 ? segment : promoteProse(segment, ctx, skips)))
    .join("")
  return { text: promoted, skips }
}

function promoteProse(segment: string, ctx: PromotionContext, skips: PromotionSkips): string {
  skips.bareInvocations += segment.match(BARE_PM_RE)?.length ?? 0
  const withCommands = segment.replace(RUN_RE, (m, script?: string) => {
    // A sentence-ending stop is not part of the script name: `npm run build.` names `build`.
    const trail = TRAIL_RE.exec(m)?.[0] ?? ""
    const core = trail ? m.slice(0, -trail.length) : m
    if (script !== undefined) {
      const name = script.replace(TRAIL_RE, "")
      if (name.length < 2 || STOP_WORDS.has(name.toLowerCase())) {
        skips.proseScripts += 1
        return m
      }
    }
    return `\`${core}\`${trail}`
  })
  // Token-wise with one token of lookback: a legend prefix (`pc:`) reaches the path AFTER it.
  const parts = withCommands.split(/(\s+)/)
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = promoteToken(parts[i] as string, i >= 2 ? (parts[i - 2] as string) : "", ctx, skips)
  }
  return parts.join("")
}

// The namespace label on a path mention — attached to it (`pc:src/x.ts`) or in the previous
// token (`pc: src/x.ts`). Prose introducers ("note:", "see:") are not namespaces (claims.ts).
function namespaceOf(core: string, prev: string): string | null {
  const ns =
    new RegExp(`^(${NAMESPACE_IDENT}):`).exec(core)?.[1] ??
    new RegExp(`^(${NAMESPACE_IDENT}):$`).exec(prev)?.[1]
  return ns && !NAMESPACE_STOP.has(ns.toLowerCase()) ? ns : null
}

function promoteToken(
  token: string,
  prev: string,
  ctx: PromotionContext,
  skips: PromotionSkips,
): string {
  const m = WRAP_RE.exec(token)
  if (!m) return token
  const [, lead = "", core = "", trail = ""] = m
  if (!core || core.includes("://")) return token
  const namespace = namespaceOf(core, prev)
  const body =
    namespace && core.startsWith(`${namespace}:`) ? core.slice(namespace.length + 1) : core
  if (!PATH_TOKEN_RE.test(body)) return token
  const first = body.slice(0, body.indexOf("/"))
  const hostSuffix = HOSTNAME_RE.exec(first)?.[1]?.toLowerCase()
  if (hostSuffix && !KNOWN_EXTENSIONS.has(hostSuffix)) {
    skips.hostnameLike += 1
    return token
  }
  if (body.endsWith("/")) {
    // A directory claim in prose is only a claim when it starts where a real directory does;
    // `input/output/` in a sentence is a slash-joined phrase, and prose is full of them.
    if (!ctx.rootedDirs.has(first)) {
      skips.unrootedDirs += 1
      return token
    }
  } else {
    // The extractor reads a file claim only with a recognized extension; `and/or` stays prose.
    const ext = body.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1]
    if (!ext || !KNOWN_EXTENSIONS.has(ext)) return token
  }
  if (namespace) {
    skips.namespaced += 1
    return token
  }
  return `${lead}\`${body}\`${trail}`
}

/** Directory names a prose dir claim may start with — mirrors where `pathResolves` looks. */
async function listRootedDirs(env: TruthEnv): Promise<Set<string>> {
  const dirs = new Set<string>()
  for (const base of env.bases) {
    for (const sub of ["", "src", "scripts"]) {
      const entries = await fs
        .readdir(path.join(base, sub), { withFileTypes: true })
        .catch(() => [])
      for (const entry of entries) if (entry.isDirectory()) dirs.add(entry.name)
    }
  }
  return dirs
}

export async function runPremise(opts: PremiseOptions): Promise<PremiseResult> {
  const root = opts.root
  const task = opts.task.trim()
  const facts = await scanProject(root)
  const env = await buildTruthEnv(root, facts)
  const counters = emptyCounters()
  // One rooting notion for both halves: where prose dir claims may start, and where a missing
  // path's first segment must start to be plausibly repo-relative at all.
  const rootedDirs = await listRootedDirs(env)
  const promoted = promoteBareTokens(task, { rootedDirs })
  const text = { path: TASK_LABEL, text: promoted.text }

  const findings: Finding[] = []
  const disclosures: string[] = []
  const entities: PremiseEntity[] = []

  const claims = await checkTextClaims(
    env,
    text,
    {
      lensId: PREMISE_LENS,
      subject: "The task",
      missingPathTier: "risk",
      maxPathFindings: MAX_PATH_FINDINGS,
      rootedFirstSegments: rootedDirs,
      treatNamespacedPrefixes: true,
      whyCommand:
        "The task is built on a command that does not exist — an agent will run it and fail, or quietly substitute something else and report success.",
      actionCommand: "Fix the task before handing it over: name the real script, or restore it.",
      whyPath:
        "The task is ABOUT this path. Acting on it means editing, testing, or reasoning about something that is not there — the wrong problem, solved precisely.",
      actionPath: "Find where the behaviour actually lives and rewrite the task to name it.",
    },
    counters,
  )
  findings.push(...claims.findings)
  disclosures.push(...claims.disclosures)
  entities.push(...claims.examined)

  const docs = await checkDocRefs(env, text, PREMISE_LENS, counters, "The task")
  findings.push(...docs.findings)
  entities.push(...docs.examined)

  // Decision references: a task citing a ruling the record never wrote presupposes a decision
  // that does not exist.
  const ledger = await loadDecisionLedger(root, facts)
  const decisions = checkDecisionRefs(
    text,
    ledger,
    {
      lensId: PREMISE_LENS,
      subject: "The task",
      why: "The task presupposes a ruling that was never recorded; an agent will act on a decision nobody made.",
      action: "Point the task at the entry that exists — or record the missing decision first.",
    },
    counters,
  )
  findings.push(...decisions.findings)
  entities.push(...decisions.examined)

  // Honest coverage — every class not checked is named, never silently dropped.
  if (!entities.length) {
    disclosures.push(
      "The task names no path with a directory, no package script, no well-known doc, and no decision id — nothing etymd can check by reading the repo. Everything it presupposes is in the brief.",
    )
  }
  disclosures.push(
    "In prose, a path needs a directory and a recognized extension (a directory claim needs a trailing slash and a first segment that exists here), and a script needs the `run` form (`npm run X`, `pnpm run X` …) or the `npm test` / `npm start` shorthands; anything backticked is read exactly as an instruction file would be. A bare file name (a lone `config.ts`) is prose.",
  )
  const { skips } = promoted
  if (skips.bareInvocations) {
    disclosures.push(
      `${skips.bareInvocations} bare \`pnpm X\` / \`yarn X\` / \`bun X\` mention(s) in prose were not read as scripts — in a sentence that shape is a phrase as often as an invocation; write \`… run X\` or backtick it to have it checked.`,
    )
  }
  if (skips.proseScripts) {
    disclosures.push(
      `${skips.proseScripts} \`… run X\` mention(s) put a function word or a one-letter stand-in where a script name would be; read as prose, skipped.`,
    )
  }
  if (skips.hostnameLike) {
    disclosures.push(
      `${skips.hostnameLike} slash token(s) start with a host name (e.g. \`github.com/…\`) — a URL, not a repo path; skipped.`,
    )
  }
  if (skips.unrootedDirs) {
    disclosures.push(
      `${skips.unrootedDirs} slash-joined phrase(s) ending in \`/\` start with no directory that exists here (e.g. \`input/output/\`) — read as prose; skipped, not flagged. Backtick one to have it checked.`,
    )
  }
  if (skips.namespaced) {
    disclosures.push(
      `${skips.namespaced} path mention(s) in prose carry a namespace prefix (\`pc:src/x.ts\`, \`lk: src/x.ts\`) — another repo's tree, never this one; skipped, not flagged.`,
    )
  }
  if (counters.namespacedSkipped) {
    disclosures.push(
      `${counters.namespacedSkipped} backticked path mention(s) sit directly after a namespace prefix (\`pc: \`src/x.ts\`\`) — another repo's tree, not this one; skipped, not flagged.`,
    )
  }
  if (counters.outsideRepoSkipped) {
    disclosures.push(
      `${counters.outsideRepoSkipped} path(s) the task names start at no directory of this repo — typical of a path quoted from another repository or a scratchpad clone; outside this repo, not missing here. Skipped, not flagged.`,
    )
  }
  if (counters.unverifiableCommands) {
    disclosures.push(
      `node_modules is not installed — ${counters.unverifiableCommands} command(s) matching no package script could not be checked against installed binaries; skipped, not flagged.`,
    )
  }
  if (counters.binaryResolved) {
    disclosures.push(
      `${counters.binaryResolved} command(s) resolve to installed binaries (node_modules/.bin), not package scripts — treated as true.`,
    )
  }
  if (counters.gitignoredSkipped) {
    disclosures.push(
      `${counters.gitignoredSkipped} missing path(s) are gitignored (machine-local) — existence is not verifiable from the repo; skipped, not flagged.`,
    )
  }
  if (counters.prospectiveSkipped) {
    disclosures.push(
      `${counters.prospectiveSkipped} path(s) sit in create-this prose (the task says to create them) — forward-looking, not missing; skipped.`,
    )
  }
  if (counters.fetchedSkipped) {
    disclosures.push(
      `${counters.fetchedSkipped} path(s) are named beside the URL they are fetched from — another tree, not this repo; skipped, not flagged.`,
    )
  }
  if (counters.placeholderSkipped) {
    disclosures.push(
      `${counters.placeholderSkipped} path(s) are naming stand-ins (e.g. \`my-feature\`) rather than real references; skipped.`,
    )
  }
  if (counters.filteredSkipped) {
    disclosures.push(
      `${counters.filteredSkipped} workspace-filtered command(s) (\`--filter\`, \`-C\` …) were not resolved; skipped.`,
    )
  }
  if (counters.tildeSkipped) {
    disclosures.push(
      `${counters.tildeSkipped} well-known doc mention(s) sit inside \`~/\` home paths (e.g. \`~/.claude/CLAUDE.md\`) — machine-global files, not this repo's; skipped, not flagged.`,
    )
  }
  if (counters.absenceSkipped) {
    disclosures.push(
      `${counters.absenceSkipped} well-known doc mention(s) name the doc only to say it deliberately does not exist here (create-this or absence prose) — skipped, not flagged.`,
    )
  }
  if (counters.qualifiedRefsSkipped) {
    disclosures.push(
      `${counters.qualifiedRefsSkipped} decision reference(s) name another record — not this repo's; skipped.`,
    )
  }
  if (counters.unresolvableRefs) {
    disclosures.push(
      `${counters.unresolvableRefs} decision reference(s) could not be resolved — no decisions file with \`## D-NNN\` entries; skipped, not flagged.`,
    )
  }
  disclosures.push(
    "What the task PRESUPPOSES — that the named things are the ones meant, that the mechanism it assumes actually runs, that the state it assumes holds — cannot be checked by reading files. The brief hands those to the agent.",
  )
  disclosures.push("Task findings are not remembered between runs — no ledger is written.")

  const ranked = rankFindings(findings)
  const brief = renderBrief(task, ranked, entities)

  let briefPath: string | null = null
  if (opts.writeBrief !== false && (await pathExists(path.join(root, ETYMD_DIR)))) {
    // A repo that never opted in (`etymd init`) takes zero writes; the brief goes to stdout.
    await fs.writeFile(path.join(root, PREMISE_BRIEF_FILE), brief, "utf8")
    briefPath = PREMISE_BRIEF_FILE
  }

  return {
    schema: "premise/1",
    task,
    source: opts.source ?? "argument",
    name: facts.name,
    findings: ranked,
    disclosures,
    entities,
    brief,
    briefPath,
  }
}

function mark(exists: boolean | null): string {
  return exists === null ? "?" : exists ? "✓" : "✗"
}

function kindLabel(kind: PremiseEntity["kind"]): string {
  return kind === "script" ? "script " : kind === "decision" ? "decision " : ""
}

/**
 * The half of the premise check only an agent can do, written as a brief it reads before acting.
 * Deterministic: it lists what etymd verified and hands over the three questions reading files
 * cannot answer. It never speculates about what the task "really" means.
 */
export function renderBrief(task: string, findings: Finding[], entities: PremiseEntity[]): string {
  // The heading is one line whatever the task's shape — a multi-line plan would otherwise put
  // its own markdown (a fence opener, a list) inside the H1.
  const oneLine = task.replace(/\s+/g, " ").trim()
  const title = oneLine.length > 100 ? `${oneLine.slice(0, 97)}…` : oneLine
  const checked = entities.length
    ? entities
        .map(
          (e) =>
            `- ${mark(e.exists)} ${kindLabel(e.kind)}\`${e.value}\`${
              e.exists === null
                ? " — could not be checked"
                : e.exists
                  ? " — exists"
                  : " — missing (see the finding)"
            }`,
        )
        .join("\n")
    : "- (nothing the task names could be checked by reading the repo)"
  const failed = findings.filter((f) => f.tier === "risk")
  const failedLine = failed.length
    ? `\n**${failed.length} premise(s) already failed** — the task names things that do not exist. Resolve those before anything below.\n`
    : ""

  return `# Premise brief — ${title}

The task, verbatim:

> ${task.replace(/\n/g, "\n> ")}

etymd checked what the task names against the repo. What it could NOT check is listed under
"only you can verify"; check those before acting, and if one fails, say so first — everything
else is downstream of it.
${failedLine}
## What the task names, and whether it exists

${checked}

## Premises only you can verify

1. **The named things are the ones MEANT.** A file that exists can still be the wrong file, and a
   script that exists can still not be the one the task has in mind. Confirm each is where the
   behaviour actually lives before touching it.
2. **The mechanism the task assumes is working.** A task shaped like "make X faster / less flaky /
   fresh after Y" assumes X and Y already do what it says. Run them once. If the assumed
   mechanism does not run, the task is downstream of a defect it does not mention.
3. **The state the task assumes holds.** Read it; do not trust the task's description of it.

## If a premise fails

Report it first, in one line: what the task presupposes, and what you found instead. Do not
answer the original task as if the premise held — a wrong problem solved precisely is still the
wrong problem.
`
}
