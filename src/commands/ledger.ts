import { readLedger, resolveEntry, writeLedger, type HumanResolution } from "../engine/ledger.js"
import { print, renderLedger } from "../ui/render.js"
import { glyph, theme } from "../ui/theme.js"

export interface LedgerListOptions {
  cwd: string
  json?: boolean
}

export interface ResolveOptions {
  cwd: string
  id: string
  /** Required for dismiss (the decision must survive); optional for accept. */
  reason?: string
}

/** `etymd ledger` — list every tracked finding grouped by status. */
export async function list(opts: LedgerListOptions): Promise<void> {
  const ledger = await readLedger(opts.cwd)
  if (opts.json) {
    print(JSON.stringify(ledger, null, 2))
    return
  }
  renderLedger(ledger)
}

async function resolve(opts: ResolveOptions, status: HumanResolution): Promise<void> {
  if (status === "dismissed" && !opts.reason?.trim()) {
    throw new Error('dismiss needs a reason: etymd dismiss <finding-id> --reason "…"')
  }
  const ledger = await readLedger(opts.cwd)
  const { ledger: next, entry } = resolveEntry(ledger, opts.id, status, opts.reason?.trim())
  if (!entry) {
    throw new Error(
      `no finding \`${opts.id}\` in the ledger — run \`etymd audit\` first so it is recorded, then retry`,
    )
  }
  await writeLedger(opts.cwd, next)
  const verb = status === "dismissed" ? "dismissed" : "accepted"
  print(
    `  ${glyph.ok} ${theme.dim(verb)} ${theme.info(entry.id)}${entry.reason ? theme.dim(` — “${entry.reason}”`) : ""}`,
  )
  print(`  ${theme.dim("hidden from future audits until it disappears (then counted resolved).")}`)
}

/** `etymd dismiss <id> --reason "…"` — mark a finding a false positive / not-applicable. */
export async function dismiss(opts: ResolveOptions): Promise<void> {
  await resolve(opts, "dismissed")
}

/** `etymd accept <id>` — accept a real finding as a known trade-off. */
export async function accept(opts: ResolveOptions): Promise<void> {
  await resolve(opts, "accepted")
}
