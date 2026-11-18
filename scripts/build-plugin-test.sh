#!/bin/bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
obs_app="${OBS_APP:-/Applications/OBS.app}"
sdk_dir="${OBS_SOURCE_DIR:-$project_root/.build/obs-studio-33.0.1}"
simde_dir="${SIMDE_SOURCE_DIR:-$project_root/.build/simde-0.8.2}"
if [[ ! -f "$project_root/.build/include/obsconfig.h" ]]; then
  echo "Build the plugin first to prepare OBS SDK headers." >&2
  exit 1
fi
clang++ -std=c++17 -arch arm64 -mmacosx-version-min=13.0 \
  -Wall -Wextra -Werror -I "$sdk_dir/libobs" -I "$project_root/.build/include" -I "$simde_dir" \
  "$project_root/native/lifecycle-test.cpp" \
  -F "$obs_app/Contents/Frameworks" -framework libobs \
  -Wl,-rpath,"$obs_app/Contents/Frameworks" \
  -o "$project_root/.build/native-lifecycle-test"
"$project_root/.build/native-lifecycle-test"
