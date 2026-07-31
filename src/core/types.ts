// The shared vocabulary of a "reckoning": the deterministic facts a scan produces, the maturity
// score derived from them, and the leash policy that parameterises what etymd generates.

export type PackageManager = "pnpm" | "yarn" | "npm" | "bun" | "unknown"

export type WorkspaceKind = "pnpm" | "yarn" | "npm" | "nx" | "turbo" | "lerna" | "none"

export type CiSystem = "gitlab" | "github" | "none"

/** A project script classified into the roles that make up a "Done =" definition. */
export interface DiscoveredCommands {
  test?: string
  lint?: string
  typecheck?: string
  format?: string
  formatCheck?: string
  build?: string
  dev?: string
  /** Every raw `scripts` key, kept so nothing is silently lost. */
  raw: Record<string, string>
}

export interface PackageInfo {
  name: string
  /** Path relative to the scan root. */
  dir: string
  private: boolean
  version?: string
}

/** An agent-workflow artifact etymd knows how to read or generate. */
export interface DetectedArtifact {
  id: string
  label: string
  path: string
  /** What role it plays: the single source of truth, a per-agent pointer, a skill, a gate, etc. */
  kind:
    | "contract"
    | "state"
    | "decisions"
    | "adapter"
    | "skill"
    | "gate"
    | "map"
    | "sessions"
    | "other"
  exists: boolean
}

/** Committer-date freshness for one state/decisions artifact — a git fact, never mtime. */
export interface ArtifactFreshness {
  /** Matches `DetectedArtifact.id`. */
  artifactId: string
  path: string
  /** ISO committer date (`git log -1 --format=%cI`) of the artifact's last commit. */
  lastCommit: string
  /** True when the repo has commits newer than the artifact's last commit. */
  commitsSince: boolean
}

/**
 * Freshness of the "this describes now" artifacts (state/decisions), judged from git alone.
 * mtime is never read — checkouts, syncs, and editors rewrite it freely; the committer date is
 * the only clock the repo itself vouches for.
 */
export interface FreshnessFacts {
  /** ISO committer date of the repo's last commit. */
  repoLastCommit?: string
  artifacts: ArtifactFreshness[]
  /**
   * Artifacts whose dates git cannot vouch for (untracked file, shallow clone, not a repo) —
   * the fact is absent and the lens discloses why; absence is never itself a finding.
   */
  unverifiable: { path: string; reason: string }[]
}

export interface GitFacts {
  isRepo: boolean
  branch?: string
  head?: string
  hooksPath?: string
  husky: boolean
  /** Distinct commit authors in recent history — the solo-vs-team profile signal. */
  recentAuthors?: number
  /** Ticket-key prefix inferred from recent commit subjects (e.g. "NGRE2E"). */
  ticketKey?: string
}

export interface HookFacts {
  /** husky-legacy = husky v3/v4 config (package.json `husky` key or husky.config.js), no .husky dir. */
  source: "githooks" | "husky" | "husky-legacy" | "custom" | "none"
  /** The actual hooks directory when known (covers a custom core.hooksPath). */
  dir?: string
  preCommit: boolean
  prePush: boolean
  commitMsg: boolean
  lintStaged: boolean
}

export interface ProjectFacts {
  etymdVersion: string
  packVersion: string
  generatedAt: string
  root: string
  name: string
  git: GitFacts
  packageManager: PackageManager
  node?: string
  workspace: {
    kind: WorkspaceKind
    packageGlobs: string[]
  }
  packages: PackageInfo[]
  frameworks: string[]
  commands: DiscoveredCommands
  ci: {
    system: CiSystem
    files: string[]
  }
  hooks: HookFacts
  artifacts: DetectedArtifact[]
  /** Optional: baselines approved by older versions predate this fact. */
  freshness?: FreshnessFacts
  tree: {
    dirs: { name: string; files: number }[]
    /** True when the file count hit the walk cap (large repo). */
    truncated: boolean
  }
}

export interface ContextFile {
  path: string
  role: string
  words: number
  approxTokens: number
}

export interface ContextBudget {
  files: ContextFile[]
  totalWords: number
  totalApproxTokens: number
  /** The per-file threshold this measurement used (config-overridable). */
  perFileWords: number
  /** Files large enough to be worth extracting into an on-demand skill. */
  extractionCandidates: ContextFile[]
}
