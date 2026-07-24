import { promises as fs } from "node:fs"
import path from "node:path"

import { ETYMD_DIR } from "../core/facts.js"
import { scanProject } from "../core/scan.js"
import type { ProjectFacts } from "../core/types.js"
import { print } from "../ui/render.js"
import { theme } from "../ui/theme.js"

export interface BriefOptions {
  cwd: string
  human?: boolean
}

export async function run(opts: BriefOptions): Promise<void> {
  const facts = await scanProject(opts.cwd)
  const contents = opts.human ? humanBrief(facts) : agentBrief(facts)
  const rel = path.join(ETYMD_DIR, opts.human ? "onboarding.md" : "brief.md")
  const target = path.join(opts.cwd, rel)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, contents, "utf8")

  print()
  print(`  ${theme.dim("wrote")} ${theme.info(rel)}`)
  if (opts.human) {
    print(`  ${theme.dim("A human-readable onboarding brief drawn from the reckoning.")}`)
  } else {
    print(
      `  ${theme.dim("Hand this to the agent already in your repo (Claude Code / Cursor / Copilot):")}`,
    )
    print(
      `  ${theme.dim('  "Read')} ${theme.info(rel)}${theme.dim(' and complete it against the codebase."')}`,
    )
    print(
      `  ${theme.dim("Its answers become the semantic half of AGENTS.md — you approve before it lands.")}`,
    )
  }
}

function factsSummary(facts: ProjectFacts): string {
  const dirs = facts.tree.dirs
    .slice(0, 14)
    .map((d) => `- \`${d.name}/\` (${d.files} files)`)
    .join("\n")
  return `- Name: ${facts.name}
- Shape: ${facts.workspace.kind === "none" ? "single package" : `${facts.workspace.kind} workspace`}, ${facts.packageManager}
- Frameworks: ${facts.frameworks.join(", ") || "unknown"}
- CI: ${facts.ci.system}
- Top-level layout:
${dirs || "- (single package)"}`
}

function agentBrief(facts: ProjectFacts): string {
  return `# Reckoning brief — ${facts.name}

You are completing the **semantic half** of this project's operating contract. etymd has already
gathered the deterministic facts below. Your job is to fill in what only reading the code reveals.
Ground every answer in real files; cite paths. Do not invent structure. When unsure, say so.

## Facts already known (do not re-derive)

${factsSummary(facts)}

## Produce these sections

1. **What this project is** — one paragraph: what it does, who uses it, the core domain.
2. **Composition points** — the 4–8 architectural seams a change usually flows through (entry
   points, routers, the data-access layer, the shared contract surface). For each: file path +
   one line on the invariant that must not break when editing it.
3. **Reuse inventory** — the existing components/hooks/utils/types a new task most often should
   reuse instead of writing fresh. Point at where they live.
4. **Ownership boundaries** — which directories own which concerns; what must not leak across them.
5. **Gotchas** — non-obvious rules, environment traps, or footguns worth a failure-modes entry.

## Output

Write your answer to \`AGENTS.md\` under the matching headings (replace the \`<!-- ... -->\`
placeholders), or return it for review. The human approves before it becomes the contract.
`
}

function humanBrief(facts: ProjectFacts): string {
  return `# Onboarding — ${facts.name}

A quick orientation generated from the project reckoning.

## At a glance

${factsSummary(facts)}

## Getting started

\`\`\`bash
${facts.commands.dev ? `${facts.packageManager} ${facts.commands.dev}   # run locally` : "# add the dev command"}
${facts.commands.test ? `${facts.packageManager} ${facts.commands.test}  # run tests` : ""}
\`\`\`

## Where to look next

- \`AGENTS.md\` — the operating contract (stack, rules, repo map, definition of done).
- \`PROJECT_CONTEXT.md\` — current state and decisions.

_This is a starting point. Refine it with the domain knowledge only the team has._
`
}
