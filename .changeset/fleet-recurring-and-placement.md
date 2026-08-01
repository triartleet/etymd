---
"etymd": patch
---

Fleet sweep: recurring classes + `placement: "none"` honored.

- **Recurring classes** — the sweep report groups open findings by their engine-minted
  class prefix and lists every class present in ≥2 projects (worst tier first). A class
  open in one repo is that repo's problem; the same class in four is a fleet lesson —
  the report now asks "repo bug or fleet bug?" structurally, instead of relying on a
  human to ask it at triage time. `--json` gains a `recurringClasses` array
  (schema still EXPERIMENTAL through 0.2.x).
- **`placement: "none"` suppresses `no-contract`** — a registry entry declaring its
  contract files legitimately absent no longer gets the absence re-reported every sweep.
  The repo-local lens can't see the registry's declaration, so the fleet view honors it
  (a standalone `etymd audit` in such a repo still reports it — correctly, since no
  declaration is in scope there). Tier counts summarize the filtered list.
