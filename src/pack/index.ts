// The knowledge pack: the versioned encoding of what etymd scaffolds and audits against.
// Everything here is pack content — templates — never engine mechanics.
export { PACK_VERSION } from "./version.js"
export {
  runPrefix,
  isSafeGateCommand,
  mapVerifyCommand,
  generateAgentsMd,
  generatePreCommitHook,
  generatePrePushHook,
} from "./templates.js"
