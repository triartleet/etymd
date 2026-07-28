import { readConfig } from "../core/config.js"
import { measureContext } from "../core/context.js"
import { print, renderContext } from "../ui/render.js"

export interface ContextOptions {
  cwd: string
  json?: boolean
}

export async function run(opts: ContextOptions): Promise<void> {
  const { config, problems } = await readConfig(opts.cwd)
  const budget = await measureContext(opts.cwd, config.context.perFileWords)

  if (opts.json) {
    print(JSON.stringify(budget, null, 2))
    return
  }

  for (const problem of problems) print(problem)
  renderContext(budget, budget.perFileWords)
}
