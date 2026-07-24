import { EXTRACTION_THRESHOLD, measureContext } from "../core/context.js"
import { print, renderContext } from "../ui/render.js"

export interface ContextOptions {
  cwd: string
  json?: boolean
}

export async function run(opts: ContextOptions): Promise<void> {
  const budget = await measureContext(opts.cwd)

  if (opts.json) {
    print(JSON.stringify(budget, null, 2))
    return
  }

  renderContext(budget, EXTRACTION_THRESHOLD)
}
