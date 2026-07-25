import {
  deriveProfile,
  isDriftEmpty,
  readBaseline,
  summarizeBaselineDrift,
  writeBaseline,
} from "../core/facts.js"
import { scanProject } from "../core/scan.js"
import { PACK_VERSION } from "../pack/version.js"
import { print, renderBaselineDrift, section } from "../ui/render.js"
import { glyph, theme } from "../ui/theme.js"
import { VERSION } from "../version.js"

export interface ApproveOptions {
  cwd: string
}

/**
 * Re-approve the committed baseline after an *intentional* structural change — non-interactive,
 * so it fits scripts and post-refactor cleanups. Refresh, not onboarding: it requires an existing
 * baseline (run `etymd init` for the first one) and preserves that baseline's profile.
 */
export async function run(opts: ApproveOptions): Promise<void> {
  const prior = await readBaseline(opts.cwd)
  if (!prior) {
    throw new Error(
      "no committed baseline to re-approve — run `etymd init` to create the first one",
    )
  }

  const facts = await scanProject(opts.cwd)
  const drift = summarizeBaselineDrift(prior.facts, facts)

  section(`Re-approving baseline ${theme.dim(`· ${facts.name} · ${prior.profile} profile`)}`)
  if (isDriftEmpty(drift)) {
    print(`  ${theme.dim("no structural change on the measured axes — refreshing the stamp only")}`)
  } else {
    renderBaselineDrift(drift)
  }

  await writeBaseline(opts.cwd, {
    packVersion: PACK_VERSION,
    etymdVersion: VERSION,
    approvedAt: new Date().toISOString(),
    // A refresh re-blesses the current tree; the profile is a human decision from init — keep it.
    profile: prior.profile ?? deriveProfile(facts),
    facts,
  })

  print()
  print(
    `  ${glyph.ok} ${theme.dim("baseline re-approved →")} ${theme.info(".etymd/baseline.json")} ${theme.dim("(commit it — drift is now measured against this state)")}`,
  )
}
