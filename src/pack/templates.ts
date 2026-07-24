import type { LeashProfile, PackageManager, ProjectFacts } from "../core/types.js"
import type { WorkflowProfile } from "../engine/finding.js"
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

export interface AgentsMdOptions {
  /** Whether a PROJECT_CONTEXT.md state doc is part of the setup. */
  state: boolean
  profile: WorkflowProfile
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

function leashLines(leash: LeashProfile): string[] {
  const lines: string[] = []
  if (!leash.autonomy.commitUnasked)
    lines.push("- **Never commit or push unasked.** The developer drives version control.")
  else if (!leash.autonomy.pushUnasked) lines.push("- **Never push unasked.**")
  if (leash.scope.minimalDiffs)
    lines.push("- **Minimal diffs.** Never touch files outside the task's scope.")
  if (leash.vcs.ticketLinked)
    lines.push(
      `- **Every change belongs to a ticket${leash.vcs.ticketKey ? ` (\`${leash.vcs.ticketKey}-…\`)` : ""}.**`,
    )
  if (leash.vcs.commitConvention)
    lines.push(`- **Commit convention:** \`${leash.vcs.commitConvention}\`.`)
  if (leash.vcs.branchConvention)
    lines.push(`- **Branch convention:** \`${leash.vcs.branchConvention}\`.`)
  if (leash.vcs.attribution === "none")
    lines.push(
      '- **Commits stay unattributed.** No `Co-authored-by:` trailers, no "Generated with …" credits — author the work as the developer\'s own.',
    )
  if (!leash.tooling.ghCli.enabled)
    lines.push(
      leash.tooling.ghCli.hard
        ? "- **The `gh` CLI is not allowed** (org policy)."
        : "- **The `gh` CLI is not available here.**",
    )
  if (leash.tooling.ticketApiBlocked)
    lines.push(
      "- **Ticket/wiki APIs (Jira/Confluence) are blocked** — deliver that work as paste-ready drafts for a human to submit. (MRs/PRs through git are fine.)",
    )
  if (!leash.tooling.mcpServers.enabled)
    lines.push(
      leash.tooling.mcpServers.hard
        ? "- **Third-party MCP servers are disabled by org policy** — do not propose enabling them."
        : "- **Third-party MCP servers are off** unless explicitly enabled.",
    )
  if (leash.deps.exactPinning)
    lines.push(
      "- **Pin every dependency to an exact version** — no `^`/`~` ranges; add with `--save-exact` and verify the written spec.",
    )
  if (leash.disabledIntegrations.length)
    lines.push(
      `- **Disabled integrations — do not propose flows using:** ${leash.disabledIntegrations.join(", ")}.`,
    )
  if (!leash.autonomy.network) lines.push("- **No unprompted network access.**")
  for (const note of leash.notes) lines.push(`- ${note}`)
  return lines
}

export function generateAgentsMd(
  facts: ProjectFacts,
  leash: LeashProfile,
  opts: AgentsMdOptions = { state: true, profile: "solo" },
): string {
  const run = runPrefix(facts.packageManager)
  const done = doneDefinition(facts)
  const frameworks = facts.frameworks.length ? facts.frameworks.join(", ") : "see package.json"
  const workspace =
    facts.workspace.kind === "none" ? "single package" : `${facts.workspace.kind} workspace`
  const topDirs = facts.tree.dirs.slice(0, 14)
  const seamSeeds = facts.packages.slice(0, 8)

  const sessionSection = opts.state
    ? `## Session protocol

1. Read \`PROJECT_CONTEXT.md\` (current state) before starting.
2. Work in small vertical slices; keep the repo map and state doc current in the same change.
3. At session end, record what changed, what's next, and any new decisions.`
    : `## Session protocol

1. Work in small vertical slices; keep the repo map current in the same change.
2. At session end, summarise what changed and what's next for the human.`

  return `# AGENTS.md

Operating contract for any AI agent working in **${facts.name}** (Claude Code, Cursor, Copilot,
and others). This is the single source of truth; per-agent files point here. Generated by
[clothaid](https://www.npmjs.com/package/clothaid) — edit this file, not the pointers.

## What this project is

<!-- One paragraph: what this app does and who it is for. Run \`clothaid brief\` to draft this
from the reckoning, then refine by hand. -->

## Stack

- **Shape:** ${workspace}${facts.packages.length ? ` (${facts.packages.length} packages)` : ""}, package manager **${facts.packageManager}**${facts.node ? `, Node ${facts.node}` : ""}.
- **Frameworks:** ${frameworks}.
- **CI:** ${facts.ci.system === "none" ? "none detected" : facts.ci.system}.

## Working rules (the leash)

- **Reuse-first.** Before writing any new component, util, type, or helper: check the reuse
  inventory below and the surrounding code — a "new" thing usually exists. Confirm with one
  targeted read, never a repo-wide search for a concept the map already answers.
${leashLines(leash).join("\n") || "- Match local style; keep changes small and reviewable."}

## Navigate narrow

Read this contract → the repo map below → open only the files the task needs. Prefer targeted
reads over repo-wide scans; a search that misses is indistinguishable from a thing that does not
exist, so confirm against the map before concluding something is absent.

## Repo map

> **Advisory, not authoritative** — re-verify before structure-sensitive changes with
> \`${mapVerifyCommand(facts)}\`, and update this section when the tree changes.

${topDirs.length ? topDirs.map((d) => `- \`${d.name}/\` — ${d.files} files`).join("\n") : "- (single package; list the key files here)"}

<!-- As this map grows, extract it into an on-demand skill so it stops loading every session —
run \`clothaid context\` to see when that pays off. -->

## Composition points

The architectural seams a change usually flows through — load these first when touching that
area, and record the invariant that must not break beside each one.

${seamSeeds.length ? seamSeeds.map((p) => `- \`${p.dir}/\` (${p.name}) — <!-- entry point + its invariant -->`).join("\n") : "<!-- List the 4–8 seams (entry points, routers, data access, shared contracts). Run `clothaid brief` and let your agent propose them from the code. -->"}

## Conventions

<!-- House rules an agent must obey: formatting/lint norms, naming, comment discipline, i18n,
logging, error handling. Run \`clothaid brief\` to have your agent propose them; keep only what
is real. -->

## Reuse inventory

<!-- Where the existing components/hooks/utils/types live that a new task should reuse instead
of re-writing. Point at directories or an INVENTORY doc. -->

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

${sessionSection}

<!-- clothaid pack v${PACK_VERSION} -->
`
}

export function generateClaudePointer(): string {
  return `# CLAUDE.md

Single source of truth for agent instructions lives in \`AGENTS.md\`. This pointer keeps Claude
Code aligned with every other agent — edit \`AGENTS.md\`, not this file.

@AGENTS.md
`
}

export function generateCopilotInstructions(): string {
  return `<!-- Single source of truth: ../AGENTS.md. Edit that file, not this one. -->

# Copilot instructions

Read and follow [\`AGENTS.md\`](../AGENTS.md) at the repository root — it is the operating
contract for all AI agents in this project, Copilot included.
`
}

export function generateCursorRule(): string {
  return `---
description: Project operating contract
alwaysApply: true
---

Follow the repository-root \`AGENTS.md\` as the single source of truth for how to work in this
project. It defines the stack, the leash, the repo map, and the definition of done.
`
}

export function generateProjectContext(facts: ProjectFacts): string {
  return `# PROJECT_CONTEXT.md

Ground-truth state — read this first every session. Trust it over any other doc where they differ.

_Last updated: ${new Date().toISOString().slice(0, 10)} (seeded by clothaid)._

## Stack & architecture (stable)

${facts.name} — ${facts.workspace.kind === "none" ? "single package" : `${facts.workspace.kind} workspace`}, ${facts.packageManager}. Full stack + conventions live in \`AGENTS.md\`.

## Active decisions log

_One line each (date — decision — why). Start recording here._

## Current state

### Where we are

- (describe what is built)

### Next

- (the immediate next task)

## Open questions

- (unresolved tensions)
`
}

export function generatePreCommitHook(): string {
  return `#!/usr/bin/env sh
# clothaid: process gate. Cheap, locally-knowable checks belong here (fast, blocks the commit).
# Add archive/heading/comment-style checks as your workflow grows.
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
    : 'echo "clothaid: no correctness commands detected — add format:check / typecheck / lint"'
  return `#!/usr/bin/env sh
# clothaid: correctness gate. Mirrors CI cheapest-first; blocks the push on any failure.
${body}
`
}
