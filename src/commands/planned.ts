import { print, section } from "../ui/render.js"
import { glyph, theme } from "../ui/theme.js"

/** A shared, honest handler for commands whose design is locked but whose build is a later release. */
export function planned(name: string, summary: string): void {
  section(`${theme.brand("clothaid " + name)} ${theme.dim("· planned")}`)
  print(`  ${glyph.partial} ${theme.dim(summary)}`)
  print()
  print(
    `  ${theme.dim("Designed and reserved for a coming release. Track progress in the repo roadmap.")}`,
  )
}
