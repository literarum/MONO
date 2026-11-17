#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v docker >/dev/null || { echo "Docker required" >&2; exit 1; }
mkdir -p backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="mono-data-$stamp.tar.gz"
# Consistent cold backup: stop writer while copying the named volume.
docker compose stop app
restore_service(){ docker compose start app >/dev/null || true; }
trap restore_service EXIT
docker run --rm --network none -v mono_transcribe_data:/source:ro -v "$PWD/backups:/backup" alpine:3.20 \
  sh -ec 'cd /source && tar -czf "/backup/$1" .' -- "$name"
(cd backups && sha256sum "$name" > "$name.sha256")
echo "Backup written: backups/$name"
