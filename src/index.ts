// Programmatic surface — the deterministic core + the truth engine, usable without the CLI.
export { scanProject } from "./core/scan.js"
export { measureContext, EXTRACTION_THRESHOLD, isAlwaysAppliedCursorRule } from "./core/context.js"
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
export {
  readConfig,
  configPath,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  type EtymdConfig,
  type LoadedConfig,
  type InstructionScope,
  type ContextBudgets,
} from "./core/config.js"
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
export { instructionTruthLens } from "./lenses/instruction-truth/lens.js"
export {
  extractCommandClaims,
  extractPathClaims,
  listInstructionFiles,
  type PathClaims,
  type InstructionFileSet,
} from "./lenses/instruction-truth/claims.js"
export { contextEconomyLens, TOTAL_BUDGET_WORDS } from "./lenses/context-economy.js"
export {
  buildGateInventory,
  type GateInventory,
  type GateTool,
} from "./lenses/gate-integrity/inventory.js"
export { gateIntegrityLens } from "./lenses/gate-integrity/lens.js"
export { PACK_VERSION } from "./pack/version.js"
export { VERSION, NAME } from "./version.js"

export type {
  ProjectFacts,
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
