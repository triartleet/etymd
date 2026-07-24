import path from "node:path"

import { Command } from "commander"
import pc from "picocolors"

import { VERSION } from "./version.js"

interface GlobalOpts {
  cwd: string
}

function resolveCwd(cmd: Command): string {
  const opts = cmd.optsWithGlobals() as GlobalOpts
  return path.resolve(opts.cwd ?? process.cwd())
}

/** Run a command action, turning any throw into a clean one-line error + non-zero exit. */
async function action(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`\n${pc.red("✖")} ${message}\n`)
    process.exitCode = 1
  }
}

const program = new Command()

program
  .name("clothaid")
  .description(
    "Agent-agnostic agentic-workflow CLI — reckon, set up, and keep an AI-agent workflow honest.",
  )
  .version(VERSION, "-v, --version")
  .option("--cwd <dir>", "run against a different project directory", process.cwd())

program
  .command("init")
  .description("Reckon the project and install/migrate/optimise the agent workflow (interactive)")
  .option("-y, --yes", "accept the suggested defaults without prompting")
  .action((opts, cmd) =>
    action(async () => {
      const { run } = await import("./commands/init.js")
      await run({ cwd: resolveCwd(cmd), yes: opts.yes })
    }),
  )

program
  .command("scan")
  .description("Deterministically reckon the project into a facts index")
  .option("--json", "print the raw facts as JSON")
  .option("--no-save", "do not write .clothaid/facts.json")
  .action((opts, cmd) =>
    action(async () => {
      const { run } = await import("./commands/scan.js")
      await run({ cwd: resolveCwd(cmd), json: opts.json, save: opts.save })
    }),
  )

program
  .command("score")
  .description("Grade the project's agentic-workflow maturity")
  .option("--json", "print the scorecard as JSON")
  .action((opts, cmd) =>
    action(async () => {
      const { run } = await import("./commands/score.js")
      await run({ cwd: resolveCwd(cmd), json: opts.json })
    }),
  )

program
  .command("context")
  .description("Measure the always-loaded context footprint and flag extraction candidates")
  .option("--json", "print the budget as JSON")
  .action((opts, cmd) =>
    action(async () => {
      const { run } = await import("./commands/context.js")
      await run({ cwd: resolveCwd(cmd), json: opts.json })
    }),
  )

program
  .command("doctor")
  .description("Audit whether the reckoning and contract are still true against the tree")
  .option("--json", "print findings as JSON")
  .action((opts, cmd) =>
    action(async () => {
      const { run } = await import("./commands/doctor.js")
      await run({ cwd: resolveCwd(cmd), json: opts.json })
    }),
  )

program
  .command("brief")
  .description("Emit a grounded briefing for the in-repo agent to complete the semantic layer")
  .option("--human", "write a human onboarding brief instead of the agent briefing")
  .action((opts, cmd) =>
    action(async () => {
      const { run } = await import("./commands/brief.js")
      await run({ cwd: resolveCwd(cmd), human: opts.human })
    }),
  )

program
  .command("gates")
  .description(
    "Install the free local git-hook gates (process → pre-commit, correctness → pre-push)",
  )
  .option("--ci", "also address the advisory AI-review CI job (planned)")
  .option("-y, --yes", "skip the confirmation prompt")
  .action((opts, cmd) =>
    action(async () => {
      const { run } = await import("./commands/gates.js")
      await run({ cwd: resolveCwd(cmd), ci: opts.ci, yes: opts.yes })
    }),
  )

// Designed, reserved for a coming release — registered so the surface is complete and honest.
const later: [string, string][] = [
  [
    "metrics",
    "Instrument the loop (session weight, iterations, reversals, rework/revert) vs a baseline.",
  ],
  [
    "harvest",
    "Read the evolved source projects and propose updates to the versioned knowledge pack.",
  ],
  ["dashboard", "Zero-infra local surface for metrics, doctor status, and context budget."],
  ["session", "Session runner: open with the right context, close with an archived summary."],
  ["profile", "Shareable org leash/knowledge-pack presets applied across repos."],
]
for (const [name, summary] of later) {
  program
    .command(name)
    .description(`${summary} ${pc.dim("(planned)")}`)
    .action(() =>
      action(async () => {
        const { planned } = await import("./commands/planned.js")
        planned(name, summary)
      }),
    )
}

program.parseAsync(process.argv)
