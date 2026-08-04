---
"etymd": patch
---

Gate integrity: detect scripts regardless of how the package manager is invoked.

Script expansion guessed the script name positionally — the token straight after the
manager. That only holds for `npm run x`, `yarn x` and `pnpm x`. Every other live shape
expanded to nothing, so the tool was never detected and the gate read as absent:

| invocation                           | captured as the script name |
| ------------------------------------ | --------------------------- |
| `pnpm run typecheck`                 | `run`                       |
| `pnpm -s typecheck`                  | `-s`                        |
| `pnpm -r --if-present run typecheck` | `-r`                        |
| `pnpm --filter @scope/pkg test`      | `--filter`                  |

A pre-push hook running `pnpm run typecheck` therefore reported as having no typecheck at
all, and `audit` said "type checking is enforced only in CI — no local hook runs it" while
the hook ran it on every push.

Expansion no longer guesses position — it cannot, since the position depends on each
manager's own flag grammar. It scans the invocation's tokens for a name that is a known
script, which needs no grammar at all. Package-manager built-ins are excluded so `npm ci`
is never read as "runs the `ci` script"; that direction matters, because expanding it would
claim a gate is covered by a line that only installs dependencies. `test` and `start` stay
recognised — those genuinely are script shortcuts. `exec`/`dlx` end the scan, since what
follows is a binary, and `npx` is only scanned for `run-s`/`run-p`/`npm-run-all`.
