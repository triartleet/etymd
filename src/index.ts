// Programmatic surface — the deterministic core, usable without the CLI (editor plugins, CI, etc.).
export { scanProject } from "./core/scan.js"
export { scoreProject } from "./core/score.js"
export { measureContext, EXTRACTION_THRESHOLD } from "./core/context.js"
export { defaultLeash } from "./core/leash.js"
export { planWorkflow } from "./core/generate.js"
export { applyFiles } from "./core/apply.js"
export { readFacts, writeFacts, factsPath } from "./core/facts.js"
export { VERSION, NAME } from "./version.js"

export type {
  ProjectFacts,
  Scorecard,
  ScoreDimension,
  ScoreLevel,
  SetupMode,
  LeashProfile,
  ContextBudget,
  ContextFile,
  DiscoveredCommands,
  DetectedArtifact,
  PackageManager,
  WorkspaceKind,
} from "./core/types.js"
export type { GeneratedFile, PlanOptions } from "./core/generate.js"
export type { ApplyResult } from "./core/apply.js"
