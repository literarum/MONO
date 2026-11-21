#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[ "${CONFIRM_RESTORE:-}" = "YES" ] || { echo "Set CONFIRM_RESTORE=YES to overwrite the data volume" >&2; exit 2; }
backup="${1:?Usage: CONFIRM_RESTORE=YES scripts/restore.sh backups/file.tar.gz}"
backup="$(realpath "$backup")"
test -f "$backup" && test -f "$backup.sha256"
(cd "$(dirname "$backup")" && sha256sum -c "$(basename "$backup").sha256")
tar -tzf "$backup" | awk '(/^\// || /(^|\/)\.\.\//) { bad=1 } END {exit bad}' || { echo "Unsafe archive paths"; exit 2; }
docker compose stop app
echo "App stopped. Existing data will be permanently replaced."
docker run --rm --network none -v mono_transcribe_data:/dest -v "$(dirname "$backup"):/backup:ro" alpine:3.20 \
  sh -ec 'cd /dest; find . -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xzf "/backup/$1" -C /dest' -- "$(basename "$backup")"
docker compose start app
echo "Restore complete. Check /api/ready and job statuses."
