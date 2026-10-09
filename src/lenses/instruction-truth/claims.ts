import { promises as fs } from "node:fs"
import path from "node:path"

import type { InstructionScope } from "../../core/config.js"
import { expandFileGlobs } from "../../core/detect.js"
import type { ProjectFacts } from "../../core/types.js"
import { isDirectory, matchesAnyGlob, normalizeRelPath, readText } from "../../core/util.js"

// Claim extraction: what an instruction file ASSERTS about the repo. Precision beats recall
// here — a false "your file is lying" costs more trust than a missed lie, so every heuristic
// filters aggressively and the lens discloses what it skipped.

export interface InstructionFile {
  /** Repo-relative path. */
  path: string
  text: string
}

export interface InstructionFileSet {
  /** The files the lens will actually audit. */
  files: InstructionFile[]
  /** Auto-detected files dropped by `instructions.exclude` — counted so scoping stays visible. */
  excluded: string[]
  /** Files pulled in by `instructions.include` that detection would have missed. */
  included: string[]
}

/**
 * Every agent-facing instruction file the scan knows how to find, then narrowed by the repo's
 * optional scope: auto-detected ∪ `include`, minus `exclude`. The excluded set is returned rather
 * than discarded — a scoped audit that quietly looked clean would be the exact dishonesty this
 * tool exists to catch.
 */
export async function listInstructionFiles(
  root: string,
  facts: ProjectFacts,
  scope?: InstructionScope,
): Promise<InstructionFileSet> {
  const files: InstructionFile[] = []
  const add = async (rel: string) => {
    const text = await readText(path.join(root, rel))
    if (text !== null) files.push({ path: normalizeRelPath(rel), text })
  }

  const singleFileArtifacts = [
    "agents",
    "claude",
    "gemini",
    "copilot",
    "cursorrules",
    "cline",
    "windsurf",
  ]
  for (const id of singleFileArtifacts) {
    const artifact = facts.artifacts.find((a) => a.id === id)
    if (artifact?.exists) await add(artifact.path)
  }

  const rulesDir = path.join(root, ".cursor", "rules")
  if (await isDirectory(rulesDir)) {
    try {
      for (const entry of await fs.readdir(rulesDir)) {
        if (entry.endsWith(".md") || entry.endsWith(".mdc"))
          await add(path.join(".cursor/rules", entry))
      }
    } catch {
      /* ignore */
    }
  }

  const skillsDir = path.join(root, ".claude", "skills")
  if (await isDirectory(skillsDir)) {
    try {
      for (const entry of await fs.readdir(skillsDir)) {
        const skill = path.join(".claude/skills", entry, "SKILL.md")
        await add(skill)
      }
    } catch {
      /* ignore */
    }
  }

  const detected = new Set(files.map((f) => f.path))
  const included: string[] = []
  for (const rel of await expandFileGlobs(root, scope?.include ?? [])) {
    if (detected.has(rel)) continue
    const before = files.length
    await add(rel)
    if (files.length > before) included.push(rel)
  }

  const exclude = scope?.exclude ?? []
  if (!exclude.length) return { files, excluded: [], included }

  const kept: InstructionFile[] = []
  const excluded: string[] = []
  for (const file of files) {
    if (matchesAnyGlob(file.path, exclude)) excluded.push(file.path)
    else kept.push(file)
  }
  return { files: kept, excluded, included }
}

/**
 * Every state document the scan detected (kind "state"). State docs are the first file read on
 * returning to a project — the highest-leverage place for a false claim to sit — so they get the
 * same command/path truth checks as instruction files, plus decision-reference resolution.
 */
export async function listStateDocuments(
  root: string,
  facts: ProjectFacts,
): Promise<InstructionFile[]> {
  const docs: InstructionFile[] = []
  for (const artifact of facts.artifacts) {
    if (artifact.kind !== "state" || !artifact.exists) continue
    const text = await readText(path.join(root, artifact.path))
    if (text !== null) docs.push({ path: normalizeRelPath(artifact.path), text })
  }
  return docs
}

/** Inline code spans + fenced-code lines — where command and path claims live. */
export function extractCodeTokens(text: string): string[] {
  const tokens: string[] = []
  for (const m of text.matchAll(/`([^`\n]+)`/g)) tokens.push((m[1] as string).trim())
  for (const block of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    for (const line of (block[1] as string).split("\n")) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith("#")) tokens.push(trimmed)
    }
  }
  return tokens
}

export interface CommandClaims {
  /** Script names the file claims exist (deduped). */
  scripts: Map<string, string>
  /** Workspace-filtered invocations we deliberately did not validate. */
  filteredSkipped: number
}

// Package-manager built-ins that are not project scripts.
const PM_BUILTINS = new Set([
  "install",
  "i",
  "add",
  "remove",
  "rm",
  "up",
  "update",
  "upgrade",
  "dlx",
  "exec",
  "create",
  "init",
  "link",
  "unlink",
  "publish",
  "pack",
  "audit",
  "outdated",
  "why",
  "list",
  "ls",
  "view",
  "info",
  "config",
  "store",
  "import",
  "rebuild",
  "prune",
  "setup",
  "env",
  "bin",
  "root",
  "licenses",
  "patch",
  "approve-builds",
  "workspaces",
  "workspace",
  "cache",
  "version",
  "help",
])

/** Script names referenced via `pnpm X` / `yarn X` / `npm run X` / `bun run X` / `npm test`. */
export function extractCommandClaims(text: string): CommandClaims {
  const scripts = new Map<string, string>()
  let filteredSkipped = 0
  for (const token of extractCodeTokens(text)) {
    // Only command-position invocations count: token start or after a shell chain. A pm name
    // mentioned mid-phrase (`for t in pnpm node psql`) is prose, not an instruction.
    for (const m of token.matchAll(
      /(?:^|&&\s*|\|\|\s*|;\s*|\|\s*|\$\s+|\(\s*)(pnpm|yarn|npm|bun)\s+(?:(run)\s+)?(-{0,2}[A-Za-z0-9:._@/[\]-]+)/g,
    )) {
      const pm = m[1] as string
      const ranExplicit = Boolean(m[2])
      const arg = m[3] as string
      if (arg.startsWith("-")) {
        // A flagged invocation (--filter, -r, -C …) may target a workspace script we cannot
        // resolve from the root manifest — skipped, counted, disclosed.
        filteredSkipped += 1
        continue
      }
      // `npm X` only refers to a script via `npm run X` or the test/start shorthands.
      if (pm === "npm" && !ranExplicit && arg !== "test" && arg !== "start") continue
      if ((pm === "bun" || pm === "yarn" || pm === "pnpm") && !ranExplicit && PM_BUILTINS.has(arg))
        continue
      if (ranExplicit && PM_BUILTINS.has(arg)) continue
      scripts.set(arg, token)
    }
  }
  return { scripts, filteredSkipped }
}

export const PATH_TOKEN_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.$-]+)+\/?$/

// A first segment shaped like a host (`example.com`, `api.example.com`) — a URL with its
// scheme dropped, not a repo path. A dotted first segment whose suffix is a file extension
// (`data.py/…`) stays a path. One definition, two callers (the extractor below and the task
// surface's prose promotion) — a copy would let the two surfaces drift, which is the exact
// failure this tool exists to catch.
export const HOSTNAME_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.([a-z]{2,})$/i

// A file claim needs a RECOGNIZED extension, not just a dot suffix: Better-Auth hook notation
// (`create/update.after`) reads as slash-joined prose with a dotted stage, and any bare
// "ends in .xyz" rule accuses it. Unknown extensions fall back to prose — precision over recall.
export const KNOWN_EXTENSIONS = new Set([
  ...(
    "ts tsx cts mts js jsx cjs mjs json jsonc json5 md mdx mdc yml yaml toml ini cfg conf " +
    "env sh bash zsh fish ps1 bat cmd css scss sass less html htm xml svg sql prisma graphql " +
    "gql proto py rb rs go java kt kts swift c h cc cpp hpp cs php vue svelte astro txt log " +
    "lock csv tsv png jpg jpeg gif webp ico avif woff woff2 ttf otf wasm map pem key crt tf " +
    "tfvars example sample local snap ejs hbs pug"
  ).split(" "),
])

// A path the surrounding prose tells the agent to CREATE is not a stale reference — it is a
// forward-looking instruction, and the repo is right to lack it. Seen in real audits
// (migration quarantine dirs, generated outputs), the second new skip class after
// Better-Auth dotted notation.
const CREATION_CONTEXT_RE =
  /\b(?:(?:re)?creat(?:e|es|ed|ing)|generat(?:e|es|ed|ing)|scaffold(?:s|ed|ing)?|quarantin(?:e|es|ed|ing)|(?:writ(?:e|es|ten|ing)|output(?:s|ted)?|emit(?:s|ted|ting)?|sav(?:e|es|ed|ing)|mov(?:e|es|ed|ing)|copy|copi(?:es|ed))\s+(?:it\s+|them\s+)?(?:to|into)|new\s+(?:file|directory|folder)|will\s+(?:be\s+)?(?:created|generated|written)|add(?:s|ed|ing)?\s+(?:a|the)\s+new)\b/i

// A path named beside the URL it is FETCHED from ("Fetch `docs/x.md` from `https://…`") points
// into another tree: the reference may be real, but not in this repo — the same principle the
// task surface applies to quoted foreign paths. A fetch verb alone is not enough; the URL must
// sit on the same context line, or an innocent mention beside an unrelated link would be
// skipped. Grow the verb list from corpus finds — an unlisted verb costs a false accusation,
// never a false skip.
const FETCH_CONTEXT_RE =
  /\b(?:fetch(?:es|ed|ing)?|pull(?:s|ed|ing)?|clone(?:s|d)?|download(?:s|ed|ing)?)\b/i
const EXTERNAL_URL_RE = /https?:\/\/|\bwww\./i

// Naming stand-ins an instruction file uses to describe a shape, not to point at a real path.
const PLACEHOLDER_SEGMENTS = new Set(["placeholder", "foo", "bar", "baz", "qux"])
const PLACEHOLDER_PREFIX_RE = /^(?:my|your)-/i

function isPlaceholderClaim(token: string): boolean {
  return token
    .split("/")
    .some((seg) => PLACEHOLDER_PREFIX_RE.test(seg) || PLACEHOLDER_SEGMENTS.has(seg.toLowerCase()))
}

// A namespace prefix (`pc:`, `lk:`, a repo shorthand) directly before a path mention labels it
// as ANOTHER repo's tree — a legend token in a multi-repo prompt, not a reference into this
// repo. Such a mention is skipped and counted, never resolved against the cwd — on the task
// surface only, where quoting foreign trees is routine. Prose introducers that merely happen to
// precede a path ("note:", "facts:") are not namespaces; the stop-list is grown from corpus
// finds, and an unlisted one costs a disclosed skip, never a false accusation.
export const NAMESPACE_IDENT = "[A-Za-z][A-Za-z0-9-]{0,15}"
export const NAMESPACE_STOP = new Set(
  (
    "note notes see warning caution caveat caveats example examples ex eg ie nb ps re per " +
    "file files path paths hint tip tips todo fixme step steps rule rules ref refs " +
    "fact facts output outputs input inputs result results summary status overview " +
    "next prev then thus hence plus goal goals spec specs context"
  ).split(" "),
)

function isNamespace(ident: string | undefined): boolean {
  return Boolean(ident) && !NAMESPACE_STOP.has((ident as string).toLowerCase())
}

/**
 * The prose around one occurrence: its own line, plus the lead-in line when the claim sits in a
 * list item or table row ("Files this creates:" followed by bulleted paths is the common shape).
 */
function claimContext(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1
  const endRaw = text.indexOf("\n", index)
  const end = endRaw === -1 ? text.length : endRaw
  const line = text.slice(start, end)
  if (!/^\s*(?:[-*+]|\d+[.)]|\|)/.test(line)) return line

  // Walk back to the nearest non-empty, non-list line — the sentence the list hangs off.
  let cursor = start
  while (cursor > 0) {
    const prevEnd = cursor - 1
    const prevStart = text.lastIndexOf("\n", prevEnd - 1) + 1
    const prev = text.slice(prevStart, prevEnd)
    cursor = prevStart
    if (!prev.trim()) continue
    if (/^\s*(?:[-*+]|\d+[.)]|\|)/.test(prev)) continue
    return `${prev}\n${line}`
  }
  return line
}

export interface PathClaims {
  /** Claims to verify against the repo. */
  paths: string[]
  /** Slash-terminated directory claims — candidate bases for resolving sibling references. */
  dirs: string[]
  /** Claims whose every mention sits in create-this prose — skipped, counted, disclosed. */
  prospective: string[]
  /**
   * Claims whose every mention sits beside the URL they are fetched from — another tree's
   * files, unverifiable here. Skipped, counted, disclosed.
   */
  fetched: string[]
  /** Claims whose every mention sits behind a namespace prefix (`pc:`) — another repo's tree. */
  namespaced: string[]
  /** Naming stand-ins (`my-custom-skill`) — never real claims. */
  placeholder: string[]
}

export interface PathClaimOptions {
  /**
   * Read namespace-prefixed mentions (`pc: `src/x.ts``) as another repo's tree — the task
   * surface, where prompts quote foreign repos behind a legend. Instruction files keep every
   * backticked span as a claim of this repo.
   */
  namespaces?: boolean
}

/**
 * Repo-relative path claims from single-token inline spans, conservatively filtered. The
 * load-bearing precision rule (learned from real corpus prose): an extensionless bare token
 * (`research/trust`, `milestone/mNN`) is prose — a dir claim must end with `/`, a file claim
 * must carry an extension. With `namespaces`, a span whose every mention sits behind a
 * namespace prefix names another repo's tree, not this one.
 */
export function extractPathClaims(text: string, opts: PathClaimOptions = {}): PathClaims {
  // Per claim: does EVERY mention sit in create-this / fetched-from prose / behind a namespace
  // prefix? One plain reference makes it a claim.
  const prospectiveOnly = new Map<string, boolean>()
  const fetchedOnly = new Map<string, boolean>()
  const namespacedOnly = new Map<string, boolean>()
  const placeholder = new Set<string>()
  const dirs = new Set<string>()

  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const token = (m[1] as string).trim()
    if (token.includes(" ") || token.length > 120) continue
    if (
      token.startsWith("/") ||
      token.startsWith("~") ||
      token.startsWith("@") ||
      token.startsWith("$")
    )
      continue
    if (token.includes("://") || token.startsWith("www.")) continue
    // A schemeless host (`api.example.com/client/v4/`, `example.com/sitemap.xml`) is a URL, not
    // a repo path — it can never be verified against the filesystem, so it is never a claim.
    if (token.includes("/")) {
      const firstSegment = token.split("/")[0] ?? token
      const hostSuffix = HOSTNAME_RE.exec(firstSegment)?.[1]?.toLowerCase()
      if (hostSuffix && !KNOWN_EXTENSIONS.has(hostSuffix)) continue
    }
    if (/[*?{}<>|]/.test(token)) continue
    if (token.includes("@")) continue
    if (!PATH_TOKEN_RE.test(token)) continue
    // A $-placeholder segment (TanStack-style `/p/$slug`) is a route pattern, not a file claim.
    if (token.split("/").some((seg) => seg.startsWith("$"))) continue
    const isDirClaim = token.endsWith("/")
    const ext = token.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1]
    if (!isDirClaim && !(ext && KNOWN_EXTENSIONS.has(ext))) continue

    const claim = token.replace(/\/$/, "")
    if (isPlaceholderClaim(claim)) {
      placeholder.add(claim)
      continue
    }
    if (isDirClaim) dirs.add(claim)
    const context = claimContext(text, m.index ?? 0)
    const prospective = CREATION_CONTEXT_RE.test(context)
    prospectiveOnly.set(claim, (prospectiveOnly.get(claim) ?? true) && prospective)
    // External beats prospective when both match: "fetch from <url>" says where the file lives,
    // which creation prose never can.
    const fetched = FETCH_CONTEXT_RE.test(context) && EXTERNAL_URL_RE.test(context)
    fetchedOnly.set(claim, (fetchedOnly.get(claim) ?? true) && fetched)
    if (opts.namespaces) {
      // A namespace prefix ends the text right before this mention (`pc: `, `lk:`) — the span
      // points into another repo's tree.
      const nsLead = new RegExp(`(${NAMESPACE_IDENT}):[ \\t]*$`).exec(text.slice(0, m.index ?? 0))
      const prefixed = isNamespace(nsLead?.[1])
      namespacedOnly.set(claim, (namespacedOnly.get(claim) ?? true) && prefixed)
    }
  }

  const paths: string[] = []
  const prospective: string[] = []
  const fetched: string[] = []
  const namespaced: string[] = []
  for (const [claim, only] of prospectiveOnly) {
    if (fetchedOnly.get(claim)) fetched.push(claim)
    else if (only) prospective.push(claim)
    else if (namespacedOnly.get(claim)) namespaced.push(claim)
    else paths.push(claim)
  }
  return { paths, dirs: [...dirs], prospective, fetched, namespaced, placeholder: [...placeholder] }
}

export interface DecisionRefs {
  /** Decision number → the id as first written (`D-014`). Only refs claiming THIS repo's record. */
  refs: Map<number, string>
  /** Refs whose every mention names another record (`peer D-050`) — skipped, counted, disclosed. */
  qualifiedSkipped: number
}

// Words that may precede a decision reference without naming a DIFFERENT record. Any other
// immediately-preceding word ("peer D-050", "upstream D-014") reads as a citation of some other
// project's ledger, which this repo's record cannot resolve — skipped and disclosed, never
// accused. Precision over recall: an unlisted verb costs a check, never a false accusation.
const LOCAL_REF_LEADINS = new Set(
  (
    "decision decisions entry entries ruling rulings record records ledger id ids item items " +
    "see per in of on at by to as is was are were the a an and or but not with under over from " +
    "via vs than after before since between through against latest newest earliest only also " +
    "still now supersedes superseded superseding amends amended extends extended cites cited " +
    "citing adds added adding wrote written writes locked locks closed closes opened opens " +
    "resolves resolved reopened recorded number numbers"
  ).split(" "),
)

/**
 * `D-NNN` decision references a state document makes against the repo's own decision record.
 * A ref counts as local when nothing precedes it but punctuation, connective prose, or a
 * citation verb; one unqualified mention makes the number a live claim.
 */
export function extractDecisionRefs(text: string): DecisionRefs {
  const byNum = new Map<number, { asWritten: string; local: boolean }>()
  for (const m of text.matchAll(/\bD-(\d{1,4})\b/g)) {
    const index = m.index ?? 0
    // Part of a larger token (`X-D-3`, `a/D-3`) — an identifier, not a decision reference.
    if (index > 0 && /[-/_.]/.test(text[index - 1] as string)) continue
    const before = text.slice(Math.max(0, index - 48), index)
    const lead = /([A-Za-z][A-Za-z0-9'’-]*)[ \t]+$/.exec(before)?.[1]
    const local = !lead || LOCAL_REF_LEADINS.has(lead.toLowerCase())
    const num = Number(m[1])
    const seen = byNum.get(num)
    if (!seen) byNum.set(num, { asWritten: m[0], local })
    else seen.local = seen.local || local
  }
  const refs = new Map<number, string>()
  let qualifiedSkipped = 0
  for (const [num, ref] of byNum) {
    if (ref.local) refs.set(num, ref.asWritten)
    else qualifiedSkipped += 1
  }
  return { refs, qualifiedSkipped }
}

/** How often each package manager is used in command position — the consistency signal. */
export function packageManagerUsage(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of extractCodeTokens(text)) {
    for (const m of token.matchAll(/\b(pnpm|yarn|npm|bun)\s+(?:run\s+)?[A-Za-z-]/g)) {
      const pm = m[1] as string
      counts.set(pm, (counts.get(pm) ?? 0) + 1)
    }
  }
  return counts
}

/** Cross-references to other well-known instruction/state docs. */
export const KNOWN_DOC_REFS = [
  "AGENTS.md",
  "CLAUDE.md",
  "PROJECT_CONTEXT.md",
  "DECISIONS.md",
  "GEMINI.md",
]

// The characters a path token is built from — walking back over these from a mention reaches the
// token's head, which is where a `~` marking a HOME path would sit.
const PATH_TOKEN_CHARS = /[A-Za-z0-9_.$~/-]/

export interface DocRefs {
  /** Well-known docs the file points at as files of THIS repo. */
  refs: string[]
  /** Mentions embedded in `~/`-home paths — outside the repo, unverifiable from it. */
  tildeSkipped: number
  /** Mentions skipped as deliberate absence — anchored prose at the mention, or its sentence carrying one — counted. */
  absenceSkipped: number
}

// A doc named only to say it deliberately does NOT exist here is not a stale pointer — the repo
// is right to lack it. Observed: a repo that dropped its CLAUDE.md pointer and wrote down why
// stood accused of a dangling ref until it worded around the very filename its convention was
// about. The skip mirrors the classes the path scanner already honours — create-this prose
// through the shared CREATION_CONTEXT_RE — plus an explicit absence statement. Narrow on
// purpose: every phrase here must be an unambiguous "it is not meant to exist", because each
// one widens the set of stale pointers that pass silently.
//
// Every absence and creation phrase is anchored ADJACENT to the mention — ending directly
// before it, or beginning directly after it — never merely somewhere on its line: "if the cache
// does not exist, read CLAUDE.md" is an absence statement about the CACHE, and the line-wide
// test let it silence the missing-doc finding while the doc stayed missing. Adjacency is what
// ties the phrase to the document; only gap characters, punctuation and an article may sit
// between. The anchor may cross ONE line break of pure whitespace ("there is no\n`CLAUDE.md`,
// and adding one would hide this file") because wrapped prose is still one sentence — but
// never a paragraph break, and never so much as a word.
//
// "no `CLAUDE.md` exists here" carries the negation directly before the mention, so the test
// is against the same line's prefix, backticks and quotes allowed in between — a "no" elsewhere
// on the line ("we saw no reason") must not reach it.
const NO_DOC_PREFIX_RE =
  /\b(?:there\s+is\s+)?no\s+(?:such\s+(?:file|doc(?:ument)?)?\s*(?:as\s+)?)?[\s`'"]*$/i
// The indefinite article directly before the mention ("restore the pointer form (a
// `CLAUDE.md` containing `@AGENTS.md`)") names a KIND of file, not the repo's file — a
// reference to the document itself would say "the". Grammatically non-referential, whatever
// the rest of the sentence does.
const INDEFINITE_DOC_PREFIX_RE = /\b(?:a|an)[\s`'"]*$/i
// "`DECISIONS.md` does not exist" carries it directly after: gap characters and punctuation
// may follow the mention, then the phrase must begin. The will-be-created family lives here
// because its verb follows the name too ("CHANGELOG.md will be generated").
const ABSENCE_AFTER_RE =
  /^[\s,;:.`'"\u2013\u2014]*(?:does\s+not\s+exist|doesn'?t\s+exist|is\s+(?:deliberately\s+)?absent|never\s+existed|none\s+exists|will\s+be\s+(?:created|generated|written))\b/i
// What may sit between a creation phrase and the mention it explains: gap characters, an
// article, or a determiner — "creating a `CLAUDE.md`" — and nothing else, so creation language
// about a different object on the line ("when creating the cache, read CLAUDE.md") stays out.
const CREATION_GAP_RE =
  /^(?:\s*(?:a|an|the|this|these|those|it|its|them|one|new|your|our)|[\s`'"])*$/i

// A sentence terminator for the sibling cover below: a period, question or exclamation mark,
// optionally followed by closing brackets and quotes, then whitespace or the end of text —
// so "instructions)." ends a sentence while "2.1.277.1" does not.
const SENTENCE_END_RE = /[.!?][)\]}'"’”]*(?=\s|$)/g

/**
 * A bare substring match is not enough: `~/.claude/CLAUDE.md` mentions CLAUDE.md but points at
 * the reader's machine, never at the repo — treating it as a repo ref accused a true sentence of
 * lying (the home file existed; the repo never had one). A home-path occurrence is skipped and
 * counted like the absolute tokens below; one ordinary occurrence still makes the doc a claim.
 * Deliberate-absence prose gets the same per-mention rule with one extension: a plain mention
 * in the SAME SENTENCE as an anchored absence of the same doc is covered by it (see below), so
 * a true stale pointer ("see CLAUDE.md for details", alone in its sentence) flags exactly as
 * before.
 */
// The prefix context reaches back over the mention's line start and across ONE line break of
// pure whitespace, to the start of the previous line — never across a blank line, which is a
// paragraph boundary and a new thought.
function wrapAwareStart(text: string, lineStart: number): number {
  let i = lineStart
  while (i > 0 && (text[i - 1] === " " || text[i - 1] === "\t")) i -= 1
  if (i > 0 && text[i - 1] === "\n") return text.lastIndexOf("\n", i - 2) + 1
  return lineStart
}

// The suffix mirror: across one line break, but only onto a line that carries content.
function wrapAwareEnd(text: string, lineEnd: number): number {
  let i = lineEnd
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1
  if (i + 1 < text.length && text[i] === "\n" && text[i + 1] !== "\n") {
    const next = text.indexOf("\n", i + 1)
    return next === -1 ? text.length : next
  }
  return i
}

function sentenceStartOf(text: string, at: number): number {
  const prefix = text.slice(0, at)
  SENTENCE_END_RE.lastIndex = 0
  let start = 0
  for (let m = SENTENCE_END_RE.exec(prefix); m !== null; m = SENTENCE_END_RE.exec(prefix)) {
    start = m.index + m[0].length
  }
  return start
}

function sentenceEndOf(text: string, from: number): number {
  SENTENCE_END_RE.lastIndex = from
  const m = SENTENCE_END_RE.exec(text)
  return m === null ? text.length : m.index + m[0].length
}

export function extractDocRefs(text: string): DocRefs {
  const refs: string[] = []
  let tildeSkipped = 0
  let absenceSkipped = 0
  for (const name of KNOWN_DOC_REFS) {
    // A sentence that states a doc's deliberate absence once may name the doc several times —
    // the memorial of the removal ("the CLAUDE.md pointer go in 9cc6915"), the instruction
    // never to recreate it, the shape of the thing to restore. One ANCHORED absence in a
    // sentence covers that sentence's other mentions of the same doc; the cover is the
    // sentence, never the paragraph, and a sentence whose absence phrase belongs to another
    // object ("if the cache does not exist, read CLAUDE.md") anchors nothing and covers
    // nothing.
    const anchored: boolean[] = []
    const spans: Array<[number, number]> = []
    let claimed = false
    let at = text.indexOf(name)
    while (at !== -1) {
      let head = at
      while (head > 0 && PATH_TOKEN_CHARS.test(text[head - 1] as string)) head -= 1
      if (text[head] === "~") {
        tildeSkipped += 1
      } else {
        const end = at + name.length
        const before = text.slice(wrapAwareStart(text, text.lastIndexOf("\n", at) + 1), head)
        const after = text.slice(
          end,
          wrapAwareEnd(
            text,
            text.indexOf("\n", end) === -1 ? text.length : text.indexOf("\n", end),
          ),
        )
        // Creation prose must END against the mention (an article may bridge), never merely
        // share its line; absence phrases anchor on either side the same way.
        const creation = CREATION_CONTEXT_RE.exec(before)
        const deliberate =
          NO_DOC_PREFIX_RE.test(before) ||
          INDEFINITE_DOC_PREFIX_RE.test(before) ||
          ABSENCE_AFTER_RE.test(after) ||
          (creation !== null &&
            CREATION_GAP_RE.test(before.slice(creation.index + creation[0].length)))
        anchored.push(deliberate)
        spans.push([sentenceStartOf(text, head), sentenceEndOf(text, end)])
      }
      at = text.indexOf(name, at + name.length)
    }
    for (let i = 0; i < anchored.length; i += 1) {
      if (anchored[i]) {
        absenceSkipped += 1
        continue
      }
      const here = spans[i] as [number, number]
      const covered = spans.some(
        (span, j) => j !== i && anchored[j] && here[0] < span[1] && span[0] < here[1],
      )
      if (covered) absenceSkipped += 1
      else claimed = true
    }
    if (claimed) refs.push(name)
  }
  return { refs, tildeSkipped, absenceSkipped }
}
