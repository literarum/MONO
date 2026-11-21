#!/bin/bash
# MONO Transcribe — установка на macOS. Двойной щелчок в Finder.
# Если macOS пишет, что файл нельзя открыть: Системные настройки → Конфиденциальность
# и безопасность → «Всё равно открыть», либо: xattr -d com.apple.quarantine <этот файл>.
exec /bin/bash "$(dirname "$0")/scripts/install/unix.sh" "$@"
