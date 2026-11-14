#!/usr/bin/env bash
# Builds and packs the adapter at the repository root, then installs the
# tarball into this app the way a user installs the published package: only
# the files the package ships.
set -euo pipefail

app="$(cd "$(dirname "$0")/.." && pwd)"
adapter="$(cd "$app/../.." && pwd)"
out="$app/.adapter"
tarball_name="better-auth-elasticsearch.tgz"
tarball="$out/$tarball_name"

rm -rf "$out"
mkdir -p "$out"

(
  cd "$adapter"
  pnpm install --frozen-lockfile --ignore-scripts
  pnpm build
  pnpm pack --pack-destination "$out"
)

# A fixed name keeps package.json stable across adapter version bumps.
mv "$out"/*.tgz "$tarball"

cd "$app"
pnpm add "better-auth-elasticsearch@file:.adapter/$tarball_name" --ignore-scripts

# The adapter peers on better-auth; a second copy means the peer did not
# resolve to the app's own better-auth.
copies="$(find node_modules/.pnpm -maxdepth 1 -name 'better-auth@*')"
if [ "$(printf '%s\n' "$copies" | grep -c .)" -ne 1 ]; then
  printf 'Expected one copy of better-auth, found:\n%s\n' "$copies" >&2
  exit 1
fi
