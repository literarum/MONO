#!/usr/bin/env python3
"""Create a native one-click MONO bundle from the current operating system.

Dependencies are build-time only: pinned Python 3.14.8, PyInstaller, local Node and
FFmpeg/FFprobe executables. End users need none of these installed separately.
Build on each target OS (PyInstaller cannot cross-compile).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
from native_bundle import read_build_bundle,sha256 as native_sha256
from runtime_licenses import inspect_license
from ffmpeg_bundle import read_bundle as read_ffmpeg_bundle,stage_support
from core_bundle import read_build_bundle as read_core_bundle,stage_bundle as stage_core_bundle,BINARY as CORE_BINARY
from notice_bundle import stage_bundle as stage_notice_bundle

PROJECT = Path(__file__).resolve().parent.parent
BACKEND_FILES = ["server.mjs", "core.mjs", "package.json"]
PUBLIC = "public"
PYTHON_LICENSE_SOURCE = PROJECT / 'launcher/licenses/CPython-3.14.8-LICENSE.txt'
# Exact member of the reviewed official full runtime ZIP; provenance lives beside it.
PYTHON_LICENSE_SHA256 = '935cf13e19f8c31b497d20b05d73623431a226b230c3599bc30fa3348979bc68'


def sha256(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def prepare(stage: Path) -> Path:
    stage=stage.expanduser().absolute()
    # Claim a new directory atomically. Existing staging/release work belongs
    # to the caller and must never be cleaned implicitly by the packager.
    stage.mkdir(parents=True,exist_ok=False)
    try:python_notice=PYTHON_LICENSE_SOURCE.read_bytes()
    except OSError as error:raise RuntimeError('Python runtime license input missing or unreadable') from error
    if hashlib.sha256(python_notice).hexdigest()!=PYTHON_LICENSE_SHA256:
        raise RuntimeError('Python runtime license input changed')
    capture_input=None
    if os.name=='nt':
        selected=os.environ.get('MONO_BUILD_CAPTURE_BUNDLE')
        if not selected:raise RuntimeError('Windows native capture input required: set MONO_BUILD_CAPTURE_BUNDLE after launcher/build_capture.py')
        capture_input=Path(selected).absolute();capture_build=read_build_bundle(capture_input,PROJECT/'native/windows')
    elif sys.platform=='darwin':raise RuntimeError('macOS native capture helper is not implemented; do not ship an incomplete package')
    core_input=os.environ.get('MONO_BUILD_CORE_BUNDLE')
    core_input=Path(core_input).absolute() if core_input else None
    core_build=read_core_bundle(core_input,PROJECT/'launcher/local_core') if core_input else None
    ffmpeg_input=os.environ.get('MONO_BUILD_FFMPEG_BUNDLE')
    ffmpeg_input=Path(ffmpeg_input).absolute() if ffmpeg_input else None
    ffmpeg_build=read_ffmpeg_bundle(ffmpeg_input) if ffmpeg_input else None
    backend = stage / "backend"
    runtime = stage / "runtime" / "bin"
    backend.mkdir(parents=True)
    runtime.mkdir(parents=True)
    for name in BACKEND_FILES:
        shutil.copy2(PROJECT / name, backend / name)
    shutil.copytree(PROJECT / PUBLIC, backend / PUBLIC)
    shutil.copytree(PROJECT / 'backend',backend / 'backend')
    (stage/'launcher').mkdir()
    if not core_input:
        shutil.copytree(PROJECT / 'launcher' / 'local_core',stage / 'launcher' / 'local_core',ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
    for name in ('mono_launcher.py','native_bundle.py','ffmpeg_bundle.py','core_bundle.py','notice_bundle.py','ffmpeg-windows.lock.json','ffmpeg-source-windows.lock.json'):
        shutil.copy2(PROJECT/'launcher'/name,stage/'launcher'/name)
    shutil.copytree(PROJECT/'launcher/assets',stage/'launcher/assets')
    # Frozen local_core.library.__file__ is _MEIPASS/local_core/library.py.
    # Keep its runtime resource at that import path; launcher/local_core is the
    # separately inventoried source audit copy, not Python's frozen import root.
    (stage/'local_core').mkdir()
    shutil.copy2(PROJECT/'launcher/local_core/schema.sql',stage/'local_core/schema.sql')
    compiled_core=stage_core_bundle(core_input,stage,core_build) if core_input else None
    shutil.copy2(PROJECT / "THIRD_PARTY_NOTICES.md", stage / "THIRD_PARTY_NOTICES.md")
    (stage/'PYTHON_LICENSE.txt').write_bytes(python_notice)
    python_notices=stage_notice_bundle(PROJECT/'launcher/licenses/windows-python-dependencies',stage)
    manifests = [];runtime_licenses={};selected={}
    for program in ("node", "ffmpeg", "ffprobe"):
        target_name = program + (".exe" if os.name == "nt" else "")
        override = os.environ.get("MONO_BUILD_" + program.upper())
        candidate = PROJECT / ".ffmpeg-runtime" / target_name
        if override:
            src = Path(override).expanduser().resolve()
        elif ffmpeg_input and program in ('ffmpeg','ffprobe'):
            src=ffmpeg_input/target_name
        elif program in ("ffmpeg", "ffprobe") and candidate.is_file():
            src = candidate
        else:
            src = shutil.which(program)
        if not src or not Path(src).is_file():
            raise RuntimeError(f"Build-time executable not found: {program}")
        source = Path(src)
        selected[program]=source
        if program in ('ffmpeg','ffprobe'):
            if ffmpeg_input and source.resolve()!=(ffmpeg_input/target_name).resolve():raise RuntimeError('Selected FFmpeg programs must match the reviewed bundle')
            runtime_licenses[program]=inspect_license(source,program)
            if os.name=='nt' and not ffmpeg_input and any(source.parent.glob('avcodec-*.dll')):raise RuntimeError('Shared FFmpeg requires MONO_BUILD_FFMPEG_BUNDLE')
        dest = runtime / target_name
        shutil.copy2(source, dest)
        dest.chmod(dest.stat().st_mode | 0o111)
        manifests.append({"name":target_name, "size":dest.stat().st_size,"sha256":sha256(dest)})
    support=stage_support(ffmpeg_input,stage/'runtime',ffmpeg_build) if ffmpeg_input else None
    provenance=selected['ffmpeg'].parent/'PROVENANCE.json'
    if provenance.is_file():shutil.copy2(provenance,stage/'runtime/FFMPEG_PROVENANCE.json')
    application=[]
    for file in sorted(backend.rglob("*")):
        if file.is_file():
            application.append({"path":file.relative_to(backend).as_posix(),
                                "size":file.stat().st_size,"sha256":sha256(file)})
    helpers=[]
    for file in sorted((stage / 'launcher').rglob('*')):
        if file.is_file():helpers.append({'path':file.relative_to(stage).as_posix(),'size':file.stat().st_size,'sha256':sha256(file)})
    capture=None
    if capture_input:
        native=stage/'runtime/native';shutil.copytree(capture_input,native)
        read_build_bundle(native,PROJECT/'native/windows')
        capture={'rid':'win-x64','protocol':1,'sourceHash':capture_build['sourceHash'],'files':[{'path':file.name,'size':file.stat().st_size,'sha256':native_sha256(file)} for file in sorted(native.iterdir())]}
    # Bundle license material from the selected Node binary distribution.
    node_binary = Path(os.environ.get("MONO_BUILD_NODE") or shutil.which("node") or "")
    for license_path in [node_binary.parent / "LICENSE", node_binary.parent.parent / "LICENSE"]:
        if license_path.is_file():
            shutil.copy2(license_path, stage / "NODE_LICENSE.txt")
            break
    if not (stage/'NODE_LICENSE.txt').is_file():raise RuntimeError('Node license missing; select a complete Node distribution with MONO_BUILD_NODE')
    resources=[{'path':name,'size':(stage/name).stat().st_size,'sha256':sha256(stage/name)} for name in ['local_core/schema.sql','NODE_LICENSE.txt','PYTHON_LICENSE.txt','THIRD_PARTY_NOTICES.md']]
    (stage / "runtime" / "manifest.json").write_text(
        json.dumps({"runtime":manifests,"application":application,"helpers":helpers,"resources":resources,**({'capture':capture} if capture else {}),
                    "platform":sys.platform,'pythonNotices':python_notices,'ffmpegLicenses':runtime_licenses,**({'ffmpegSupport':support} if support else {}),**({'compiledCore':compiled_core} if compiled_core else {})},indent=2),encoding="utf-8"
    )
    (stage/'launcher/_mono_build_identity.py').write_text(
        '"""Generated immutable package identity, frozen into the executable."""\n'
        +'EXPECTED_MANIFEST_SHA256 = '+repr(sha256(stage/'runtime/manifest.json'))+'\n',encoding='utf-8')
    return stage


def validate_package_format(onefile: bool) -> None:
    if onefile and sys.platform != 'win32':
        raise RuntimeError('Single-file packaging currently requires Windows')


def build(stage: Path, output: Path, *, onefile: bool = False) -> Path:
    output=output.expanduser().absolute()
    if output.exists() or output.is_symlink():
        raise FileExistsError('Choose a new output directory; existing releases are preserved')
    validate_package_format(onefile)
    stage=stage.expanduser().absolute()
    validate_stage(stage)
    output.mkdir(parents=True,exist_ok=False)
    try:
        import PyInstaller  # noqa
    except ImportError as exc:
        raise RuntimeError("Install PyInstaller in the build environment: pip install pyinstaller") from exc
    cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
           "--onefile" if onefile else "--onedir", "--noupx",
           "--windowed", "--name", "MONO Transcribe",
           "--distpath", str(output), "--workpath", str(output / ".work"),
           "--specpath", str(output / ".spec"),
           "--add-data", f"{stage / 'backend'}{os.pathsep}backend",
           "--add-data", f"{stage / 'runtime'}{os.pathsep}runtime",
           "--add-data", f"{stage / 'launcher'}{os.pathsep}launcher",
           "--add-data", f"{stage / 'local_core' / 'schema.sql'}{os.pathsep}local_core",
           "--add-data", f"{stage / 'THIRD_PARTY_NOTICES.md'}{os.pathsep}.",
           "--add-data", f"{stage / 'PYTHON_LICENSE.txt'}{os.pathsep}.",
           str(stage / "launcher" / "mono_launcher.py")]
    if (stage/'runtime/native').is_dir():
        # runtime/ is already included above, including helper and .NET notices.
        if not (stage/'NODE_LICENSE.txt').is_file():raise RuntimeError('Node distribution license is required')
    if (stage/'NODE_LICENSE.txt').is_file():cmd.extend(['--add-data',f"{stage/'NODE_LICENSE.txt'}{os.pathsep}."])
    manifest=json.loads((stage/'runtime/manifest.json').read_text(encoding='utf-8'))
    if manifest.get('compiledCore'):
        import importlib.util
        cmd.extend(['--add-binary',f"{stage/CORE_BINARY}{os.pathsep}.",'--exclude-module=local_core'])
        # Native package imports are opaque to PyInstaller's Python bytecode
        # scanner. Include their exact source-derived stdlib dependencies.
        for name in manifest['compiledCore']['stdlibImports']:
            if importlib.util.find_spec(name) is not None:cmd.append('--hidden-import='+name)
    if sys.platform == "darwin":
        cmd.extend(["--osx-bundle-identifier","app.mono.transcribe",
                    "--icon",str(stage/"launcher"/"assets"/"MONO.icns")])
    elif sys.platform == "win32":
        cmd.extend(["--icon",str(stage/"launcher"/"assets"/"MONO.ico")])
    subprocess.run(cmd, check=True)
    validate_stage(stage)
    if sys.platform == "darwin":
        app = output / "MONO Transcribe.app"
        plist_file = app / "Contents" / "Info.plist"
        if plist_file.is_file():
            with plist_file.open("rb") as stream:
                plist = plistlib.load(stream)
            plist["NSMicrophoneUsageDescription"] = "MONO записывает звук только по вашему запросу."
            plist["NSCameraUsageDescription"] = "Для работы со звуком экранных встреч могут потребоваться системные разрешения."
            plist["CFBundleDisplayName"] = "MONO Transcribe"
            plist["LSApplicationCategoryType"] = "public.app-category.productivity"
            with plist_file.open("wb") as stream:
                plistlib.dump(plist, stream)
            # PyInstaller already signed the bundle; editing Info.plist breaks that
            # seal and macOS then refuses to launch it or to show the microphone
            # (TCC) prompt. Re-seal ad hoc; release signing replaces this identity.
            identity = os.environ.get("MONO_CODESIGN_IDENTITY", "-")
            subprocess.run(["codesign", "--force", "--deep", "--sign", identity, str(app)], check=True)
            subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
    return output


def validate_stage(stage):
    # Compile only the prepared snapshot. Changes to the working checkout no
    # longer mix frozen Python with previously copied backend/assets.
    from mono_launcher import verify_runtime_manifest,LaunchError
    try:
        verify_runtime_manifest(stage)
        identity='"""Generated immutable package identity, frozen into the executable."""\n'+'EXPECTED_MANIFEST_SHA256 = '+repr(sha256(stage/'runtime/manifest.json'))+'\n'
        if (stage/'launcher/_mono_build_identity.py').read_text(encoding='utf-8')!=identity:
            raise ValueError('Package identity changed')
    except (LaunchError,OSError,ValueError) as error:
        raise RuntimeError('Staged snapshot changed or is incomplete') from error


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage",default=str(PROJECT / ".bundle-stage"))
    parser.add_argument("--output",default=str(PROJECT / "dist"))
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--onefile", action="store_true", help="Build one Windows EXE with embedded runtimes")
    args=parser.parse_args()
    output=Path(args.output).expanduser().absolute()
    if not args.prepare_only and (output.exists() or output.is_symlink()):
        raise FileExistsError('Choose a new output directory; existing releases are preserved')
    validate_package_format(args.onefile)
    stage=prepare(Path(args.stage).expanduser().absolute())
    print("Runtime bundled:", (stage / "runtime" / "manifest.json").read_text())
    if not args.prepare_only:
        print("Built:", build(stage, output, onefile=args.onefile))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
