#!/usr/bin/env bash
# DeepSeek Harness desktop launcher (source tree / manual installs).
# Resolves a Node runtime and runs the packaged AppImage, or `electron .` from
# source when not packaged. Self-contained: works from a .desktop launch where
# mise/shell PATH is absent.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NODE=""
for c in "$HOME/.local/share/mise/installs/node/latest/bin/node" /usr/bin/node; do
  [ -x "$c" ] && { NODE="$c"; break; }
done
if [ -z "$NODE" ]; then NODE="$(command -v node || true)"; fi
[ -n "$NODE" ] || { echo "dsh-desktop: no Node runtime found" >&2; exit 1; }

export DSH_NODE="$NODE"

APPIMG="$(compgen -G "$DIR/dist/dsh-desktop-*.AppImage" | head -1 || true)"
if [ -n "$APPIMG" ] && [ -x "$APPIMG" ]; then
  exec "$APPIMG"
else
  exec "$DIR/node_modules/.bin/electron" "$DIR"
fi