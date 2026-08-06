#!/usr/bin/env sh
# etymd: content screen — the published ARTIFACT, not the repository.
#
# Wire it into the irreversible moment:
#   package.json → "prepublishOnly": "./scripts/artifact-check.sh"
#
# No-op where no checker is installed. Bypass is deliberate and loud: ARTIFACT_CHECK_SKIP=1.
set -eu

if [ "${ARTIFACT_CHECK_SKIP:-0}" = "1" ]; then
  echo "› artifact-check: SKIPPED by ARTIFACT_CHECK_SKIP=1"
  exit 0
fi

GATE="${CONTENT_GATE:-$(command -v etymd || true)}"
[ -x "$GATE" ] || { echo "› artifact-check: no checker installed — skipping."; exit 0; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

# Pack exactly what would ship, then screen the unpacked bytes.
if [ -f package.json ]; then
  npm pack --pack-destination "$WORK" >/dev/null 2>&1 || {
    echo "› artifact-check: npm pack failed — cannot verify what would ship" >&2; exit 1; }
  tar -xzf "$WORK"/*.tgz -C "$WORK" 2>/dev/null || true
fi

"$GATE" screen --dir "$WORK" || exit 1
exit 0
