import { readFacts } from "../core/facts.js"
import { scanProject } from "../core/scan.js"
import type { ProjectFacts } from "../core/types.js"
import { print, section } from "../ui/render.js"
import { glyph, theme } from "../ui/theme.js"

export interface DoctorOptions {
  cwd: string
  json?: boolean
}

type Level = "ok" | "warn" | "bad"
interface Finding {
  level: Level
  text: string
}

const MARK: Record<Level, string> = { ok: glyph.ok, warn: glyph.partial, bad: glyph.bad }

/** Is this true anymore? Compare the cached reckoning + the contract's claims to today's tree. */
export async function run(opts: DoctorOptions): Promise<void> {
  const fresh = await scanProject(opts.cwd)
  const cached = await readFacts(opts.cwd)
  const findings: Finding[] = []

  if (!cached) {
    findings.push({
      level: "warn",
      text: "No cached reckoning — run `clothaid scan` first for drift detection.",
    })
  } else {
    findings.push(...compareCommands(cached, fresh))
    findings.push(...compareArtifacts(cached, fresh))
    findings.push(...compareLayout(cached, fresh))
    if (cached.packageManager !== fresh.packageManager) {
      findings.push({
        level: "warn",
        text: `Package manager changed: ${cached.packageManager} → ${fresh.packageManager}.`,
      })
    }
  }

  // Contract-consistency checks against the current tree.
  const contract = fresh.artifacts.find((a) => a.id === "agents")
  if (contract?.exists) {
    if (fresh.hooks.source === "githooks" && !fresh.git.hooksPath) {
      findings.push({
        level: "bad",
        text: "`.githooks/` exists but git `core.hooksPath` is unset — hooks will not run. Fix: `git config core.hooksPath .githooks`.",
      })
    }
    const stateDoc = fresh.artifacts.find((a) => a.id === "project-context")
    if (!stateDoc?.exists) {
      findings.push({
        level: "warn",
        text: "AGENTS.md points at a session protocol but there is no PROJECT_CONTEXT.md state doc.",
      })
    }
  } else {
    findings.push({ level: "warn", text: "No AGENTS.md operating contract — run `clothaid init`." })
  }

  if (!findings.some((f) => f.level !== "ok")) {
    findings.unshift({
      level: "ok",
      text: "Reckoning matches the tree; documented commands and artifacts still resolve.",
    })
  }

  if (opts.json) {
    print(JSON.stringify({ findings }, null, 2))
    return
  }

  section("Doctor — is this still true?")
  for (const f of findings) print(`  ${MARK[f.level]}  ${f.text}`)
  const bad = findings.filter((f) => f.level === "bad").length
  const warn = findings.filter((f) => f.level === "warn").length
  print()
  print(`  ${theme.dim(`${bad} blocking · ${warn} advisory`)}`)
}

function compareCommands(cached: ProjectFacts, fresh: ProjectFacts): Finding[] {
  const out: Finding[] = []
  for (const role of ["test", "lint", "typecheck", "format", "build"] as const) {
    const before = cached.commands[role]
    if (before && !(before in fresh.commands.raw)) {
      out.push({
        level: "bad",
        text: `Documented ${role} command \`${before}\` no longer exists in package.json.`,
      })
    }
  }
  return out
}

function compareArtifacts(cached: ProjectFacts, fresh: ProjectFacts): Finding[] {
  const out: Finding[] = []
  const freshById = new Map(fresh.artifacts.map((a) => [a.id, a]))
  for (const a of cached.artifacts) {
    const now = freshById.get(a.id)
    if (a.exists && now && !now.exists) {
      out.push({
        level: "warn",
        text: `${a.label} was present at last scan but is now missing (${a.path}).`,
      })
    }
  }
  return out
}

function compareLayout(cached: ProjectFacts, fresh: ProjectFacts): Finding[] {
  const out: Finding[] = []
  const now = new Set(fresh.tree.dirs.map((d) => d.name))
  for (const d of cached.tree.dirs) {
    if (!now.has(d.name)) {
      out.push({
        level: "warn",
        text: `Top-level \`${d.name}/\` in the reckoning no longer exists — the repo map may be stale.`,
      })
    }
  }
  return out
}
