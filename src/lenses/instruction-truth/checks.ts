import path from "node:path"

import type { Finding, FindingTier } from "../../engine/finding.js"
import type { ProjectFacts } from "../../core/types.js"
import { git, pathExists, readJson, readText } from "../../core/util.js"
import { parseDecisionEntries } from "../state-freshness.js"
import {
  extractCommandClaims,
  extractDecisionRefs,
  extractDocRefs,
  extractPathClaims,
} from "./claims.js"

// The command/path/doc-reference truth checks, factored so that every surface that verifies text
// against the repo — instruction files, state documents, and the task an agent is about to be
// handed — runs the SAME precision rules. Two copies of these rules would drift apart, which is
// the exact failure this tool exists to catch.

/** Everything a truth check needs from the repo, resolved once per run. */
export interface TruthEnv {
  root: string
  facts: ProjectFacts
  /** Package scripts across the root and every workspace manifest. */
  knownScripts: Set<string>
  nodeModulesInstalled: boolean
  /** A manifest exists somewhere, so a script claim is checkable even without an install. */
  manifestExists: boolean
  /** The root plus every workspace package dir — where claims are resolved. */
  bases: string[]
  /**
   * A repo-relative claim resolves in the root, any workspace package, their src/ scripts/, or
   * the directory of the file making the claim (`fromDir`) — a nested instruction file writes
   * references the way an agent reading it resolves them: against its siblings.
   */
  pathResolves(claim: string, fromDir?: string): Promise<boolean>
  /** `yarn X` / `pnpm X` may legitimately run an installed node_modules/.bin binary. */
  binResolves(name: string): Promise<boolean>
}

export async function buildTruthEnv(root: string, facts: ProjectFacts): Promise<TruthEnv> {
  // Monorepo truth: a script/path claim holds if it resolves in the ROOT or in ANY workspace
  // package — instruction files legitimately name workspace scripts bare and paths relative
  // to the package they discuss.
  const knownScripts = new Set(Object.keys(facts.commands.raw))
  for (const pkg of facts.packages) {
    const pkgJson = await readJson<{ scripts?: Record<string, string> }>(
      path.join(root, pkg.dir, "package.json"),
    )
    for (const key of Object.keys(pkgJson?.scripts ?? {})) knownScripts.add(key)
  }
  const bases = [root, ...facts.packages.map((p) => path.join(root, p.dir))]
  // STATED RULE, not an accident: existence is judged on the WORKING TREE, never the index. A
  // claim that exists on disk is true even when gitignored — the author wrote against a real
  // checkout, and a machine-local file is unverifiable, not fictional. A gitignored claim that
  // is absent is the check-ignore step in checkTextClaims: skipped and counted, never accused.
  const pathResolves = async (claim: string, fromDir?: string): Promise<boolean> => {
    for (const base of bases) {
      if (await pathExists(path.join(base, claim))) return true
      // Conventional sub-roots instruction prose is written relative to.
      if (await pathExists(path.join(base, "src", claim))) return true
      if (await pathExists(path.join(base, "scripts", claim))) return true
    }
    // Relative to the claiming file's own directory: an instruction file below the root
    // (`.claude/skills/x/SKILL.md` naming `references/kv/`) means its sibling. Only a real
    // repo-relative file carries a directory — labels like `task` reduce to "." and are skipped.
    if (fromDir && fromDir !== "." && (await pathExists(path.join(root, fromDir, claim))))
      return true
    return false
  }
  // Without an installed node_modules we cannot tell a stale script from a valid binary, so
  // unknown commands are then skipped and disclosed, never accused.
  const binResolves = async (name: string): Promise<boolean> => {
    for (const base of bases) {
      if (await pathExists(path.join(base, "node_modules", ".bin", name))) return true
    }
    return false
  }
  const nodeModulesInstalled = await pathExists(path.join(root, "node_modules"))
  // A repo with no package manifest anywhere can never install node_modules, so nothing could
  // ever satisfy a script claim there — checkable (and false) even without an install.
  const manifestExists =
    (await pathExists(path.join(root, "package.json"))) || facts.packages.length > 0
  return {
    root,
    facts,
    knownScripts,
    nodeModulesInstalled,
    manifestExists,
    bases,
    pathResolves,
    binResolves,
  }
}

/** Skip-class tallies — every class a check declines to accuse is counted, then disclosed. */
export interface ClaimCounters {
  filteredSkipped: number
  tildeSkipped: number
  /** Doc mentions whose own line says the doc deliberately does not exist here — skipped, counted. */
  absenceSkipped: number
  binaryResolved: number
  unverifiableCommands: number
  gitignoredSkipped: number
  prospectiveSkipped: number
  /** Path claims whose every mention sits beside the URL it is fetched from — another tree. */
  fetchedSkipped: number
  placeholderSkipped: number
  /** Decision references naming another record (a fleet-level ledger) — not this repo's. */
  qualifiedRefsSkipped: number
  /** Decision references with no `## D-NNN` ledger to resolve against. */
  unresolvableRefs: number
  /** Path claims whose every mention sits behind a namespace prefix (`pc:`) — another repo's. */
  namespacedSkipped: number
  /** Missing paths starting at no directory of this repo — quoted from elsewhere (task only). */
  outsideRepoSkipped: number
}

export function emptyCounters(): ClaimCounters {
  return {
    filteredSkipped: 0,
    tildeSkipped: 0,
    absenceSkipped: 0,
    binaryResolved: 0,
    unverifiableCommands: 0,
    gitignoredSkipped: 0,
    prospectiveSkipped: 0,
    fetchedSkipped: 0,
    placeholderSkipped: 0,
    qualifiedRefsSkipped: 0,
    unresolvableRefs: 0,
    namespacedSkipped: 0,
    outsideRepoSkipped: 0,
  }
}

/**
 * One thing a check looked for, and what it found. `null` = could not be checked from the repo
 * (counted and disclosed), never a guess. The honest-coverage half of a report: what was
 * examined, not only what failed.
 */
export interface ExaminedClaim {
  kind: "script" | "path" | "doc" | "decision"
  value: string
  exists: boolean | null
}

/** A piece of text making claims about the repo: an instruction file, a state doc, a task. */
export interface ClaimText {
  /** Repo-relative path, or a label such as `task` — becomes part of every finding id. */
  path: string
  text: string
}

export interface TextClaimsOptions {
  /** The lens the findings report under (`instruction-truth`, `premise`). */
  lensId: string
  /** How the text is named in a claim sentence — a file path, or "The task". */
  subject?: string
  /**
   * A missing path is `gap` for an instruction file (a dead reference among many) and `risk` for
   * a task (the task is ABOUT the path — an agent acting on it does the wrong thing).
   */
  missingPathTier: FindingTier
  maxPathFindings: number
  whyCommand?: string
  actionCommand?: string
  whyPath?: string
  actionPath?: string
  /**
   * Directories a missing path may start from and still be plausibly repo-relative — the root,
   * workspace packages, and their src/ scripts/. Supplied by the task surface (`etymd premise`)
   * only: a task quoting a path from ANOTHER repository (a clone in a scratchpad) starts where
   * no directory of this repo does, and its absence here proves nothing. Instruction files keep
   * the stricter reading — their references are written against this repo.
   */
  rootedFirstSegments?: ReadonlySet<string>
  /**
   * Read namespace-prefixed path mentions (`pc: `src/x.ts``) as another repo's tree — the task
   * surface only; instruction files keep every backticked span as a claim of this repo.
   */
  treatNamespacedPrefixes?: boolean
}

export interface TextClaimsResult {
  findings: Finding[]
  disclosures: string[]
  /** Every script and path claim the text made, found or not. */
  examined: ExaminedClaim[]
}

/**
 * Command and path claims in one text, verified against the repo. Precision over recall: every
 * class it declines to accuse is counted in `counters` for the caller to disclose.
 */
export async function checkTextClaims(
  env: TruthEnv,
  file: ClaimText,
  opts: TextClaimsOptions,
  counters: ClaimCounters,
): Promise<TextClaimsResult> {
  const findings: Finding[] = []
  const disclosures: string[] = []
  const examined: ExaminedClaim[] = []
  const subject = opts.subject ?? file.path

  // Command claims: a script the text tells agents to run must exist somewhere real.
  const { scripts: claimed, filteredSkipped } = extractCommandClaims(file.text)
  counters.filteredSkipped += filteredSkipped
  for (const [script, raw] of claimed) {
    if (env.knownScripts.has(script)) {
      examined.push({ kind: "script", value: script, exists: true })
      continue
    }
    if (await env.binResolves(script)) {
      counters.binaryResolved += 1
      examined.push({ kind: "script", value: script, exists: true })
      continue
    }
    if (!env.nodeModulesInstalled && env.manifestExists) {
      counters.unverifiableCommands += 1
      examined.push({ kind: "script", value: script, exists: null })
      continue
    }
    examined.push({ kind: "script", value: script, exists: false })
    findings.push({
      lens: opts.lensId,
      id: `${opts.lensId}/stale-command:${file.path}:${script}`,
      tier: "risk",
      claim: `${subject} tells agents to run \`${script}\` — no such script exists`,
      evidence: [`${file.path}: \`${raw}\``, "package.json scripts (root + workspaces)"],
      why:
        opts.whyCommand ??
        "An agent following this instruction runs a command that fails — or silently skips the check it was meant to run.",
      action:
        opts.actionCommand ??
        "Update the instruction to the current script name (or restore the script).",
      effort: "S",
      confidence: "high",
    })
  }

  // Path claims: a path the text points agents at must exist.
  const { paths, dirs, prospective, fetched, placeholder, namespaced } = extractPathClaims(
    file.text,
    { namespaces: opts.treatNamespacedPrefixes },
  )
  counters.prospectiveSkipped += prospective.length
  counters.fetchedSkipped += fetched.length
  counters.placeholderSkipped += placeholder.length
  counters.namespacedSkipped += namespaced.length
  // A label like `task` has no directory; a real file's dir is a resolution base (see
  // buildTruthEnv).
  const fromDir = path.dirname(file.path)
  const unresolved: string[] = []
  for (const claim of paths) {
    if (await env.pathResolves(claim, fromDir))
      examined.push({ kind: "path", value: claim, exists: true })
    else unresolved.push(claim)
  }
  // A document that names a directory and then writes paths relative to it is ordinary prose,
  // not a stale reference — and the reference usually repeats the named directory's own last
  // segment (`run state is `x/v3/` … `v3/CHECKPOINT.json``), making it relative to the named
  // directory's PARENT. Directory claims in the SAME text that themselves resolve are candidate
  // bases, tried there and under the claiming file's dir; a claim that exists under one is
  // verified, never accused. A false resolution hides a finding; a false accusation destroys
  // trust — this tool is built to prefer the first error.
  const proseBases = new Set<string>()
  for (const dirClaim of dirs) {
    if (await env.pathResolves(dirClaim, fromDir)) {
      proseBases.add(dirClaim)
      proseBases.add(path.dirname(dirClaim))
    }
  }
  const missing: string[] = []
  for (const claim of unresolved) {
    let anchored = false
    for (const base of proseBases) {
      if (await pathExists(path.join(env.root, base, claim))) anchored = true
      else if (fromDir !== "." && (await pathExists(path.join(env.root, fromDir, base, claim))))
        anchored = true
      if (anchored) break
    }
    if (anchored) examined.push({ kind: "path", value: claim, exists: true })
    else missing.push(claim)
  }
  // A gitignored claim (`.env`, local caches) is machine-local by design: absence in THIS
  // checkout does not make the text false — unverifiable, so skipped, never accused.
  // check-ignore exits non-zero when nothing matches; git() maps that to null.
  const ignoredOut = missing.length ? await git(env.root, ["check-ignore", ...missing]) : null
  const gitignored = new Set((ignoredOut ?? "").split("\n").filter(Boolean))
  // A dir-only ignore pattern (`assets/cards/`) matches the bare token only when the
  // directory exists on disk — git decides "is a directory" by existence — so fresh
  // checkouts miss the skip above. The slash-terminated probe matches regardless of disk
  // state (git echoes it slash-terminated, trimmed back to the claim). Miss path only.
  const unproven = missing.filter((claim) => !gitignored.has(claim))
  if (unproven.length) {
    const dirOut = await git(env.root, ["check-ignore", ...unproven.map((claim) => `${claim}/`)])
    for (const line of (dirOut ?? "").split("\n").filter(Boolean))
      gitignored.add(line.replace(/\/$/, ""))
  }
  let pathFindings = 0
  for (const claim of missing) {
    // Outside this repo (task surface only): a path that starts at no directory the repo has
    // is quoted from elsewhere, and "missing here" would be a false accusation.
    if (opts.rootedFirstSegments && !opts.rootedFirstSegments.has(claim.split("/")[0] ?? claim)) {
      counters.outsideRepoSkipped += 1
      examined.push({ kind: "path", value: claim, exists: null })
      continue
    }
    if (gitignored.has(claim)) {
      counters.gitignoredSkipped += 1
      examined.push({ kind: "path", value: claim, exists: null })
      continue
    }
    examined.push({ kind: "path", value: claim, exists: false })
    // Findings are capped, the examined list is not — the brief still names every miss.
    if (pathFindings >= opts.maxPathFindings) {
      if (pathFindings === opts.maxPathFindings) {
        disclosures.push(
          `${file.path}: more than ${opts.maxPathFindings} missing-path claims — truncated.`,
        )
        pathFindings += 1
      }
      continue
    }
    pathFindings += 1
    findings.push({
      lens: opts.lensId,
      id: `${opts.lensId}/stale-path:${file.path}:${claim}`,
      tier: opts.missingPathTier,
      claim: `${subject} references \`${claim}\` — it does not exist in the repo`,
      evidence: [file.path, `missing: ${claim}`],
      why:
        opts.whyPath ??
        "Agents navigate by these references; a dead path wastes a lookup and erodes trust in the rest of the file.",
      action: opts.actionPath ?? "Fix or remove the reference.",
      effort: "S",
      confidence: "medium",
    })
  }

  return { findings, disclosures, examined }
}

export interface RefsResult {
  findings: Finding[]
  examined: ExaminedClaim[]
}

/** Cross-references to well-known docs (AGENTS.md, CLAUDE.md, …) must resolve to real files. */
export async function checkDocRefs(
  env: TruthEnv,
  file: ClaimText,
  lensId: string,
  counters: ClaimCounters,
  subject = file.path,
): Promise<RefsResult> {
  const findings: Finding[] = []
  const examined: ExaminedClaim[] = []
  const { refs, tildeSkipped, absenceSkipped } = extractDocRefs(file.text)
  counters.tildeSkipped += tildeSkipped
  counters.absenceSkipped += absenceSkipped
  for (const ref of refs) {
    const exists = await pathExists(path.join(env.root, ref))
    examined.push({ kind: "doc", value: ref, exists })
    if (exists) continue
    findings.push({
      lens: lensId,
      id: `${lensId}/dangling-ref:${file.path}:${ref}`,
      tier: "gap",
      claim: `${subject} references ${ref} — no such file exists`,
      evidence: [file.path, `missing: ${ref}`],
      why: "The pointer chain agents follow breaks at a file they can never read.",
      action: `Create ${ref} or remove the reference.`,
      effort: "S",
      confidence: "high",
    })
  }
  return { findings, examined }
}

/** The repo's own decision record: every `## D-NNN` id, and which files carried them. */
export interface DecisionLedger {
  /** Null when no decisions file with parseable `## D-NNN` entries exists. */
  ids: Set<number> | null
  sources: string[]
}

export async function loadDecisionLedger(
  root: string,
  facts: ProjectFacts,
): Promise<DecisionLedger> {
  let ids: Set<number> | null = null
  const sources: string[] = []
  for (const artifact of facts.artifacts) {
    if (artifact.kind !== "decisions" || !artifact.exists) continue
    // Directory conventions read as null — they carry no parseable `## D-NNN` ids.
    const text = await readText(path.join(root, artifact.path))
    if (text === null) continue
    const entries = parseDecisionEntries(text)
    if (!entries.length) continue
    ids ??= new Set()
    for (const entry of entries) ids.add(entry.num)
    sources.push(artifact.path)
  }
  return { ids, sources }
}

export interface DecisionRefsOptions {
  lensId: string
  /** How the text is named in a claim sentence — a file path, or "The task". */
  subject?: string
  why?: string
  action?: string
}

/**
 * `D-NNN` references in one text, resolved against the repo's own decision record. A citation
 * the record cannot back is stale in a way age cannot reveal. Qualified refs (another record's)
 * and refs with no ledger to resolve against are counted, never accused.
 */
export function checkDecisionRefs(
  file: ClaimText,
  ledger: DecisionLedger,
  opts: DecisionRefsOptions,
  counters: ClaimCounters,
): RefsResult {
  const findings: Finding[] = []
  const examined: ExaminedClaim[] = []
  const subject = opts.subject ?? file.path
  const { refs, qualifiedSkipped } = extractDecisionRefs(file.text)
  counters.qualifiedRefsSkipped += qualifiedSkipped
  if (!refs.size) return { findings, examined }
  if (!ledger.ids) {
    counters.unresolvableRefs += refs.size
    for (const asWritten of refs.values()) {
      examined.push({ kind: "decision", value: asWritten, exists: null })
    }
    return { findings, examined }
  }
  for (const [num, asWritten] of refs) {
    const exists = ledger.ids.has(num)
    examined.push({ kind: "decision", value: asWritten, exists })
    if (exists) continue
    findings.push({
      lens: opts.lensId,
      id: `${opts.lensId}/dead-decision-ref:${file.path}:${asWritten}`,
      tier: "gap",
      claim: `${subject} cites ${asWritten} — no such entry exists in ${ledger.sources.join(", ")}`,
      evidence: [file.path, `${ledger.sources.join(", ")}: no ${asWritten} entry`],
      why:
        opts.why ??
        "A state doc is read as ground truth on return; a citation the decision record cannot back sends readers to a ruling that was never written.",
      action: opts.action ?? "Fix the reference — or record the missing decision.",
      effort: "S",
      confidence: "medium",
    })
  }
  return { findings, examined }
}
