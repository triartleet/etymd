// The knowledge pack: the versioned encoding of the workflow standard clothaid installs and
// audits against. Everything here is pack content — templates, rubric — never engine mechanics.
export { PACK_VERSION } from "./version.js"
export { RUBRIC, type RubricDimension, type RubricResult } from "./rubric.js"
export {
  runPrefix,
  isSafeGateCommand,
  mapVerifyCommand,
  generateAgentsMd,
  generateClaudePointer,
  generateCopilotInstructions,
  generateCursorRule,
  generateProjectContext,
  generatePreCommitHook,
  generatePrePushHook,
  type AgentsMdOptions,
} from "./templates.js"
