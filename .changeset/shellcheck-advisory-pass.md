---
"etymd": patch
---

Fix: the shell gate now actually prints the sub-warning findings it documented.

0.4.0 said "style and info print as advice" and did not do it — the generated hook ran only
`shellcheck -S warning` and discarded everything below that bar. The generated file made no such
claim, so no repo was misled about what its own gate does, but the promise was in the release
notes and not in the code.

The hook now runs a second, non-blocking pass after the blocking one and prints what it finds.
Its result is captured into a variable and explicitly tolerated with `|| true`, so it has no path
to the exit code: advice that can fail a push is not advice. The blocking bar is unchanged.

The test that was supposed to protect this pinned the wrong property — it asserted that style was
never MENTIONED, which the buggy version satisfied. It now asserts that the warning pass is the
only one wired to a failure branch, which is the property that actually matters.

Pack version 5.
