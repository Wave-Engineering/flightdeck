#!/usr/bin/env bash
#
# Release guard (#24): the git tag and package.json version must agree.
#
# package.json sat at 0.1.0 while the repo shipped v0.2.0 through v0.2.7 —
# nothing compared them, so the declared version silently drifted eight
# releases behind. Once the running service reports its version (/health + UI
# topbar), a drifted package.json is worse than no version at all: it reports a
# confident wrong answer during exactly the triage it exists to serve.
#
# Usage:  scripts/ci/check-version.sh [ref]
#   ref defaults to $GITHUB_REF. Non-tag refs are a no-op success (branch and
#   PR builds legitimately run ahead of the tag they will eventually carry).
set -euo pipefail

ref="${1:-${GITHUB_REF:-}}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ "$ref" != refs/tags/* ]]; then
  echo "check-version: ref '${ref:-<unset>}' is not a tag — nothing to compare."
  exit 0
fi

tag="${ref#refs/tags/}"
tag_version="${tag#v}"

# `|| true` is load-bearing: under `set -euo pipefail` a grep miss (or a missing
# package.json) would propagate through the command substitution and kill the
# script here, skipping the diagnostic below — a bare non-zero in CI during the
# one scenario the message exists for.
pkg_version="$(
  # Read the field without assuming jq is present on the runner.
  grep -m1 '"version"' "$root/package.json" 2>/dev/null \
    | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' || true
)"

if [[ -z "$pkg_version" ]]; then
  echo "check-version: FAIL — could not read \"version\" from package.json" >&2
  exit 1
fi

if [[ "$tag_version" != "$pkg_version" ]]; then
  cat >&2 <<EOF
check-version: FAIL — version drift.

  git tag        : $tag  (semver: $tag_version)
  package.json   : $pkg_version

The image bakes the GIT TAG into FLIGHTDECK_VERSION (release.yml feeds it
docker/metadata-action's semver output), and /health and the UI topbar report
that. This guard is what keeps package.json honest against the tag — the two
are equal only because this fails when they are not. Shipping would leave
package.json claiming a version the build does not carry. Update package.json
to $tag_version (or retag), then re-run.
EOF
  exit 1
fi

echo "check-version: OK — tag $tag matches package.json $pkg_version"
