#!/bin/bash
# Copy only explicitly selected exports; no monitoring starts automatically.
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$script_dir/raw"
for source in "$@"; do
  case "$(basename -- "$source")" in yascrap-*.json) ;; *) echo 'Expected a yascrap JSON export' >&2; exit 1 ;; esac
  cp -n -- "$source" "$script_dir/raw/"
done
