---
"etymd": patch
---

The build tooling's source-map-js dependency moves to 1.2.2, the fix for a
denial-of-service advisory (GHSA-68fv-2mgg-jv7q) in parsing indexed source-map
sections. It is a build-time dependency reached through tsup and postcss, so
nothing changes for anyone installing etymd.
