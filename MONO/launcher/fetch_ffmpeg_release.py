#!/usr/bin/env python3
"""Resolve one ffmpeg release, validate published checksums, unpack safely.

This is a CI/build-time tool ONLY. No downloads happen when a user launches MONO.
Source: https://github.com/binmgr/ffmpeg . For reproducibility set
MONO_FFMPEG_RELEASE_TAG to a reviewed release tag; use "latest" for development.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import tarfile
import urllib.request
import zipfile

API = "https://api.github.com/repos/binmgr/ffmpeg"
UA = {"User-Agent":"MONO-Transcribe-Build/0.4", "Accept":"application/vnd.github+json"}

def download(url: str) -> bytes:
    if not url.startswith("https://github.com/") and not url.startswith("https://api.github.com/"):
        raise ValueError("Only approved GitHub HTTPS URLs are supported")
    req=urllib.request.Request(url,headers=UA)
    with urllib.request.urlopen(req,timeout=90) as response:
        return response.read()

def choose_asset(platform_name: str, machine: str) -> str:
    systems={"Windows":"windows","Darwin":"darwin","Linux":"linux"}
    machines={"x86_64":"amd64","AMD64":"amd64","arm64":"arm64","aarch64":"arm64"}
    if platform_name not in systems or machine not in machines:
        raise ValueError(f"Unsupported runtime target: {platform_name} / {machine}")
    system,arch=systems[platform_name],machines[machine]
    ext="zip" if system=="windows" else "tar.gz"
    return f"ffmpeg-{system}-{arch}.{ext}"

def checksum_from_manifest(data: bytes, filename: str) -> str:
    for line in data.decode("utf-8").splitlines():
        pieces=line.strip().split()
        if len(pieces)>=2 and pieces[-1].lstrip("*").rsplit("/",1)[-1]==filename:
            digest=pieces[0].lower()
            if re.fullmatch(r"[a-f0-9]{64}",digest):
                return digest
    raise ValueError(f"Missing SHA-256 in release manifest: {filename}")

def extract_required(data: bytes, name: str, destination: Path) -> None:
    required={"ffmpeg.exe","ffprobe.exe"} if name.endswith(".zip") else {"ffmpeg","ffprobe"}
    destination.mkdir(parents=True,exist_ok=True)
    archive = zipfile.ZipFile(io.BytesIO(data)) if name.endswith(".zip") else tarfile.open(fileobj=io.BytesIO(data),mode="r:gz")
    with archive:
        objects=archive.infolist() if isinstance(archive,zipfile.ZipFile) else archive.getmembers()
        found=set()
        for entry in objects:
            filename=Path(entry.filename if isinstance(archive,zipfile.ZipFile) else entry.name).name
            if filename not in required:
                continue
            if isinstance(archive,tarfile.TarFile) and not entry.isfile():
                raise ValueError(f"Unexpected FFmpeg tar entry type: {entry.name}")
            if filename in found:
                raise ValueError(f"Duplicate executable in archive: {filename}")
            found.add(filename)
            src=archive.open(entry) if isinstance(archive,zipfile.ZipFile) else archive.extractfile(entry)
            if src is None:
                raise ValueError(f"Missing content: {filename}")
            with src, (destination/filename).open("wb") as out:
                import shutil
                shutil.copyfileobj(src,out)
            (destination/filename).chmod(0o755)
        if found != required:
            raise ValueError(f"Missing executables: {required-found}")

def main():
    tag=os.environ.get("MONO_FFMPEG_RELEASE_TAG","latest")
    if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}",tag):
        raise ValueError("Invalid release tag")
    suffix="latest" if tag=="latest" else f"tags/{tag}"
    meta=json.loads(download(f"{API}/releases/{suffix}"))
    release_tag=meta["tag_name"]
    assets={a["name"]:a["browser_download_url"] for a in meta["assets"]}
    archive_name=choose_asset(platform.system(),platform.machine())
    manifest_name="SHA256SUMS.txt"
    if archive_name not in assets or manifest_name not in assets:
        raise ValueError("Missing required release assets; pin another FFmpeg release")
    manifest=download(assets[manifest_name])
    digest=checksum_from_manifest(manifest,archive_name)
    data=download(assets[archive_name])
    actual=hashlib.sha256(data).hexdigest()
    if actual!=digest:
        raise ValueError(f"FFmpeg archive checksum mismatch: expected {digest}, got {actual}")
    output=Path(os.environ.get("MONO_FFMPEG_OUTPUT",".ffmpeg-runtime")).resolve()
    extract_required(data,archive_name,output)
    provenance={"source":API,"release":release_tag,"asset":archive_name,"sha256":actual}
    (output/"PROVENANCE.json").write_text(json.dumps(provenance,indent=2),encoding="utf-8")
    # Make paths available for the next GitHub Actions step via GITHUB_ENV.
    env=os.environ.get("GITHUB_ENV")
    if env:
        with open(env,"a",encoding="utf-8") as f:
            f.write(f"MONO_BUILD_FFMPEG={output/('ffmpeg.exe' if os.name=='nt' else 'ffmpeg')}\n")
            f.write(f"MONO_BUILD_FFPROBE={output/('ffprobe.exe' if os.name=='nt' else 'ffprobe')}\n")
    github_path=os.environ.get("GITHUB_PATH")
    if github_path:
        with open(github_path,"a",encoding="utf-8") as f:
            f.write(str(output)+"\n")
    print(json.dumps(provenance,ensure_ascii=False))

if __name__=="__main__":
    main()
