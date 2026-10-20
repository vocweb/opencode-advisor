#!/usr/bin/env bash
# Install the advisor plugin for opencode.
#   scripts/install.sh            -> global  (~/.config/opencode/plugins)
#   scripts/install.sh --project  -> current project (.opencode/plugins)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -f "$here/dist/advisor.js" ]]; then
  echo "dist/advisor.js missing; building..." >&2
  (cd "$here" && npm install --no-audit --no-fund && npm run build)
fi
if [[ "${1:-}" == "--project" ]]; then
  dest="$PWD/.opencode"
else
  dest="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
fi
mkdir -p "$dest/plugins"
cp "$here/dist/advisor.js" "$dest/plugins/advisor.js"
echo "Installed: $dest/plugins/advisor.js"
cfg="$dest/WATCHDOG.yml"
if [[ ! -e "$cfg" ]]; then
  cp "$here/WATCHDOG.example.yml" "$cfg"
  echo "Wrote a starter config: $cfg  (set modelRoles.advisor to enable reviews)"
else
  echo "Kept existing config: $cfg"
fi
echo "Restart opencode, then run /advisor to check status."
