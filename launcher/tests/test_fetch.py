import importlib.util
from pathlib import Path
import hashlib
import io
import json
import tarfile
import tempfile
import unittest
import zipfile

ROOT=Path(__file__).resolve().parents[2]
SPEC=importlib.util.spec_from_file_location("ffmpeg_fetch",ROOT/"launcher"/"fetch_ffmpeg_release.py")
fetch=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fetch)

class FFmpegBundleTests(unittest.TestCase):
    def test_checksum_matching(self):
        name="ffmpeg-darwin-arm64.tar.gz"
        body=b"release-archive"
        digest=hashlib.sha256(body).hexdigest()
        self.assertEqual(fetch.checksum_from_manifest(f"{digest}  {name}\n".encode(),name),digest)
        with self.assertRaises(ValueError):
            fetch.checksum_from_manifest(b"wrong\n",name)

    def test_platform_mapping(self):
        self.assertEqual(fetch.choose_asset("Darwin","arm64"),"ffmpeg-darwin-arm64.tar.gz")
        self.assertEqual(fetch.choose_asset("Windows","AMD64"),"ffmpeg-windows-amd64.zip")
        with self.assertRaises(ValueError):
            fetch.choose_asset("Darwin","mips")

    def test_safe_tar_unpacks_only_required_executables(self):
        buf=io.BytesIO()
        with tarfile.open(mode="w:gz",fileobj=buf) as t:
            for name in ["ffmpeg","ffprobe","../../dont-copy"]:
                b=name.encode()
                info=tarfile.TarInfo(name)
                info.size=len(b)
                t.addfile(info,io.BytesIO(b))
        with tempfile.TemporaryDirectory() as tmp:
            fetch.extract_required(buf.getvalue(),"ffmpeg-darwin-arm64.tar.gz",Path(tmp))
            self.assertEqual(sorted(p.name for p in Path(tmp).iterdir()),["ffmpeg","ffprobe"])
            self.assertFalse((Path(tmp)/"dont-copy").exists())

if __name__=="__main__":
    unittest.main()
