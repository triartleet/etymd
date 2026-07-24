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
  .name("etymd")
  .description(
    "Keep your agent instructions true — verify AGENTS.md & friends against the actual repo, on a budget, with drift caught over time.",
  )
  .version(VERSION, "-v, --version")
  .option("--cwd <dir>", "run against a different project directory", process.cwd())

program
  .command("audit")
  .description("Verify every instruction claim against the repo: ranked findings + ledger diff")
  .option("--json", "print the machine-stable audit result as JSON")
  .option("--truth", "truth lenses only (the doctor subset)")
  .option("--lens <id>", "run a single lens (instruction-truth | gate-integrity | context-economy)")
  .option("--no-ledger", "read-only: do not persist the reconciled ledger")
  .option(
    "--fail-on <tier>",
    "exit non-zero when findings at/above this tier exist (risk|gap|polish)",
  )
  .action((opts, cmd) =>
    action(async () => {
      const { run } = await import("./commands/audit.js")
      await run({
        cwd: resolveCwd(cmd),
        json: opts.json,
        truth: opts.truth,
        lens: opts.lens,
        noLedger: !opts.ledger,
        failOn: opts.failOn,
      })
    }),
  )

program
  .command("init")
  .description("Onboard the truth guard: approve the baseline; scaffold AGENTS.md only if missing")
  .option("-y, --yes", "accept defaults without prompting (never overwrites)")
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
  .option("--no-save", "do not write the .etymd cache")
  .action((opts, cmd) =>
    action(async () => {
      const { run } = await import("./commands/scan.js")
      await run({ cwd: resolveCwd(cmd), json: opts.json, save: opts.save })
    }),
  )

program
  .command("doctor")
  .description('Alias for `audit --truth` — "are the recorded instructions still true?"')
  .option("--json", "print findings as JSON")
  .action((opts, cmd) =>
    action(async () => {
      const { run } = await import("./commands/doctor.js")
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
  .description("Install the local git-hook gates (process → pre-commit, correctness → pre-push)")
  .option("--ci", "note about the CI review gate (ships later; local gates install now)")
  .option("-y, --yes", "skip prompts; never overwrites a hand-edited hook")
  .action((opts, cmd) =>
    action(async () => {
      const { run } = await import("./commands/gates.js")
      await run({ cwd: resolveCwd(cmd), ci: opts.ci, yes: opts.yes })
    }),
  )

program.parseAsync(process.argv)
