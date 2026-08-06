import type { GateConfig } from "../core/config.js"
import type { PackageManager, ProjectFacts } from "../core/types.js"
import { PACK_VERSION } from "./version.js"

export function runPrefix(pm: PackageManager): string {
  switch (pm) {
    case "pnpm":
      return "pnpm"
    case "yarn":
      return "yarn"
    case "bun":
      return "bun run"
    case "npm":
    case "unknown":
    default:
      // npm is the safe universal fallback when no lockfile pins the manager.
      return "npm run"
  }
}

/** A command wired into a correctness gate must never write, fix, or generate. */
export function isSafeGateCommand(value: string | undefined): boolean {
  if (!value) return false
  return !/--write|--fix|\bcodegen\b|\bgenerate\b|-w\s|--watch/.test(value)
}

/** How to re-verify the repo map against reality — the map is advisory, never authoritative. */
export function mapVerifyCommand(facts: ProjectFacts): string {
  switch (facts.workspace.kind) {
    case "nx":
      return `${facts.packageManager === "yarn" ? "yarn" : "npx"} nx show projects`
    case "pnpm":
      return "pnpm -r ls --depth -1"
    case "yarn":
      return "yarn workspaces info"
    case "npm":
      return "npm ls --workspaces --depth=0"
    case "turbo":
    case "lerna":
      return "git ls-files '*/package.json'"
    default:
      return "git ls-files | head -50"
  }
}

function doneDefinition(facts: ProjectFacts): string[] {
  const run = runPrefix(facts.packageManager)
  const parts: string[] = []
  const c = facts.commands
  const formatCmd =
    c.formatCheck ??
    (isSafeGateCommand(c.format ? c.raw[c.format] : undefined) ? c.format : undefined)
  if (formatCmd) parts.push(`\`${run} ${formatCmd}\``)
  if (c.typecheck) parts.push(`\`${run} ${c.typecheck}\``)
  if (c.lint) parts.push(`\`${run} ${c.lint}\``)
  if (c.test) parts.push(`\`${run} ${c.test}\``)
  return parts
}

/**
 * The minimal AGENTS.md scaffold — only what the scan can assert truthfully, plus clearly
 * marked slots for the human/agent to complete. etymd audits this file afterwards, so the
 * template must never claim what it cannot know.
 */
export function generateAgentsMd(facts: ProjectFacts): string {
  const run = runPrefix(facts.packageManager)
  const done = doneDefinition(facts)
  // "none detected" stays true with or without a manifest; "see package.json" lied in docs-only
  // repos where that file does not exist (the docs-only onboarding case, 2026-07-26).
  const frameworks = facts.frameworks.length ? facts.frameworks.join(", ") : "none detected"
  const workspace =
    facts.workspace.kind === "none" ? "single package" : `${facts.workspace.kind} workspace`
  const topDirs = facts.tree.dirs.slice(0, 14)

  return `# AGENTS.md

Operating contract for AI agents working in **${facts.name}**. One source of truth — most agents
(Claude Code, Codex, Cursor, Copilot, Gemini, …) read this file natively. Kept true by
[etymd](https://www.npmjs.com/package/etymd): the commands, paths, and claims below are audited
against the actual repo — update this file when the repo changes, or \`etymd audit\` will tell you.

## What this project is

<!-- One paragraph: what this does and who it is for. Run \`etymd brief\` to have your agent
draft it from the reckoning; refine by hand. -->

## Stack

- **Shape:** ${workspace}${facts.packages.length ? ` (${facts.packages.length} packages)` : ""}, package manager **${facts.packageManager}**${facts.node ? `, Node ${facts.node}` : ""}.
- **Frameworks:** ${frameworks}.
- **CI:** ${facts.ci.system === "none" ? "none detected" : facts.ci.system}.

## Working rules

- **Reuse-first.** Before writing any new helper/component/type: check the map below and the
  surrounding code — a "new" thing usually exists.
- **Minimal diffs.** Never touch files outside the task's scope.
<!-- Add your project's own rules: commit/branch conventions, what the agent may and may not do,
org tooling constraints. Keep every rule TRUE — stale rules erode trust in the rest. -->

## Repo map

> **Advisory, not authoritative** — re-verify with \`${mapVerifyCommand(facts)}\` before
> structure-sensitive changes, and update this section in the same change that moves files.

${topDirs.length ? topDirs.map((d) => `- \`${d.name}/\` — ${d.files} files`).join("\n") : "- (single package; list the key files here)"}

## Done =

${done.length ? `A change is done when these are green:\n\n${done.map((d) => `- ${d}`).join("\n")}` : `Define the check commands that gate a change (test / lint / typecheck / format).`}

## Commands

\`\`\`bash
${
  [
    facts.commands.dev && `${run} ${facts.commands.dev}`,
    facts.commands.build && `${run} ${facts.commands.build}`,
    facts.commands.test && `${run} ${facts.commands.test}`,
    facts.commands.lint && `${run} ${facts.commands.lint}`,
    facts.commands.typecheck && `${run} ${facts.commands.typecheck}`,
  ]
    .filter(Boolean)
    .join("\n") || "# add the project's key commands"
}
\`\`\`

<!-- etymd pack v${PACK_VERSION} -->
`
}

/**
 * The content screen is DECLARED here and RESOLVED at run time from an external checker, which
 * is what lets a generated hook be committed to a public repo safely: the hook holds no
 * patterns, and a machine without a checker installed runs a no-op instead of failing.
 *
 * The indirection is the whole design. Screening patterns are the very strings being screened
 * for (employer names, hostnames, identities), so they can never live in a tracked file — the
 * hook names an executable, and the executable reads the pattern file. Etymd ships the screener
 * (`etymd screen`) but never ships patterns: the mechanism is general, the policy is the user's.
 */
const CONTENT_GATE_RESOLUTION = `GATE="\${CONTENT_GATE:-$(command -v etymd || true)}"`

export function generatePreCommitHook(): string {
  return `#!/usr/bin/env sh
# etymd: process gate. Cheap, locally-knowable checks belong here (fast, blocks the commit).

# Content screen — staged file bytes. Refuses to commit environment, employer or identity
# detail into a repo whose history is (or could become) public. The checker and its patterns
# are machine-local by design, so this is a NO-OP wherever no checker is installed: safe to
# commit anywhere, active only where you opted in.
#
# Bypass, with a reason: git commit --no-verify
${CONTENT_GATE_RESOLUTION}
if [ -x "$GATE" ]; then
  "$GATE" screen --staged || exit 1
fi

exit 0
`
}

/**
 * The message is published history too, and the staged screen cannot see it: that gate reads
 * `git diff --cached`, which is file bytes only. A real audit found several leaks living in
 * commit messages rather than files, which is why this is its own door.
 */
export function generateCommitMsgHook(): string {
  return `#!/usr/bin/env sh
# etymd: content screen — the commit message itself.
#
# The staged-content gate reads file bytes and never sees the message, yet a message is as
# permanently published as any file. No-op where no checker is installed.
#
# Bypass, with a reason: git commit --no-verify
GATE="\${COMMIT_MSG_GATE:-$(command -v etymd || true)}"
if [ -x "$GATE" ]; then
  "$GATE" screen --message "$1" || exit 1
fi

exit 0
`
}

export function generatePrePushHook(facts: ProjectFacts, gates?: GateConfig): string {
  const run = runPrefix(facts.packageManager)
  const c = facts.commands
  // A recorded command set wins over the derivation: the guess is a starting point, and the one
  // edit that changes it must survive the next `etymd gates` run.
  const candidates = gates?.commands.length ? gates.commands : [c.formatCheck, c.typecheck, c.lint]
  const allowed = new Set(gates?.allowWriting ?? [])
  const steps = candidates
    .filter(
      (key): key is string =>
        Boolean(key) && (allowed.has(key as string) || isSafeGateCommand(c.raw[key as string])),
    )
    .map((key) => `${run} ${key}`)
  const body = steps.length
    ? steps.map((s) => `echo "› ${s}"\n${s} || exit 1`).join("\n")
    : 'echo "etymd: no correctness commands detected — add format:check / typecheck / lint"'
  // The truth gate on the repo's own instructions, at the tier this repo chose. Skipped with a
  // note rather than failing where etymd is not installed — a gate that cannot run must say so
  // instead of silently passing.
  const failOn = gates?.failOn ?? "risk"
  const auditStep = `
if command -v etymd >/dev/null 2>&1; then
  echo "› etymd audit --fail-on ${failOn}"
  etymd audit --no-ledger --fail-on ${failOn} || exit 1
else
  echo "› etymd audit skipped (not on PATH)"
fi`
  return `#!/usr/bin/env sh
# etymd: correctness gate. Mirrors CI cheapest-first; blocks the push on any failure.
${body}
${auditStep}

# Content screen, second pass — the WHOLE TREE rather than one diff. Catches anything committed
# with --no-verify and anything a rebase or merge brought in from elsewhere. Advisory here (it
# never blocks the push): the blocking decision belongs at commit time, where the fix is cheap.
${CONTENT_GATE_RESOLUTION}
if [ -x "$GATE" ] && [ "\${CONTENT_GATE_PREPUSH:-1}" = "1" ]; then
  "$GATE" screen --tree --advisory || true
fi

exit 0
`
}

/**
 * The publish door — the only check that inspects what actually SHIPS.
 *
 * Every git-scoped check answers "what is in the repository?". That question misses the leak
 * that reaches users: a gitignored file can be packaged into a published artifact (npm and vsce
 * do not honour .gitignore), so every git-based gate passes forever while the bytes go out.
 * This builds what the project would publish, unpacks it, and screens the result.
 */
export function generateArtifactCheckScript(): string {
  return `#!/usr/bin/env sh
# etymd: content screen — the published ARTIFACT, not the repository.
#
# Wire it into the irreversible moment:
#   package.json → "prepublishOnly": "./scripts/artifact-check.sh"
#
# No-op where no checker is installed. Bypass is deliberate and loud: ARTIFACT_CHECK_SKIP=1.
set -eu

if [ "\${ARTIFACT_CHECK_SKIP:-0}" = "1" ]; then
  echo "› artifact-check: SKIPPED by ARTIFACT_CHECK_SKIP=1"
  exit 0
fi

${CONTENT_GATE_RESOLUTION}
[ -x "$GATE" ] || { echo "› artifact-check: no checker installed — skipping."; exit 0; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

# Pack exactly what would ship, then screen the unpacked bytes.
if [ -f package.json ]; then
  npm pack --pack-destination "$WORK" >/dev/null 2>&1 || {
    echo "› artifact-check: npm pack failed — cannot verify what would ship" >&2; exit 1; }
  tar -xzf "$WORK"/*.tgz -C "$WORK" 2>/dev/null || true
fi

"$GATE" screen --dir "$WORK" || exit 1
exit 0
`
}
