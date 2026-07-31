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
  .option(
    "--lens <id>",
    "run a single lens (instruction-truth | state-freshness | gate-integrity | context-economy)",
  )
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
  .command("approve")
  .description(
    "Re-approve the committed baseline after intentional structural changes (non-interactive)",
  )
  .action((_opts, cmd) =>
    action(async () => {
      const { run } = await import("./commands/approve.js")
      await run({ cwd: resolveCwd(cmd) })
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
  .command("ledger")
  .description("List every tracked finding grouped by status (open · accepted · dismissed · …)")
  .option("--json", "print the raw ledger as JSON")
  .action((opts, cmd) =>
    action(async () => {
      const { list } = await import("./commands/ledger.js")
      await list({ cwd: resolveCwd(cmd), json: opts.json })
    }),
  )

program
  .command("dismiss")
  .argument("<finding-id>", "the finding id (from `etymd audit`) to dismiss")
  .description("Dismiss a finding as a false positive / not applicable (hidden from future audits)")
  .requiredOption("--reason <text>", "why it is dismissed — recorded so the decision survives")
  .action((id, opts, cmd) =>
    action(async () => {
      const { dismiss } = await import("./commands/ledger.js")
      await dismiss({ cwd: resolveCwd(cmd), id, reason: opts.reason })
    }),
  )

program
  .command("accept")
  .argument("<finding-id>", "the finding id (from `etymd audit`) to accept")
  .description("Accept a real finding as a known trade-off (hidden from future audits)")
  .option("--reason <text>", "optional note on why the trade-off is accepted")
  .action((id, opts, cmd) =>
    action(async () => {
      const { accept } = await import("./commands/ledger.js")
      await accept({ cwd: resolveCwd(cmd), id, reason: opts.reason })
    }),
  )

const fleet = program
  .command("fleet")
  .description(
    "Sweep every project in a fleet manifest: per-repo audits + manifest-truth wall checks (schemas EXPERIMENTAL through 0.2.x)",
  )
  .option(
    "--manifest <file>",
    "the fleet manifest (registry.json / legacy sources.json) — required unless the cwd holds registry.json",
  )
  .option("--only <names...>", "sweep only these registered names")
  .option("--profile <profile>", "sweep only entries with this profile (personal|corp)")
  .option("--truth", "truth lenses only per repo (the doctor subset)")
  .option(
    "--persist-ledgers",
    "persist per-repo ledgers — personal-profile entries that already carry .etymd only; corp worktrees are never written",
  )
  .option("--json", "print the machine schema (EXPERIMENTAL through 0.2.x, local-only)")
  .option(
    "--fail-on <tier>",
    "exit non-zero when findings at/above this tier exist (risk|gap|polish)",
  )
  .action((opts, cmd) =>
    action(async () => {
      const { sweep } = await import("./commands/fleet.js")
      await sweep({
        cwd: resolveCwd(cmd),
        manifest: opts.manifest,
        only: opts.only,
        profile: opts.profile,
        truth: opts.truth,
        persistLedgers: opts.persistLedgers,
        json: opts.json,
        failOn: opts.failOn,
      })
    }),
  )

fleet
  .command("check")
  .description("Validate the manifest pair only — no lenses: dangling mappings, duplicates, leaks")
  .option("--manifest <file>", "the fleet manifest — required unless the cwd holds registry.json")
  .option("--json", "print the findings as JSON (EXPERIMENTAL through 0.2.x)")
  .action((opts, cmd) =>
    action(async () => {
      const { check } = await import("./commands/fleet.js")
      await check({ cwd: resolveCwd(cmd), manifest: opts.manifest, json: opts.json })
    }),
  )

fleet
  .command("dismiss")
  .argument("<name>", "the registered project name")
  .argument("<finding-id>", "the finding id (from `etymd fleet`) to dismiss")
  .description(
    "Dismiss a project's finding from any cwd — corp ledgers persist beside the manifest",
  )
  .requiredOption("--reason <text>", "why it is dismissed — recorded so the decision survives")
  .option("--manifest <file>", "the fleet manifest — required unless the cwd holds registry.json")
  .action((name, id, opts, cmd) =>
    action(async () => {
      const { dismiss } = await import("./commands/fleet.js")
      await dismiss({
        cwd: resolveCwd(cmd),
        manifest: opts.manifest,
        name,
        id,
        reason: opts.reason,
      })
    }),
  )

fleet
  .command("accept")
  .argument("<name>", "the registered project name")
  .argument("<finding-id>", "the finding id (from `etymd fleet`) to accept")
  .description(
    "Accept a project's finding as a known trade-off — corp ledgers persist beside the manifest",
  )
  .option("--reason <text>", "optional note on why the trade-off is accepted")
  .option("--manifest <file>", "the fleet manifest — required unless the cwd holds registry.json")
  .action((name, id, opts, cmd) =>
    action(async () => {
      const { accept } = await import("./commands/fleet.js")
      await accept({ cwd: resolveCwd(cmd), manifest: opts.manifest, name, id, reason: opts.reason })
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
