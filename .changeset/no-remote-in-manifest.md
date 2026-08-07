---
"etymd": minor
---

`fleet add` no longer records a remote URL in the manifest.

The field was write-only: nothing in the tool ever read it back. It was persisted because it
happened to be derivable at registration time, and it stayed because no one asked what consumed
it.

It is also the field that turned a mis-profiled entry into a real disclosure. A raw remote URL
carries the host and the internal group path; `path` carries a bare directory name. Removing a
field no consumer reads retires that class outright, with no host-matching heuristic, and unlike
the corp-host guard it keeps working on a machine that has no local manifest to read corp hosts
from. The remote stays derivable from the checkout at any time, which is where it came from.

Existing entries that already carry a remote are left alone — nothing reads them, and rewriting
a hand-maintained manifest to remove inert keys would be a worse trade than leaving them.
