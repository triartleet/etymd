// The shared vocabulary of a "reckoning": the deterministic facts a scan produces, the maturity
// score derived from them, and the leash policy that parameterises what clothaid generates.

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

/** An agent-workflow artifact clothaid knows how to read or generate. */
export interface DetectedArtifact {
  id: string
  label: string
  path: string
  /** What role it plays: the single source of truth, a per-agent pointer, a skill, a gate, etc. */
  kind: "contract" | "state" | "adapter" | "skill" | "gate" | "map" | "sessions" | "other"
  exists: boolean
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
  clothaidVersion: string
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
  tree: {
    dirs: { name: string; files: number }[]
    /** True when the file count hit the walk cap (large repo). */
    truncated: boolean
  }
}

export type ScoreLevel = "present" | "partial" | "absent"

export interface ScoreDimension {
  id: string
  label: string
  level: ScoreLevel
  detail: string
  /** What to do about it when it is not `present`. */
  recommendation?: string
}

export interface Scorecard {
  /** The workflow profile the rubric was applied under (team drops the solo-ritual dimensions). */
  profile: "solo" | "team"
  dimensions: ScoreDimension[]
  /** 0–100. */
  score: number
  /** Suggested setup mode given the current maturity. */
  suggestedMode: SetupMode
}

export type SetupMode = "fresh" | "migration" | "optimisation"

/** A constraint that is org-mandated (hard) reads differently from a preference (soft). */
export interface LeashPolicy {
  enabled: boolean
  hard: boolean
}

/** The operational constraints that parameterise the generated contract. */
export interface LeashProfile {
  autonomy: {
    runCommands: boolean
    commitUnasked: boolean
    pushUnasked: boolean
    openPrs: boolean
    network: boolean
  }
  tooling: {
    ghCli: LeashPolicy
    mcpServers: LeashPolicy
    /** Jira/Confluence-style ticket APIs blocked → agent delivers paste-ready drafts for tickets. */
    ticketApiBlocked: boolean
  }
  vcs: {
    branchConvention?: string
    commitConvention?: string
    /** Jira project key when changes are ticket-linked (e.g. "NGRE2E"). */
    ticketKey?: string
    ticketLinked: boolean
    /** Agent attribution in commits (Co-authored-by / "Generated with") allowed or banned. */
    attribution: "none" | "allowed"
  }
  deps: {
    exactPinning: boolean
  }
  scope: {
    minimalDiffs: boolean
    stayInScope: boolean
  }
  /** Integrations that exist in the repo but must not be proposed (e.g. a disabled Smartling). */
  disabledIntegrations: string[]
  notes: string[]
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
  /** Files large enough to be worth extracting into an on-demand skill. */
  extractionCandidates: ContextFile[]
}
