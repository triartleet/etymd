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

export function generatePreCommitHook(): string {
  return `#!/usr/bin/env sh
# etymd: process gate. Cheap, locally-knowable checks belong here (fast, blocks the commit).
exit 0
`
}

export function generatePrePushHook(facts: ProjectFacts): string {
  const run = runPrefix(facts.packageManager)
  const c = facts.commands
  const candidates = [c.formatCheck, c.typecheck, c.lint]
  const steps = candidates
    .filter((key): key is string => Boolean(key) && isSafeGateCommand(c.raw[key as string]))
    .map((key) => `${run} ${key}`)
  const body = steps.length
    ? steps.map((s) => `echo "› ${s}"\n${s} || exit 1`).join("\n")
    : 'echo "etymd: no correctness commands detected — add format:check / typecheck / lint"'
  return `#!/usr/bin/env sh
# etymd: correctness gate. Mirrors CI cheapest-first; blocks the push on any failure.
${body}
`
}
