#!/usr/bin/env bash
# Builds the Claude Desktop extension (MCP bundle) from an already built dist/.
# Usage: scripts/build-mcpb.sh [output-dir]   (default: ./build)
# Prints the path of the .mcpb it wrote on the last line of its output.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out_dir="$(cd "$root" && mkdir -p "${1:-build}" && cd "${1:-build}" && pwd)"
cd "$root"

version="$(node -p 'require("./package.json").version')"
manifest_version="$(node -p 'require("./mcpb/manifest.json").version')"
if [ "$manifest_version" != "$version" ]; then
  echo "mcpb/manifest.json says $manifest_version, package.json says $version" >&2
  exit 1
fi
[ -f dist/index.js ] || { echo "dist/index.js missing: run npm run build first" >&2; exit 1; }

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

# What the server needs at run time and nothing else: the compiled server,
# package.json (it reads its own version from there), the production
# dependencies exactly as locked, and the bundle's own files.
cp -R dist package.json package-lock.json LICENSE README.md PRIVACY.md "$stage/"
cp mcpb/manifest.json mcpb/launch.js "$stage/"
cp assets/icon.png "$stage/icon.png"
# --ignore-scripts: `prepare` would try to build again, without TypeScript.
(cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
rm "$stage/package-lock.json"

npx --no-install mcpb validate "$stage/manifest.json"
file="$out_dir/serato-dj-mcp-$version.mcpb"
rm -f "$file"
npx --no-install mcpb pack "$stage" "$file" >/dev/null
echo "$file"
