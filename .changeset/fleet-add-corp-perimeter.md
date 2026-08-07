---
"etymd": patch
---

Fix: `fleet add --profile corp` was silently ignored, registering employer repos as personal.

`fleet` declares its own `--profile` (the sweep filter), and commander hands a parent-declared
option the value even when it is typed after the subcommand. So `fleet add <dir> --profile corp`
left the subcommand's own option undefined, the placement fell back to personal, and the
personal branch records `path` and the RAW `remote` — writing the employer host and its internal
group structure into a manifest that is tracked and pushed. That is precisely the disclosure the
alias convention exists to prevent. The same shadowing class was already fixed for `--manifest`
and `--json`; `--profile` was missed.

Two changes, because the flag alone is not enough. The CLI now reads the merged option view, so
the flag works. And `fleet add` refuses outright when the target's remote matches a corp host
declared in the local manifest while the profile is not corp — the manifest already knows which
hosts are the employer's and the remote has just been read, so the tool has every fact needed to
prevent this without anyone remembering a flag. It refuses rather than auto-correcting:
placement is the user's decision, but it may not be made by omission.
