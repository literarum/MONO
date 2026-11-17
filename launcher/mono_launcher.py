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
import secrets
import shutil
import signal
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


def executable_path(name: str, *, root: Path, allow_system: bool) -> str:
    filename = f"{name}.exe" if os.name == "nt" else name
    candidates = [root / "runtime" / "bin" / filename]
    if bundled():
        candidates.insert(0, root / "launcher" / "runtime" / "bin" / filename)
    for file in candidates:
        if file.is_file():
            return str(file)
    if allow_system:
        which = shutil.which(name)
        if which:
            return which
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
    env.update({
        "MONO_DEPLOY_MODE": "local",
        "MONO_LAUNCHER": "1",
        "MONO_HOST": HOST,
        "PORT": str(PORT),
        "MONO_DATA_DIR": str(roots["data"] / "server"),
        "MONO_CONFIG_DIR": str(roots["data"] / "config"),
        "MONO_CORE_EXECUTABLE": sys.executable,
        "MONO_CORE_PACKAGED": '1' if bundled() else '0',
        "MONO_CORE_SCRIPT": str(assets_root() / 'launcher' / 'local_core' / 'worker.py'),
    })
    config_key = roots["data"] / "config" / "groq_api_key"
    if not env.get("GROQ_API_KEY") and not env.get("GROQ_API_KEY_FILE") and config_key.is_file():
        env["GROQ_API_KEY_FILE"] = str(config_key)
    # FFmpeg and FFprobe are found using PATH from the selected runtime bundle.
    binaries = [str(Path(executables["ffmpeg"]).parent), str(Path(executables["node"]).parent)]
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


def launch_chromium(chrome: str, folder: Path, url: str) -> subprocess.Popen:
    profile = folder / "browser-profile"
    ensure_private_directory(profile)
    args = [chrome, f"--user-data-dir={profile}", f"--app={url}",
            "--no-first-run", "--no-default-browser-check", "--disable-background-mode",
            "--window-size=1380,900"]
    with _external_browser_environment() as environment:
        extra = {"env": environment} if environment is not None else {}
        return subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, **extra)


def launch_native(folder: Path, url: str) -> None:
    import webview  # optional, packaged on supported Windows/macOS builds
    session = folder / "native-profile"
    ensure_private_directory(session)
    webview.create_window(APP_NAME, url, width=1380, height=900,
                          min_size=(780, 580), background_color="#080808")
    webview.start(debug=False, private_mode=False, storage_path=str(session))


def launch_window(folder: Path, url: str, logger: logging.Logger,
                  preferred: str = "auto") -> None:
    chrome = discover_chromium()
    pin_file = folder / "ui-engine.json"
    try:
        pinned = json.loads(pin_file.read_text(encoding="utf-8")).get("engine")
    except (OSError, ValueError, TypeError):
        pinned = None
    if pinned not in (None, "native", "chromium"):
        raise LaunchError("Неизвестный оконный движок в сохранённых настройках.")
    # WebKit and Chromium have distinct IndexedDB storage. Never silently switch
    # an existing user to a new engine: that would show an apparently empty library.
    if pinned:
        choices = [pinned]
    else:
        native_first = preferred == "native" or (preferred == "auto" and sys.platform == "darwin")
        choices = ["native", "chromium"] if native_first else ["chromium", "native"]
    last_error = None
    for mode in choices:
        if mode == "native":
            try:
                import webview  # noqa: F401
            except ImportError:
                continue
            try:
                logger.info("GUI: native pywebview")
                if not pinned:
                    pin_file.write_text(json.dumps({"engine":mode}), encoding="utf-8")
                launch_native(folder, url)
                return
            except Exception as exc:
                logger.error("Native GUI failure: %s", type(exc).__name__)
                last_error = exc
                if not pinned:
                    pin_file.unlink(missing_ok=True)
        elif chrome:
            try:
                logger.info("GUI: Chromium app window")
                proc = launch_chromium(chrome, folder, url)
                time.sleep(.6)
                if proc.poll() is not None:
                    raise LaunchError("Окно браузера завершилось сразу после запуска.")
                if not pinned:
                    pin_file.write_text(json.dumps({"engine":mode}), encoding="utf-8")
                proc.wait()
                return
            except _BrowserEnvironmentRestoreError:
                raise
            except (OSError, LaunchError) as exc:
                logger.error("Chromium app window failed: %s", type(exc).__name__)
                last_error = exc
    raise LaunchError("Не удалось открыть прежнее окно MONO. "
                      "Профиль приложения сохранён, библиотека не удалена.\n"
                      f"Проверьте доступность {pinned or 'Chromium/WebView'}.\n"
                      f"Детали: {last_error or 'оконный движок не найден'}")


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
    session_file=folder / "session.json"
    try:
        session=json.loads(session_file.read_text(encoding="utf-8"))
        instance_id=session["instanceId"]
    except (OSError, ValueError, KeyError):
        raise LaunchError("MONO уже запускается. Подождите несколько секунд и повторите.")
    if not healthy(instance_id=instance_id):
        raise LaunchError("Другой экземпляр MONO уже запускается или завершает работу. "
                          "Подождите несколько секунд и повторите двойной щелчок.")
    chrome = discover_chromium()
    if current_engine(folder) == "chromium" and chrome:
        launch_chromium(chrome, folder, URL)
        logger.info("Second invocation: reopened existing Chromium profile")
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
        child_env = server_environment(roots={"data": folder}, executables=executables, developer=dev)
        instance_id = secrets.token_urlsafe(24)
        child_env["MONO_LAUNCHER_INSTANCE_ID"] = instance_id
        session_file = folder / "session.json"
        args = [executables["node"], str(backend / "server.mjs")]
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        recent_lines: list[str] = []
        ready = threading.Event()
        child = None
        try:
            child = subprocess.Popen(args, cwd=str(backend), env=child_env,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, bufsize=1, encoding="utf-8", errors="replace",
                                     creationflags=flags)
            reader = threading.Thread(target=drain_lines, args=(child.stdout, recent_lines, ready, logger),
                                      daemon=True, name="mono-backend-logs")
            reader.start()
            wait_ready(child, ready, instance_id)
            session_file.write_text(json.dumps({"instanceId": instance_id, "url": URL}), encoding="utf-8")
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
            launch_window(folder, URL, logger, preferred=preferred_ui)
            return 0
        except LaunchError as exc:
            logger.error("Startup error: %s; backend_tail=%s", exc, recent_lines[-5:])
            raise
        finally:
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
