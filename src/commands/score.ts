import { readFacts } from "../core/facts.js"
import { scanProject } from "../core/scan.js"
import { scoreProject } from "../core/score.js"
import { print, renderScorecard } from "../ui/render.js"
import { theme } from "../ui/theme.js"

export interface ScoreOptions {
  cwd: string
  json?: boolean
}

export async function run(opts: ScoreOptions): Promise<void> {
  const facts = (await readFacts(opts.cwd)) ?? (await scanProject(opts.cwd))
  const card = scoreProject(facts)

  if (opts.json) {
    print(JSON.stringify(card, null, 2))
    return
  }

  renderScorecard(card)
  print()
  print(
    `  ${theme.dim("suggested setup mode:")} ${theme.info(card.suggestedMode)}  ${theme.dim("· run")} ${theme.code("clothaid init")}`,
  )
}
