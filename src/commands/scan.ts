import { writeFacts } from "../core/facts.js"
import { scanProject } from "../core/scan.js"
import { renderFacts, print } from "../ui/render.js"
import { theme } from "../ui/theme.js"

export interface ScanOptions {
  cwd: string
  json?: boolean
  save?: boolean
}

export async function run(opts: ScanOptions): Promise<void> {
  const facts = await scanProject(opts.cwd)

  if (opts.json) {
    print(JSON.stringify(facts, null, 2))
    return
  }

  renderFacts(facts)
  if (opts.save !== false) {
    const target = await writeFacts(opts.cwd, facts)
    print()
    print(`  ${theme.dim("saved reckoning →")} ${theme.info(target)}`)
  }
}
