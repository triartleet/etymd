---
"etymd": minor
---

`fleet add --profile corp` now records the alias-to-directory mapping too, not just the entry.

A corp entry in the tracked manifest is deliberately alias-only — no path, no remote — which is
what keeps employer names out of a file that gets pushed. It also means the entry resolves to
nothing on its own. Registering wrote only that half, so every corp registration ended as a
dangling entry that `fleet check` reported immediately and the user had to fix by hand, in the
one file the tool otherwise never asks anyone to hand-edit.

The mapping is written `~`-relative, so the local manifest stays portable between machines, and
merged into the existing document so hand-maintained entries survive.

Two refusals guard it, because this file is the one place real employer directory names are
written down. If the local manifest is not gitignored, registration refuses rather than creating
a file git would track — a leak the tool creates is worse than a registration it declines to
finish. If the file exists but is not valid JSON, it refuses rather than overwriting mappings
that cannot be re-derived.

The mapping is written before the tracked entry. The failure modes are not symmetric: a mapping
without an entry is inert, while an entry without a mapping is a broken registration sitting in
the file that gets committed.
