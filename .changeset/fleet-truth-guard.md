---
"etymd": minor
---

Fleet mode — the truth guard across your repositories (design record `docs/design/004-fleet-truth-guard.md`; registry + fleet `--json` schemas EXPERIMENTAL through 0.2.x).

- New `state-freshness` truth lens: state/decisions artifacts dated by git committer dates only (never mtime); staleness is relative, so a dormant repo's old state is current; state char budget against the ~10k session-hook truncation; marker-gated decisions format checks (`Scope:`, duplicate/out-of-order `D-NNN` ids, past `Revisit:` dates as due review debt); ADR conventions (`docs/adr/`, `docs/decisions/`, `NNNN-*.md`) recognized natively.
- New `etymd fleet` command family. The sweep runs a read-only audit per registered repo (`--manifest` required unless the cwd holds `registry.json` — no env var, no global pointer) and renders one line per project with a delta against `last.fleet.json`; detail only for new or risk findings. `fleet check` validates the manifest pair alone (dangling mappings, duplicate names, privacy leaks, machine paths). `fleet dismiss`/`fleet accept` resolve a project's finding from any cwd.
- The manifest loader (`src/core/fleet.ts`) resolves both the fleet registry pair (`registry.json` + gitignored `registry.local.json`) and the legacy corpus pair (`sources.json` + `sources.local.json`); corp entries are opaque aliases resolved only through the local file, and every resolution failure is disclosed, never silently skipped.
- Persistence invariants, pinned by tests: the sweep never creates `.etymd` anywhere; `--persist-ledgers` only persists into personal repos that already opted in; corp worktrees take zero writes under every flag combination — corp findings persist (and stay dismissible) at `<manifestDir>/corp/<name>/.etymd/`; zero corp-resolved content under the manifest repo's tracked paths.
- Fleet-scope wall findings (lens id `fleet-manifest`): corp contract files inside a corp worktree, unregistered corp-remote checkouts under the fleet root, tracked `/Users/` paths in the manifest's own repo, private needles inside `trust: "public-repo"` entries, corp-host commit emails on personal entries.
- Fork-aware freshness: entries with `upstream` are dated on fork-authored commits only (`HEAD --not --remotes=<upstream>`), with a disclosed fallback when the remote is absent.
