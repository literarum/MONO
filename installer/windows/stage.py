"""Assemble the Windows installer payload (run on Windows CI).

stage/
  app/       application sources (UI, server, local core, launcher) + runtime.json
  runtime/   python/ (full CPython with tkinter), node/node.exe, ffmpeg/, native/MonoAudio.exe
  licenses/  third-party licenses of bundled runtimes

Every runtime is verified from its staged location before the stage is accepted.
"""
import argparse, json, shutil, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP_FILES = ["server.mjs", "core.mjs", "healthcheck.mjs", "package.json", "THIRD_PARTY_NOTICES.md"]
APP_DIRS = ["public", "backend", "launcher"]
SKIP = shutil.ignore_patterns("__pycache__", "*.pyc", "tests", "licenses", "*.lock", "*.lock.json")


def run(*args):
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise SystemExit(f"FAILED: {args}\n{result.stdout}\n{result.stderr}")
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--python-home", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--ffmpeg-dir", type=Path, required=True, help="folder with ffmpeg.exe, ffprobe.exe")
    parser.add_argument("--ffmpeg-license", type=Path, required=True)
    parser.add_argument("--helper", type=Path, default=None)
    args = parser.parse_args()
    stage = args.stage.resolve()
    if stage.exists():
        raise SystemExit("Stage folder must be new")
    app, runtime, licenses = stage / "app", stage / "runtime", stage / "licenses"
    for folder in (app, runtime, licenses):
        folder.mkdir(parents=True)

    for name in APP_FILES:
        shutil.copy2(ROOT / name, app / name)
    for name in APP_DIRS:
        shutil.copytree(ROOT / name, app / name, ignore=SKIP)
    shutil.copytree(ROOT / "launcher" / "assets", app / "launcher" / "assets", dirs_exist_ok=True)

    # Full CPython (relocatable on Windows) with tcl/tk for the folder dialog.
    shutil.copytree(args.python_home, runtime / "python", ignore=shutil.ignore_patterns("__pycache__", "test", "tests", "idlelib", "turtledemo", "*.pdb"))
    python = runtime / "python" / "python.exe"
    run(python, "-c", "import tkinter, sqlite3, ctypes, ssl; tkinter.Tcl().eval('info patchlevel')")
    (runtime / "node").mkdir()
    shutil.copy2(args.node, runtime / "node" / "node.exe")
    (runtime / "ffmpeg").mkdir()
    for tool in ("ffmpeg.exe", "ffprobe.exe"):
        shutil.copy2(args.ffmpeg_dir / tool, runtime / "ffmpeg" / tool)
        run(runtime / "ffmpeg" / tool, "-version")
    run(runtime / "node" / "node.exe", "--version")
    pinned = {"node": "../runtime/node/node.exe", "ffmpeg": "../runtime/ffmpeg/ffmpeg.exe", "ffprobe": "../runtime/ffmpeg/ffprobe.exe"}
    if args.helper:
        (runtime / "native").mkdir()
        shutil.copy2(args.helper, runtime / "native" / "MonoAudio.exe")
        pinned["audioHelper"] = "../runtime/native/MonoAudio.exe"
    (app / "runtime.json").write_text(json.dumps(pinned, indent=2), encoding="utf-8")

    shutil.copy2(args.python_home / "LICENSE.txt", licenses / "PYTHON_LICENSE.txt")
    node_license = args.node.parent / "LICENSE"
    if node_license.is_file():
        shutil.copy2(node_license, licenses / "NODE_LICENSE.txt")
    shutil.copy2(args.ffmpeg_license, licenses / "FFMPEG_LICENSE.txt")
    print(json.dumps({"stage": str(stage), "runtime": pinned}, indent=2))


if __name__ == "__main__":
    main()
