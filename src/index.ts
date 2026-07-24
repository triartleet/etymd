// Programmatic surface — the deterministic core + engine, usable without the CLI.
export { scanProject } from "./core/scan.js"
export { scoreProject } from "./core/score.js"
export { measureContext, EXTRACTION_THRESHOLD, isAlwaysAppliedCursorRule } from "./core/context.js"
export { defaultLeash } from "./core/leash.js"
export { planWorkflow } from "./core/generate.js"
export { applyFiles } from "./core/apply.js"
export {
  readCachedFacts,
  writeCachedFacts,
  readBaseline,
  writeBaseline,
  deriveProfile,
  cacheFactsPath,
  baselinePath,
  type Baseline,
} from "./core/facts.js"
export { runAudit, LENSES, type AuditResult, type AuditOptions } from "./engine/run.js"
export {
  rankFindings,
  type Finding,
  type Lens,
  type LensReport,
  type WorkflowProfile,
} from "./engine/finding.js"
export {
  readLedger,
  writeLedger,
  reconcileLedger,
  type Ledger,
  type LedgerEntry,
  type LedgerDiff,
} from "./engine/ledger.js"
export {
  buildGateInventory,
  type GateInventory,
  type GateTool,
} from "./lenses/gate-integrity/inventory.js"
export { PACK_VERSION } from "./pack/version.js"
export { RUBRIC } from "./pack/rubric.js"
export { VERSION, NAME } from "./version.js"

export type {
  ProjectFacts,
  Scorecard,
  ScoreDimension,
  ScoreLevel,
  SetupMode,
  LeashProfile,
  LeashPolicy,
  ContextBudget,
  ContextFile,
  DiscoveredCommands,
  DetectedArtifact,
  HookFacts,
  PackageManager,
  WorkspaceKind,
} from "./core/types.js"
export type { GeneratedFile, PlanOptions } from "./core/generate.js"
export type { ApplyResult } from "./core/apply.js"
