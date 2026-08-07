---
"etymd": minor
---

Gate the shell surface: `etymd gates` now installs a shellcheck step in repos that have one.

Package scripts are not the only executable surface a repo has, and in some repos they are not
the main one. A tools or infra repo can be entirely `bootstrap/*.sh` plus `.githooks/*` with no
`package.json` at all — and those repos were told "no correctness commands detected", which reads
as "nothing to check" when it means "nothing was looked at".

The scan now counts tracked files a shell executes (`facts.shell.scripts`), by extension and by
shebang, and the generated pre-push gains a shellcheck step when that count is non-zero. Three
properties, each one a lesson from a gate that failed:

- Scripts are re-discovered inside the hook at push time, by shebang over tracked files, never
  baked in as a list. A generated list is correct the day it is written and silently wrong the
  first time someone adds a script.
- A missing shellcheck binary is a loud skip that names the install command, never a quiet pass.
  A check that goes silent when its tool is absent looks installed on every machine and is
  installed on one.
- The blocking bar is severity `warning`; style and info print as advice. A gate with a high
  false-positive rate does not make a repo careful, it teaches everyone the bypass flag — and
  that flag is shared with the content screen, which must never be bypassed.

The install summary lists the step too, so accepting the plan shows what will actually run.
Pack version 4.
