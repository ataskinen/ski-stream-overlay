#!/bin/bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
bundle="$project_root/dist/SkiRaceOverlay.plugin"
destination="$HOME/Library/Application Support/obs-studio/plugins/SkiRaceOverlay.plugin"
if [[ ! -d "$bundle" ]]; then echo "Build the plugin first with bash scripts/build-plugin.sh" >&2; exit 1; fi
if pgrep -x OBS >/dev/null; then echo "Close OBS before installing, then run this command again." >&2; exit 1; fi
codesign --verify --deep --strict "$bundle"
mkdir -p "$(dirname "$destination")"
if [[ -e "$destination" ]]; then
  backup="${destination}.backup-$(date +%Y%m%d-%H%M%S)-$$"
  mv "$destination" "$backup"
  echo "Previous plugin saved at $backup"
fi
ditto "$bundle" "$destination"
echo "Installed $destination"
echo "Open OBS, then Sources > + > Ski Race Overlay. Open race control from source properties."
