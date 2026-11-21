#!/usr/bin/env bash
# MONO Transcribe — установка из исходников для macOS и Linux.
# Запускается из INSTALL-MONO-macOS.command / INSTALL-MONO-Linux.sh.
# Проверяет Node.js ≥ 20, Python ≥ 3.11 с tkinter и FFmpeg; при согласии ставит их
# пакетным менеджером, проверяет запуск сервера и создаёт ярлык на рабочем столе.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNATTENDED=0; NO_LAUNCH=0
for arg in "$@"; do case "$arg" in --unattended) UNATTENDED=1;; --no-launch) NO_LAUNCH=1;; esac; done
OS="$(uname -s)"
LOG="${TMPDIR:-/tmp}/mono-install.log"
exec > >(tee "$LOG") 2>&1

step(){ printf '\n\033[36m==> %s\033[0m\n' "$1"; }
ok(){ printf '    \033[32m[OK]\033[0m %s\n' "$1"; }
warn(){ printf '    \033[33m[!]\033[0m %s\n' "$1"; }
fail(){ printf '\n\033[31m[ОШИБКА]\033[0m %s\nЖурнал установки: %s\n' "$1" "$LOG"; exit 1; }
ask(){ [ "$UNATTENDED" = 1 ] && return 1; read -r -p "$1 [y/N] " reply </dev/tty || return 1; [[ "$reply" =~ ^([yY]|[yY]es|[дД]|[дД]а)$ ]]; }

# Homebrew на Apple Silicon и Intel не всегда в PATH у двойного щелчка.
for prefix in /opt/homebrew /usr/local; do [ -x "$prefix/bin/brew" ] && eval "$("$prefix/bin/brew" shellenv)" && break; done

pkg_install(){ # $1 — человекочитаемое имя, далее — пакеты для brew / apt / dnf
  local name="$1" brew_pkgs="$2" apt_pkgs="$3" dnf_pkgs="$4"
  if [ "$OS" = Darwin ]; then
    command -v brew >/dev/null || fail "$name не найден, а Homebrew не установлен. Установите Homebrew (https://brew.sh) и запустите установку снова."
    ask "    Установить $name через Homebrew ($brew_pkgs)?" || fail "Без $name MONO не запустится."
    brew install $brew_pkgs
  elif command -v apt-get >/dev/null; then
    ask "    Установить $name через apt ($apt_pkgs, нужен пароль администратора)?" || fail "Без $name MONO не запустится."
    sudo apt-get update && sudo apt-get install -y $apt_pkgs
  elif command -v dnf >/dev/null; then
    ask "    Установить $name через dnf ($dnf_pkgs, нужен пароль администратора)?" || fail "Без $name MONO не запустится."
    sudo dnf install -y $dnf_pkgs
  else fail "$name не найден. Установите его пакетным менеджером системы и запустите установку снова."; fi
  hash -r
}

echo "MONO Transcribe — установка"
echo "Папка приложения: $ROOT"

# --- Node.js ≥ 20 -------------------------------------------------------------
step 'Node.js (сервер приложения)'
node_ok(){ command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]; }
node_ok || pkg_install 'Node.js 20+' 'node' 'nodejs' 'nodejs'
node_ok || fail 'Нужен Node.js 20 или новее (дистрибутив мог поставить старую версию — установите с https://nodejs.org).'
ok "Node.js $(node --version)"

# --- Python ≥ 3.11 с tkinter ---------------------------------------------------
step 'Python (локальное ядро архива)'
find_python(){ # $1=tk: require tkinter (system folder dialog)
  for candidate in python3.13 python3.12 python3.11 python3; do
    local path; path="$(command -v "$candidate" 2>/dev/null)" || continue
    local probe='import sys;sys.exit(0 if sys.version_info>=(3,11) else 1)'; [ "${1:-}" = tk ] && probe='import sys,tkinter;sys.exit(0 if sys.version_info>=(3,11) else 1)'
    "$path" -c "$probe" >/dev/null 2>&1 && { echo "$path"; return 0; }
  done; return 1
}
PYTHON="$(find_python tk || true)"
if [ -z "$PYTHON" ]; then
  if [ -z "$(find_python || true)" ] || ask '    У Python нет tkinter (системное окно «Выбрать папку»). Установить его?'; then
    pkg_install 'Python 3.11+ с tkinter' 'python@3.13 python-tk@3.13' 'python3 python3-tk' 'python3 python3-tkinter' || true
  fi
  PYTHON="$(find_python tk || find_python || true)"
fi
[ -n "$PYTHON" ] || fail 'Не найден Python 3.11 или новее.'
"$PYTHON" -c 'import tkinter' >/dev/null 2>&1 || warn 'Без tkinter недоступна кнопка «Выбрать папку»: архив будет создан в «Документы/MONO Library», перенести его можно позже.'
ok "$("$PYTHON" --version) — $PYTHON"

# --- FFmpeg --------------------------------------------------------------------
step 'FFmpeg (обработка звука)'
command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || pkg_install 'FFmpeg' 'ffmpeg' 'ffmpeg' 'ffmpeg'
command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || fail 'FFmpeg не найден.'
ok "$(ffmpeg -version | head -1 | sed 's/ Copyright.*//')"

# --- Окно приложения -------------------------------------------------------------
step 'Окно приложения (Chrome, Edge, Brave или Chromium)'
BROWSER=''
if [ "$OS" = Darwin ]; then
  for app in "/Applications/Google Chrome.app" "/Applications/Microsoft Edge.app" "/Applications/Brave Browser.app" "$HOME/Applications/Google Chrome.app"; do [ -d "$app" ] && BROWSER="$app" && break; done
  if [ -z "$BROWSER" ] && command -v brew >/dev/null && ask '    Окну MONO нужен браузер на Chromium. Установить Google Chrome через Homebrew?'; then brew install --cask google-chrome && BROWSER='/Applications/Google Chrome.app'; fi
else
  for name in chromium chromium-browser google-chrome microsoft-edge brave-browser; do command -v "$name" >/dev/null && BROWSER="$(command -v "$name")" && break; done
fi
[ -n "$BROWSER" ] || fail 'Не найден браузер на Chromium (Chrome, Edge, Brave или Chromium). MONO открывается в его окне без вкладок и адресной строки.'
ok "$BROWSER"

# --- Проверка запуска --------------------------------------------------------------
step 'Проверка запуска (сервер, ядро архива, FFmpeg)'
RUNNING=0
if curl -fsS --max-time 2 http://127.0.0.1:4173/api/health 2>/dev/null | grep -q '"mode":"local"'; then RUNNING=1; ok 'MONO уже запущен — проверка пропущена'
else
  SMOKE="$("$PYTHON" "$ROOT/launcher/mono_launcher.py" --dev --smoke 2>&1)" || fail "Проверочный запуск не удался:
$SMOKE"
  grep -q '"ok": true' <<<"$SMOKE" || fail "Проверочный запуск не удался:
$SMOKE"
  ok 'Сервер запускается и отвечает'
fi

# --- Ярлык -------------------------------------------------------------------------
step 'Ярлык на рабочем столе'
if [ "$OS" = Darwin ]; then
  DESKTOP="$HOME/Desktop"; APP="$DESKTOP/MONO Transcribe.app"
  rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  cp "$ROOT/launcher/assets/MONO.icns" "$APP/Contents/Resources/MONO.icns"
  cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>MONO Transcribe</string>
<key>CFBundleDisplayName</key><string>MONO Transcribe</string>
<key>CFBundleIdentifier</key><string>app.mono.transcribe.source</string>
<key>CFBundleExecutable</key><string>MONO</string>
<key>CFBundleIconFile</key><string>MONO</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.4.0</string>
<key>LSUIElement</key><true/>
<key>NSMicrophoneUsageDescription</key><string>MONO записывает звук только по вашему запросу.</string>
</dict></plist>
PLIST
  # LSUIElement: the supervisor has no Dock icon; the Chromium app window is the UI.
  cat > "$APP/Contents/MacOS/MONO" <<LAUNCH
#!/bin/bash
cd "$ROOT" && exec "$PYTHON" "$ROOT/launcher/mono_launcher.py" --dev --ui chromium
LAUNCH
  chmod +x "$APP/Contents/MacOS/MONO"
  # Created locally: no quarantine attribute, so Gatekeeper does not block it.
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
  ok "$APP"
else
  DESKTOP="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
  APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"; mkdir -p "$APPS" "$DESKTOP"
  ENTRY="[Desktop Entry]
Type=Application
Name=MONO Transcribe
Comment=Запись и расшифровка речи
Exec=\"$PYTHON\" \"$ROOT/launcher/mono_launcher.py\" --dev --ui chromium
Path=$ROOT
Icon=$ROOT/public/icon-512.png
Terminal=false
Categories=AudioVideo;Audio;Office;
StartupNotify=true"
  printf '%s\n' "$ENTRY" > "$APPS/mono-transcribe.desktop"; printf '%s\n' "$ENTRY" > "$DESKTOP/mono-transcribe.desktop"
  chmod +x "$APPS/mono-transcribe.desktop" "$DESKTOP/mono-transcribe.desktop"
  # GNOME requires the desktop file to be marked trusted before it launches.
  command -v gio >/dev/null && gio set "$DESKTOP/mono-transcribe.desktop" metadata::trusted true 2>/dev/null || true
  ok "$DESKTOP/mono-transcribe.desktop"
fi

printf '\n\033[32mГотово. Запускайте MONO ярлыком «MONO Transcribe» на рабочем столе.\033[0m\n'
if [ "$NO_LAUNCH" = 0 ] && [ "$RUNNING" = 0 ]; then
  if [ "$OS" = Darwin ]; then open "$APP"; else nohup "$PYTHON" "$ROOT/launcher/mono_launcher.py" --dev --ui chromium >/dev/null 2>&1 & fi
fi
