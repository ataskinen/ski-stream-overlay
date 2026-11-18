#!/bin/bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
obs_app="${OBS_APP:-/Applications/OBS.app}"
obs_version="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$obs_app/Contents/Info.plist")"
if [[ "$obs_version" != "33.0.1" ]]; then
  echo "This build targets OBS 33.0.1; found $obs_version. Update and verify SDK compatibility first." >&2
  exit 1
fi
sdk_dir="${OBS_SOURCE_DIR:-$project_root/.build/obs-studio-33.0.1}"
mkdir -p "$project_root/.build"
if [[ ! -f "$sdk_dir/libobs/obs-module.h" ]]; then
  curl -L --fail https://github.com/obsproject/obs-studio/archive/refs/tags/33.0.1.tar.gz -o "$project_root/.build/obs-source.tar.gz"
  tar -xzf "$project_root/.build/obs-source.tar.gz" -C "$project_root/.build"
fi
simde_dir="${SIMDE_SOURCE_DIR:-$project_root/.build/simde-0.8.2}"
if [[ ! -f "$simde_dir/simde/x86/sse2.h" ]]; then
  curl -L --fail https://github.com/simd-everywhere/simde/archive/refs/tags/v0.8.2.tar.gz -o "$project_root/.build/simde-source.tar.gz"
  tar -xzf "$project_root/.build/simde-source.tar.gz" -C "$project_root/.build"
fi
mkdir -p "$project_root/.build/include"
cat > "$project_root/.build/include/obsconfig.h" <<'EOF'
#pragma once
#define OBS_DATA_PATH "data"
#define OBS_PLUGIN_PATH "obs-plugins"
#define OBS_PLUGIN_DESTINATION "obs-plugins"
#define OBS_RELEASE_CANDIDATE 0
#define OBS_BETA 0
EOF
bundle="$project_root/dist/SkiRaceOverlay.plugin"
if [[ -e "$bundle" ]]; then rm -rf "$bundle"; fi
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources/app" "$bundle/Contents/Resources/runtime"
clang++ -std=c++17 -arch arm64 -mmacosx-version-min=13.0 -fvisibility=hidden -bundle \
  -Wall -Wextra -Werror -I "$sdk_dir/libobs" -I "$project_root/.build/include" -I "$simde_dir" \
  "$project_root/native/ski-race-overlay.cpp" \
  -F "$obs_app/Contents/Frameworks" -framework libobs \
  -Wl,-rpath,@executable_path/../Frameworks \
  -o "$bundle/Contents/MacOS/SkiRaceOverlay"
cp "$project_root/native/Info.plist" "$bundle/Contents/Info.plist"
cp "$project_root/native/COPYING" "$bundle/Contents/Resources/COPYING"
node_binary="${NODE_BINARY:-$(command -v node)}"
if [[ "$("$node_binary" -p process.arch)" != "arm64" ]]; then
  echo "An arm64 Node.js runtime is required for this Mac build." >&2
  exit 1
fi
cp "$node_binary" "$bundle/Contents/Resources/runtime/node"
node_license="$(dirname "$node_binary")/../LICENSE"
if [[ ! -f "$node_license" ]]; then echo "Node.js LICENSE file missing beside runtime installation." >&2; exit 1; fi
cp "$node_license" "$bundle/Contents/Resources/runtime/LICENSE"
cp "$project_root/server.mjs" "$project_root/package.json" "$bundle/Contents/Resources/app/"
cp -R "$project_root/lib" "$project_root/public" "$project_root/examples" "$project_root/simulator" "$bundle/Contents/Resources/app/"
codesign --force --sign - "$bundle/Contents/Resources/runtime/node"
codesign --force --sign - "$bundle"
codesign --verify --deep --strict "$bundle"
echo "Built $bundle"
echo "Install after closing OBS: bash scripts/install-plugin.sh"
