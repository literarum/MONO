#!/usr/bin/env python3
"""MONO: one-click local application supervisor.

The distributed app is a PyInstaller onedir bundle with Node + FFmpeg sidecars.
Run `python launcher/mono_launcher.py --smoke` to validate a source checkout.
No Groq key is needed for UI and local capture.
"""
from __future__ import annotations

import argparse
import contextlib
import http.client
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser

APP_NAME = "MONO TRANSCRIBE"
PORT = 4173  # Deliberately stable: browser IndexedDB / Service Worker are origin-scoped.
HOST = "127.0.0.1"
URL = f"http://{HOST}:{PORT}"
START_TIMEOUT = 25
STOP_TIMEOUT = 12


class LaunchError(Exception):
    """Expected error with actionable, user-facing text."""


class _BrowserEnvironmentRestoreError(LaunchError):
    """The current process cannot safely continue with another GUI engine."""


def verify_folder_picker_dependencies() -> bool:
    # Keep this import visible to PyInstaller: local_core may be a native module,
    # whose imports the bytecode scanner cannot discover. Importing creates no UI.
    try:
        import tkinter.filedialog as filedialog
    except (ImportError, OSError) as error:
        raise LaunchError('Не удалось загрузить системный выбор папки. Обновите сборку MONO.') from error
    if not callable(getattr(filedialog, 'askdirectory', None)):
        raise LaunchError('Системный выбор папки недоступен в этой сборке MONO.')
    return True


def bundled() -> bool:
    return bool(getattr(sys, "frozen", False))


def assets_root() -> Path:
    # PyInstaller onedir stores added data under sys._MEIPASS / _internal.
    if bundled():
        return Path(sys._MEIPASS).resolve()
    return Path(__file__).resolve().parent.parent


def bundle_folder() -> Path:
    if not bundled():
        return assets_root()
    executable = Path(sys.executable).resolve()
    if sys.platform == "darwin" and ".app/Contents/MacOS/" in str(executable):
        return Path(str(executable).split(".app/Contents/MacOS/")[0] + ".app").parent
    return executable.parent


def data_root() -> Path:
    explicit = os.environ.get("MONO_HOME", "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    if os.environ.get("MONO_PORTABLE") == "1" or (bundle_folder() / "MONO.portable").is_file():
        return bundle_folder() / "MONO-DATA"
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "MONO Transcribe"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "MONO Transcribe"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "mono-transcribe"


def ensure_private_directory(directory: Path) -> None:
    try:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if os.name != "nt":
            directory.chmod(0o700)
        probe = directory / ".write-test"
        with open(probe, "wb") as handle:
            handle.write(b"ok")
        probe.unlink()
    except OSError as exc:
        raise LaunchError(f"Папка данных недоступна для записи:\n{directory}\n{exc}") from exc


def logger_for(folder: Path) -> logging.Logger:
    logs = folder / "logs"
    ensure_private_directory(logs)
    logger = logging.getLogger("mono_launcher")
    for old_handler in logger.handlers:
        old_handler.close()
    logger.handlers.clear()
    logger.setLevel(logging.INFO)
    log_file = RotatingFileHandler(logs / "launcher.log", maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    log_file.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(log_file)
    return logger


def _registry_path_dirs() -> list[str]:
    """PATH as stored now in the registry. A shortcut started by Explorer keeps the
    PATH Explorer had at login, so tools installed afterwards (winget) are invisible."""
    if os.name != "nt":
        return []
    import winreg
    entries = []
    for hive, key in ((winreg.HKEY_CURRENT_USER, "Environment"),
                      (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")):
        try:
            with winreg.OpenKey(hive, key) as handle:
                value, _ = winreg.QueryValueEx(handle, "Path")
                entries += [os.path.expandvars(part) for part in str(value).split(";") if part.strip()]
        except OSError:
            continue
    return entries


def _well_known_dirs(name: str) -> list[Path]:
    home = Path.home()
    if os.name == "nt":
        local = Path(os.environ.get("LOCALAPPDATA") or home / "AppData" / "Local")
        program = Path(os.environ.get("ProgramFiles") or r"C:\Program Files")
        dirs = [local / "Microsoft" / "WinGet" / "Links", Path(r"C:\ProgramData\chocolatey\bin"), home / "scoop" / "shims",
                Path(r"C:\ffmpeg\bin"), program / "ffmpeg" / "bin", program / "nodejs"]
        packages = local / "Microsoft" / "WinGet" / "Packages"
        if name in ("ffmpeg", "ffprobe") and packages.is_dir():
            dirs += sorted({p.parent for p in packages.glob("Gyan.FFmpeg*/*/bin/ffmpeg.exe")}, reverse=True)
        return dirs
    return [Path("/opt/homebrew/bin"), Path("/usr/local/bin"), Path("/usr/bin"), home / ".local" / "bin"]


def _pinned_runtime() -> dict:
    """Tool paths recorded at installation: runtime.json next to the application
    (Windows setup; paths relative to it) or in the data folder (source installers)."""
    for file in (assets_root() / "runtime.json", data_root() / "runtime.json"):
        try:
            value = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(value, dict):
            return {key: str((file.parent / item).resolve()) if isinstance(item, str) else item for key, item in value.items()}
    return {}


def executable_path(name: str, *, root: Path, allow_system: bool) -> str:
    filename = f"{name}.exe" if os.name == "nt" else name
    candidates = [root / "runtime" / "bin" / filename]
    if bundled():
        candidates.insert(0, root / "launcher" / "runtime" / "bin" / filename)
    for file in candidates:
        if file.is_file():
            return str(file)
    if allow_system:
        pinned = _pinned_runtime().get(name)
        if isinstance(pinned, str) and Path(pinned).is_file():
            return pinned
        which = shutil.which(name) or shutil.which(name, path=os.pathsep.join(_registry_path_dirs()))
        if which:
            return which
        for directory in _well_known_dirs(name):
            file = directory / filename
            if file.is_file():
                return str(file)
    raise LaunchError(
        f"Не найден {filename}. В готовой сборке он должен находиться в runtime/bin.\n"
        "Для запуска из исходников установите Node.js и FFmpeg, затем запустите с --dev."
    )



def verify_runtime_manifest(root: Path) -> None:
    """Detect accidental mismatch between binary sidecars and their build record.

    This is an integrity check, not a publisher signature: authenticated release
    signing is required separately for supply-chain security.
    """
    import hashlib
    manifest_file = root / "runtime" / "manifest.json"
    if not manifest_file.is_file():
        raise LaunchError("Отсутствует контрольная ведомость runtime. Пакет собран не полностью.")
    try:
        manifest_bytes=manifest_file.read_bytes()
        if bundled():
            from _mono_build_identity import EXPECTED_MANIFEST_SHA256
            if hashlib.sha256(manifest_bytes).hexdigest()!=EXPECTED_MANIFEST_SHA256:
                raise ValueError('Package identity mismatch')
        manifest = json.loads(manifest_bytes.decode('utf-8'))
        binaries = manifest["runtime"]
        expected={name+('.exe' if os.name=='nt' else '') for name in ('node','ffmpeg','ffprobe')}
        if not isinstance(binaries,list) or len(binaries)!=3 or {v['name'] for v in binaries}!=expected:
            raise ValueError("Expected exactly 3 runtime files")
        applications = manifest["application"]
        if not isinstance(applications, list) or not applications:
            raise ValueError("Missing application inventory")
        for entry in binaries:
            name = entry["name"]
            if name not in ("node", "node.exe", "ffmpeg", "ffmpeg.exe", "ffprobe", "ffprobe.exe"):
                raise ValueError("Unrecognized binary")
            file = root / "runtime" / "bin" / name
            if not file.is_file() or file.stat().st_size != entry["size"]:
                raise ValueError(f"Missing or truncated: {name}")
            digest = hashlib.sha256()
            with file.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            if digest.hexdigest() != entry["sha256"]:
                raise ValueError(f"Checksum mismatch: {name}")
        backend_dir = (root / "backend").resolve()
        for entry in applications:
            name = entry["path"]
            if not isinstance(name, str) or not name or name.startswith("/") or "\\" in name:
                raise ValueError("Invalid application path")
            file = (backend_dir / name).resolve()
            if not file.is_relative_to(backend_dir) or not file.is_file():
                raise ValueError("Invalid or missing application file")
            if file.stat().st_size != entry["size"]:
                raise ValueError(f"App asset truncated: {name}")
            digest = hashlib.sha256()
            with file.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            if digest.hexdigest() != entry["sha256"]:
                raise ValueError(f"App asset mismatch: {name}")
        helpers=manifest.get('helpers')
        if not isinstance(helpers,list) or not helpers:
            raise ValueError('Missing local core inventory')
        for entry in helpers:
            name=entry['path']
            if not isinstance(name,str) or not name.startswith('launcher/') or '\\' in name:
                raise ValueError('Invalid helper path')
            file=(root/name).resolve()
            if not file.is_relative_to(root.resolve()) or not file.is_file() or file.stat().st_size!=entry['size']:
                raise ValueError('Missing or truncated local core')
            digest=hashlib.sha256(file.read_bytes()).hexdigest()
            if digest!=entry['sha256']:raise ValueError('Local core checksum mismatch')
        resources=manifest.get('resources');required={'local_core/schema.sql','NODE_LICENSE.txt','PYTHON_LICENSE.txt','THIRD_PARTY_NOTICES.md'}
        if not isinstance(resources,list) or len(resources)!=len(required):raise ValueError('Missing required package resources')
        seen=set()
        for entry in resources:
            name=entry['path']
            if name not in required or name in seen:raise ValueError('Invalid package resource')
            seen.add(name);file=root/name
            if not file.is_file() or file.stat().st_size!=entry['size'] or hashlib.sha256(file.read_bytes()).hexdigest()!=entry['sha256']:raise ValueError('Package resource missing or damaged')
        from notice_bundle import verify_staged as verify_staged_notices
        verify_staged_notices(root,manifest.get('pythonNotices'))
        if 'compiledCore' in manifest:
            # This validator must remain stdlib-only; importing local_core (even
            # indirectly through native_bundle) can execute an unverified PYD.
            from core_bundle import verify_staged_core
            verify_staged_core(root,manifest['compiledCore'])
        if os.name=='nt':
            from native_bundle import verify_staged_capture
            verify_staged_capture(root/'runtime/native',manifest.get('capture'))
        if 'ffmpegSupport' in manifest:
            from ffmpeg_bundle import verify_support
            verify_support(root/'runtime',manifest['ffmpegSupport'])
    except (KeyError, ValueError, OSError, TypeError,RuntimeError,ImportError) as exc:
        raise LaunchError(f"Компоненты MONO повреждены или изменены: {exc}") from exc

def select_runtimes(*, root: Path, allow_system: bool) -> dict[str, str]:
    return {name: executable_path(name, root=root, allow_system=allow_system)
            for name in ("node", "ffmpeg", "ffprobe")}


def server_environment(*, roots: dict[str, Path], executables: dict[str, str],
                       developer: bool = False) -> dict[str, str]:
    env = os.environ.copy()
    # System options can inject arbitrary Node programs before our server runs.
    env.pop("NODE_OPTIONS", None)
    env.pop("NODE_PATH", None)
    # Disallow accidental redirection of private recordings to a foreign inference endpoint.
    if not developer or bundled():
        env.pop("MONO_GROQ_ENDPOINT", None)
        env['MONO_AUDIO_HELPER']=str(assets_root()/'runtime/native'/('MonoAudio.exe' if os.name=='nt' else 'MonoAudio'))
    else:
        helper = _pinned_runtime().get("audioHelper")
        if isinstance(helper, str) and Path(helper).is_file():
            env["MONO_AUDIO_HELPER"] = helper
    env.update({
        "MONO_DEPLOY_MODE": "local",
        "MONO_LAUNCHER": "1",
        "MONO_HOST": HOST,
        "PORT": str(PORT),
        "MONO_DATA_DIR": str(roots["data"] / "server"),
        "MONO_CONFIG_DIR": str(roots["data"] / "config"),
        "MONO_CORE_EXECUTABLE": sys.executable,
        "MONO_CORE_PACKAGED": '1' if bundled() else '0',
        # Where the window engine choice lives (ui-engine.json): the app can switch to «your own browser».
        "MONO_LAUNCHER_HOME": str(roots["data"]),
        "MONO_CORE_SCRIPT": str(assets_root() / 'launcher' / 'local_core' / 'worker.py'),
    })
    config_key = roots["data"] / "config" / "groq_api_key"
    if not env.get("GROQ_API_KEY") and not env.get("GROQ_API_KEY_FILE") and config_key.is_file():
        env["GROQ_API_KEY_FILE"] = str(config_key)
    # FFmpeg and FFprobe are found using PATH from the selected runtime bundle.
    binaries = [str(Path(executables[name]).parent) for name in ("ffmpeg", "ffprobe", "node")]
    env["MONO_FFMPEG"] = executables["ffmpeg"]; env["MONO_FFPROBE"] = executables["ffprobe"]
    env["PATH"] = os.pathsep.join(dict.fromkeys(binaries)) + os.pathsep + env.get("PATH", "")
    return env


@contextlib.contextmanager
def exclusive_lock(file: Path):
    ensure_private_directory(file.parent)
    try:
        descriptor=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        try:os.write(descriptor,b'0')
        finally:os.close(descriptor)
    except FileExistsError:
        pass
    with file.open("r+b",buffering=0) as handle:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                yield False
                return
            try:
                yield True
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                yield False
                return
            try:
                yield True
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def healthy(url: str | None = None, timeout: float = 1.5, instance_id: str | None = None) -> bool:
    url=url or URL
    req = urllib.request.Request(url + "/api/health")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read(8192))
            return (resp.status == 200 and isinstance(data, dict) and data.get("mode") == "local"
                    and isinstance(data.get("version"), str)
                    and (instance_id is None or data.get("instanceId") == instance_id))
    except (OSError, ValueError, urllib.error.URLError, http.client.HTTPException):
        return False


def discover_chromium() -> str | None:
    override = os.environ.get("MONO_CHROMIUM", "").strip()
    if override and Path(override).is_file():
        return override
    if sys.platform == "win32":
        prefixes = [os.environ.get(name, "") for name in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")]
        for prefix in filter(None, prefixes):
            for relative in ("Microsoft/Edge/Application/msedge.exe",
                             "Google/Chrome/Application/chrome.exe",
                             "BraveSoftware/Brave-Browser/Application/brave.exe"):
                candidate = Path(prefix) / relative
                if candidate.is_file():
                    return str(candidate)
        return None
    if sys.platform == "darwin":
        for location in (
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            str(Path.home() / "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ):
            if Path(location).is_file():
                return location
        return None
    for name in ("chromium", "chromium-browser", "google-chrome", "microsoft-edge", "brave-browser"):
        result = shutil.which(name)
        if result:
            return result
    return None


def show_error(message: str) -> None:
    # Errors are never silent in --windowed / no-console executables.
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, message, APP_NAME, 0x10)
            return
        except Exception:
            pass
    if sys.platform == "darwin":
        try:
            subprocess.run(["osascript", "-e",
                            f'display alert "MONO TRANSCRIBE" message {json.dumps(message)} as critical'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            return
        except Exception:
            pass
    try:
        from tkinter import Tk, messagebox
        window = Tk()
        window.withdraw()
        messagebox.showerror(APP_NAME, message, parent=window)
        window.destroy()
    except Exception:
        print(f"{APP_NAME}: {message}", file=sys.stderr)


_BROWSER_SPAWN_LOCK = threading.Lock()


def _windows_dll_directory_api():
    import ctypes
    from types import SimpleNamespace
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetDllDirectoryW.argtypes = [ctypes.c_uint32, ctypes.POINTER(ctypes.c_wchar)]
    kernel.GetDllDirectoryW.restype = ctypes.c_uint32
    kernel.SetDllDirectoryW.argtypes = [ctypes.c_wchar_p]
    kernel.SetDllDirectoryW.restype = ctypes.c_int

    def get():
        buffer = ctypes.create_unicode_buffer(32768)
        ctypes.set_last_error(0)
        length = kernel.GetDllDirectoryW(len(buffer), buffer)
        if length >= len(buffer) or (length == 0 and ctypes.get_last_error()):
            raise LaunchError("Не удалось проверить окружение системного браузера.")
        # Zero does not distinguish a default directory from an explicitly
        # empty setting that excludes CWD. Leave either case untouched.
        return buffer.value if length else None

    def set_directory(value):
        if not kernel.SetDllDirectoryW(value):
            raise LaunchError("Не удалось подготовить окружение системного браузера."
                              if value is None else "Не удалось восстановить окружение MONO.")

    return SimpleNamespace(get=get, set=set_directory)


@contextlib.contextmanager
def _external_browser_environment():
    if sys.platform != "win32" or not bundled():
        yield None
        return
    import ntpath
    root = getattr(sys, "_MEIPASS", None)
    if not isinstance(root, (str, os.PathLike)) or not ntpath.isabs(root):
        raise LaunchError("Не удалось определить окружение собранного приложения.")
    anchor = ntpath.normcase(ntpath.abspath(root))
    environment = os.environ.copy()

    def outside_bundle(entry):
        value = entry.strip().strip('"')
        if not value:
            return True
        try:
            candidate = ntpath.normcase(ntpath.abspath(value))
            return ntpath.commonpath([anchor, candidate]) != anchor
        except (ValueError, OSError):
            return True

    for name in environment:
        if name.upper() == "PATH":
            environment[name] = ";".join(entry for entry in environment[name].split(";")
                                         if outside_bundle(entry))
    # PyInstaller's added DLL directory is inherited by CreateProcess. Reset it
    # only across this external spawn, then restore the exact bundled state.
    # Other launcher threads only drain backend logs; bundled workers execute
    # in separate processes and keep their original runtime environment.
    with _BROWSER_SPAWN_LOCK:
        api = _windows_dll_directory_api()
        previous = api.get()
        if previous is None:
            yield environment
            return
        try:
            api.set(None)
            yield environment
        finally:
            try:
                api.set(previous)
            except (LaunchError, OSError) as exc:
                raise _BrowserEnvironmentRestoreError(
                    "Не удалось восстановить окружение MONO. Перезапустите приложение.") from exc


CHROMIUM_BROWSERS = {"chrome.exe", "msedge.exe", "brave.exe", "browser.exe", "opera.exe", "vivaldi.exe",
                     "chromium.exe", "yandex.exe"}


def _command_executable(command: str) -> str | None:
    """The program of a shell command such as '"C:\\...\\chrome.exe" --single-argument %1'."""
    command = command.strip()
    if command.startswith('"'):
        end = command.find('"', 1)
        return command[1:end] if end > 1 else None
    return command.split(" ", 1)[0] or None


def default_browser() -> tuple[str, str] | None:
    """(kind, executable) of the person's default browser for http links: kind is 'chromium'
    (Chrome, Edge, Brave, Yandex, Opera, Vivaldi), 'firefox' or 'other'. None off Windows or if unknown."""
    if sys.platform != "win32":
        return None
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice") as key:
            prog_id = winreg.QueryValueEx(key, "ProgId")[0]
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, prog_id + r"\shell\open\command") as key:
            executable = _command_executable(winreg.QueryValueEx(key, "")[0])
    except (OSError, ImportError, IndexError, TypeError):
        return None
    if not executable or not Path(executable).is_file():
        return None
    name = Path(executable).name.lower()
    return ("chromium" if name in CHROMIUM_BROWSERS else "firefox" if name == "firefox.exe" else "other", executable)


def browser_window_command(url: str, browser: tuple[str, str] | None) -> list[str] | None:
    """A separate window of the person's own browser, in their usual profile (no --user-data-dir):
    Chromium browsers get an app window without tabs, Firefox a new window."""
    if not browser:
        return None
    kind, executable = browser
    if kind == "chromium":
        return [executable, f"--app={url}/?window=mono"]
    if kind == "firefox":
        return [executable, "-new-window", f"{url}/?window=mono"]
    return None


def open_in_browser(url: str, browser=None) -> None:
    """Open MONO in a separate window of the person's default browser, in their own profile. When
    that browser is already running (the person started it), Chromium and Firefox pass the request to
    the running browser and the new process exits at once: the window, and its microphone, belong to
    a process the person started — security software that restricts programs launched by MONO (as
    Kaspersky does for a program's children) does not apply to it."""
    command = browser_window_command(url, (browser or default_browser)())
    if command is None and sys.platform != "win32":
        chrome = discover_chromium()
        command = [chrome, f"--app={url}/?window=mono"] if chrome else None
    if command is not None:
        with _external_browser_environment() as environment:
            extra = {"env": environment} if environment is not None else {}
            subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, **extra)
        return
    if os.name == "nt":
        os.startfile(url + "/")  # noqa: S606 — ShellExecute of an http URL opens the default browser
    else:
        webbrowser.open_new(url + "/")


SECOND_INSTANCE_WAIT = 20.0


def focus_window(url: str, token: str, timeout: float = 2.0) -> bool:
    """Ask the open MONO window to come forward. True when at least one window received it."""
    request = urllib.request.Request(url + "/api/launcher/focus", data=b"", method="POST",
                                     headers={"X-Mono-Launcher-Token": token})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return int(json.loads(response.read(4096)).get("pages", 0)) > 0
    except (OSError, ValueError, TypeError, urllib.error.URLError, http.client.HTTPException):
        return False


# Settings → «Работа в фоне», as the server last reported them.
BACKGROUND = {"lingerSeconds": 10, "finishWork": True}


def browser_clients(url: str, token: str, timeout: float = 2.0) -> tuple[int, int] | None:
    """(open MONO pages, background tasks still running), or None if the server did not answer.
    Also refreshes BACKGROUND from the answer."""
    request = urllib.request.Request(url + "/api/launcher/clients", headers={"X-Mono-Launcher-Token": token})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            answer = json.loads(response.read(4096))
            linger = answer.get("lingerSeconds")
            if isinstance(linger, int) and linger in (10, 60, 300, 1800):
                BACKGROUND["lingerSeconds"] = linger
            if isinstance(answer.get("finishWork"), bool):
                BACKGROUND["finishWork"] = answer["finishWork"]
            return int(answer.get("pages", 0)), int(answer.get("busy", 0))
    except (OSError, ValueError, TypeError, urllib.error.URLError, http.client.HTTPException):
        return None


def browser_pages(url: str, token: str, timeout: float = 2.0) -> int | None:
    """How many MONO pages are open (their live event streams), or None if the server did not answer.
    A transcription still being sent or saved counts as a page (unless the person turned that off),
    so closing the window does not cut it."""
    answer = browser_clients(url, token, timeout)
    if answer is None:
        return None
    pages, busy = answer
    return pages or (1 if busy and BACKGROUND["finishWork"] else 0)


def serve_browser(url: str, logger: logging.Logger, pages, *, first_wait: float = 180, idle_wait: float = 10,
                  poll: float = 1.0, clock=time.monotonic, sleep=time.sleep, linger=None) -> None:
    """Browser mode: MONO runs while its window is open and quits completely soon after it is closed.
    `idle_wait` seconds without a page (a reload reconnects within one or two) end it; so does no page
    at all within `first_wait` seconds of the start. The gap is counted in polls as well as in time,
    so waking the computer from sleep (when the clock jumps) does not end a session that is still open."""
    seen = False
    last = clock()
    empty = unknown = 0
    while True:
        count = pages()
        now = clock()
        if count is None and seen:  # the server is busy or restarting its core: neither open nor closed
            unknown += 1
            if unknown * poll > 120:
                logger.info("Browser mode: the server has not answered for %.0f s; quitting", unknown * poll)
                return
            sleep(poll)
            continue
        unknown = 0
        if count:
            seen = True
            last = now
            empty = 0
        else:
            empty += 1
            limit = (linger() if linger else idle_wait) if seen else first_wait
            if now - last > limit and empty * poll >= limit:
                logger.info("Browser mode: no MONO page open for %.0f s; quitting", now - last)
                return
        sleep(poll)


def launch_native(folder: Path, url: str) -> None:
    import webview  # optional, packaged on supported Windows/macOS builds
    session = folder / "native-profile"
    ensure_private_directory(session)
    webview.create_window(APP_NAME, url, width=1380, height=900,
                          min_size=(780, 580), background_color="#080808")
    webview.start(debug=False, private_mode=False, storage_path=str(session))


def launch_window(folder: Path, url: str, logger: logging.Logger,
                  preferred: str = "auto", pages=None) -> None:
    """MONO opens in a separate window of the person's own browser (their usual profile). The older
    MONO-owned Chromium window («chromium») is retired: a browser MONO starts itself inherits the
    restrictions security software places on MONO, and its microphone can be refused. Only a window
    explicitly pinned to the native WebView keeps it."""
    pin_file = folder / "ui-engine.json"
    try:
        pinned = json.loads(pin_file.read_text(encoding="utf-8")).get("engine")
    except (OSError, ValueError, TypeError, AttributeError):
        pinned = None
    if pinned not in (None, "native", "chromium", "browser"):
        raise LaunchError("Неизвестный оконный движок в сохранённых настройках.")
    if pinned == "native" or (pinned is None and preferred == "native"):
        try:
            import webview  # noqa: F401
            logger.info("GUI: native pywebview")
            launch_native(folder, url)
            return
        except ImportError:
            logger.warning("Native window unavailable; using the browser")
        except Exception as exc:
            logger.error("Native GUI failure: %s", type(exc).__name__)
    if pinned in (None, "chromium"):
        try:
            pin_file.write_text(json.dumps({"engine": "browser"}), encoding="utf-8")
        except OSError:
            pass
    logger.info("GUI: a window of the person's own browser")
    open_in_browser(url)
    serve_browser(url, logger, pages or (lambda: None), linger=lambda: BACKGROUND["lingerSeconds"])


def current_engine(folder: Path) -> str | None:
    try:
        return json.loads((folder / "ui-engine.json").read_text(encoding="utf-8"))["engine"]
    except (OSError, ValueError, KeyError):
        return None


def drain_lines(pipe, sink: list[str], ready: threading.Event, logger: logging.Logger) -> None:
    for raw in iter(pipe.readline, ""):
        line = raw.rstrip()
        if not line:
            continue
        if line.startswith('{"event":"listening"'):
            try:
                payload = json.loads(line)
                if payload.get("host") == HOST and payload.get("port") == PORT:
                    ready.set()
            except ValueError:
                pass
        sink.append(line[:400])
        if len(sink) > 30:
            del sink[:-30]
        # Backend must never log keys or transcript text.
        logger.info("backend: %s", line[:400])


def port_free(port: int) -> bool:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        # Same rule as Node's listen(): on POSIX a recently closed connection (TIME_WAIT)
        # must not make the port look taken, or a quick restart would hop to another port
        # and lose the window's origin-scoped settings. Windows does not block on TIME_WAIT.
        if os.name != "nt":
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind((HOST, port)); return True
    except OSError:
        return False
    finally:
        probe.close()


def choose_port(logger=None) -> None:
    """4173 is preferred (window settings are origin-scoped). If another program holds it,
    use the next free port instead of refusing to start."""
    global PORT, URL
    if port_free(PORT):
        return
    for candidate in range(PORT + 1, PORT + 11):
        if port_free(candidate):
            if logger: logger.warning("Port %s is taken by another program; using %s", PORT, candidate)
            PORT = candidate; URL = f"http://{HOST}:{PORT}"; return
    raise LaunchError("Порты 4173–4183 заняты другими программами. Закройте одну из них и запустите MONO снова.")


def wait_ready(child: subprocess.Popen, event: threading.Event, instance_id: str,
               timeout: float = START_TIMEOUT) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise LaunchError(f"Backend остановился во время запуска (код {child.returncode}).")
        if event.is_set() and healthy(instance_id=instance_id):
            return True
        time.sleep(.12)
    raise LaunchError(f"Backend не смог запуститься за {timeout:.0f} секунд. "
                      "Проверьте свободный порт 4173 и журнал launcher.log.")


def stop_backend(child: subprocess.Popen, logger: logging.Logger) -> None:
    if child.poll() is not None:
        return
    try:
        # Also signals parent-pipe EOF, which is supported by the backend.
        if child.stdin and not child.stdin.closed:
            child.stdin.close()
        elif child.poll() is None:
            child.terminate()
        child.wait(timeout=STOP_TIMEOUT)
    except subprocess.TimeoutExpired:
        logger.warning("Backend did not stop gracefully, killing")
        child.kill()
        child.wait(timeout=5)
    except OSError as exc:
        logger.warning("Backend cleanup issue: %s", type(exc).__name__)


def handle_second_instance(folder: Path, logger: logging.Logger) -> int:
    global PORT, URL
    """A second click while MONO runs (or is still starting): never a second window. If a MONO window
    is open it is brought forward; if MONO is still starting, the first launch opens the window."""
    session_file=folder / "session.json"
    session=None
    for _ in range(int(SECOND_INSTANCE_WAIT / .25)):
        try:
            session=json.loads(session_file.read_text(encoding="utf-8"))
            if healthy(instance_id=session["instanceId"]):
                break
        except (OSError, ValueError, KeyError, TypeError):
            pass
        session=None
        time.sleep(.25)
    if session is None:
        logger.info("Second invocation while MONO is starting or stopping: nothing to do")
        return 0
    url=session.get("url") or URL
    match=re.fullmatch(rf"http://{re.escape(HOST)}:(\d+)",url)
    if match:  # the running instance may be on an alternate port
        PORT=int(match.group(1)); URL=url
    if current_engine(folder) != "native":
        token=session.get("token") or ""
        if token and focus_window(URL, token):
            logger.info("Second invocation: brought the open MONO window forward")
            return 0
        open_in_browser(URL)
        logger.info("Second invocation: no MONO window was open; opened one")
        return 0
    # Never try to start another backend on the same storage.
    raise LaunchError("MONO уже запущен. Переключитесь на открытое окно приложения.")


def _run_session(*, dev: bool, smoke: bool, preferred_ui: str, smoke_hold: float = 0) -> int:
    root = assets_root()
    backend = root / "backend" if (root / "backend" / "server.mjs").is_file() else root
    if not (backend / "server.mjs").is_file():
        raise LaunchError("Не найдены файлы backend. Архив приложения повреждён.")
    folder = data_root()
    ensure_private_directory(folder)
    logger = logger_for(folder)
    logger.info("Starting MONO launcher (system=%s, packaged=%s)", platform.system(), bundled())
    with exclusive_lock(folder / ".mono-instance.lock") as owner:
        if not owner:
            return handle_second_instance(folder, logger)
        if not dev or bundled():
            verify_runtime_manifest(root)
        executables = select_runtimes(root=root, allow_system=(dev and not bundled()))
        choose_port(logger)
        child_env = server_environment(roots={"data": folder}, executables=executables, developer=dev)
        instance_id = secrets.token_urlsafe(24)
        child_env["MONO_LAUNCHER_INSTANCE_ID"] = instance_id
        hotkey_token = secrets.token_urlsafe(32)
        child_env["MONO_LAUNCHER_TOKEN"] = hotkey_token
        session_file = folder / "session.json"
        args = [executables["node"], str(backend / "server.mjs")]
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        recent_lines: list[str] = []
        holder = {"child": None}
        stopping = threading.Event()

        def spawn() -> subprocess.Popen:
            ready = threading.Event()
            process = subprocess.Popen(args, cwd=str(backend), env=child_env,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       text=True, bufsize=1, encoding="utf-8", errors="replace",
                                       creationflags=flags)
            holder["child"] = process
            threading.Thread(target=drain_lines, args=(process.stdout, recent_lines, ready, logger),
                             daemon=True, name="mono-backend-logs").start()
            wait_ready(process, ready, instance_id)
            return process

        def supervise() -> None:
            """Backend crashed while the window is open: restart it (1 s, 2 s, 4 s backoff,
            at most 3 restarts per 10 minutes). The window reconnects by itself; recordings
            already committed are on disk, the core recovers interrupted takes on start."""
            restarts: list[float] = []
            while not stopping.wait(1.0):
                process = holder["child"]
                if process is None or process.poll() is None:
                    continue
                now = time.monotonic()
                restarts[:] = [t for t in restarts if now - t < 600]
                if len(restarts) >= 3:
                    logger.error("Backend keeps stopping (code %s); giving up after 3 restarts", process.returncode)
                    return
                delay = 2 ** len(restarts)
                logger.warning("Backend stopped unexpectedly (code %s); restarting in %ss", process.returncode, delay)
                if stopping.wait(delay):
                    return
                restarts.append(time.monotonic())
                try:
                    if process.stdout:
                        process.stdout.close()
                    spawn()
                    logger.info("Backend restarted on %s", URL)
                except (LaunchError, OSError) as error:
                    logger.error("Backend restart failed: %s", error)

        child = None
        try:
            child = spawn()
            session_file.write_text(json.dumps({"instanceId": instance_id, "url": URL, "token": hotkey_token}), encoding="utf-8")
            if os.name != "nt":
                session_file.chmod(0o600)
            logger.info("Backend verified on %s", URL)
            if smoke:
                print(json.dumps({"ok": True, "url": URL, "node": executables["node"],
                                  "ffmpeg": executables["ffmpeg"], "data": str(folder)},
                                 ensure_ascii=False))
                if smoke_hold > 0:
                    time.sleep(smoke_hold)
                return 0
            try:
                from hotkey import start_global_hotkey
                start_global_hotkey(URL, hotkey_token, logger)
            except Exception as error:  # a hotkey is a convenience, never a launch blocker
                logger.warning("Global hotkey unavailable: %s", error)
            threading.Thread(target=supervise, daemon=True, name="mono-backend-supervisor").start()
            launch_window(folder, URL, logger, preferred=preferred_ui,
                          pages=lambda: browser_pages(URL, hotkey_token))
            return 0
        except LaunchError as exc:
            logger.error("Startup error: %s; backend_tail=%s", exc, recent_lines[-5:])
            raise
        finally:
            stopping.set()
            child = holder["child"] or child
            if child is not None:
                stop_backend(child, logger)
                if child.stdout:
                    child.stdout.close()
            session_file.unlink(missing_ok=True)
            logger.info("MONO launcher stopped")

def close_logger(logger):
    for handler in list(logger.handlers):
        handler.close();logger.removeHandler(handler)

def run(*,dev: bool,smoke: bool,preferred_ui: str,smoke_hold: float=0) -> int:
    try:return _run_session(dev=dev,smoke=smoke,preferred_ui=preferred_ui,smoke_hold=smoke_hold)
    finally:close_logger(logging.getLogger('mono_launcher'))


def main(argv=None) -> int:
    global PORT,URL
    arguments=sys.argv[1:] if argv is None else argv
    if bundled() and ('--folder-picker' in arguments or '--core-worker' in arguments):
        try:verify_runtime_manifest(assets_root())
        except (LaunchError,OSError) as error:
            if sys.stderr is not None:
                if hasattr(sys.stderr,'reconfigure'):sys.stderr.reconfigure(encoding='utf-8',newline='\n',line_buffering=True)
                print(f'ERROR: {error}',file=sys.stderr)
            return 1
    if '--folder-picker' in arguments:
        try:verify_folder_picker_dependencies()
        except LaunchError:
            if sys.stdout is not None:print(json.dumps({'error':'PICKER_UNAVAILABLE'}),flush=True)
            return 1
        from local_core.folders import main as picker_main
        index=arguments.index('--folder-picker')
        return picker_main(arguments[index+1] if len(arguments)>index+1 else 'create')
    if '--core-worker' in (sys.argv[1:] if argv is None else argv):
        # Import is explicit so PyInstaller also discovers and freezes the worker.
        from local_core.worker import main as core_main
        return core_main()
    parser = argparse.ArgumentParser(description="MONO TRANSCRIBE application launcher")
    parser.add_argument("--dev", action="store_true", help="Use system Node / FFmpeg for development")
    parser.add_argument("--smoke", action="store_true", help="Start, health-check, and stop backend without GUI")
    parser.add_argument('--verify-bundle',action='store_true',help='Verify packaged components without starting the application')
    parser.add_argument("--ui", choices=["auto", "native", "chromium"], default="auto")
    parser.add_argument("--smoke-hold", type=float, default=0, help=argparse.SUPPRESS)
    parser.add_argument('--port',type=int,default=None,help='Development-only isolated test port; requires --dev')
    args = parser.parse_args(argv)
    if args.smoke or args.verify_bundle:
        # Machine-readable CLI output must not depend on the Windows ANSI/OEM
        # page. Worker stdin/stdout has its own UTF-8 protocol configuration.
        for stream in (sys.stdout,sys.stderr):
            if stream is not None and hasattr(stream,'reconfigure'):
                stream.reconfigure(encoding='utf-8',newline='\n',line_buffering=True)
    if args.port is not None:
        if not args.dev or bundled() or not 1<=args.port<=65535:parser.error('--port requires unbundled --dev and a valid port')
        PORT=args.port;URL=f'http://{HOST}:{PORT}'
    try:
        if args.verify_bundle:
            verify_runtime_manifest(assets_root());verify_folder_picker_dependencies()
            print(json.dumps({'ok':True,'platform':sys.platform,'folderPickerImports':True}));return 0
        return run(dev=args.dev, smoke=args.smoke, preferred_ui=args.ui, smoke_hold=args.smoke_hold)
    except (LaunchError, OSError) as exc:
        if args.smoke or args.verify_bundle:
            print(f"ERROR: {exc}", file=sys.stderr)
        else:
            show_error(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
