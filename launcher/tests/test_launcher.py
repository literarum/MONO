import contextlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
SPEC=importlib.util.spec_from_file_location("mono_launcher",ROOT/"launcher"/"mono_launcher.py")
mono=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mono)


class LauncherTests(unittest.TestCase):
    def test_origin_port_is_stable_to_preserve_indexeddb(self):
        self.assertEqual(mono.PORT,4173)
        self.assertEqual(mono.URL,"http://127.0.0.1:4173")

    def test_default_data_is_outside_app_directory(self):
        with patch.dict(os.environ,{"MONO_HOME":"","MONO_PORTABLE":"0"}):
            folder=mono.data_root()
            self.assertNotEqual(folder,ROOT)
            self.assertNotIn("/tmp/_MEI",str(folder))

    def test_explicit_portable_location(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ,{"MONO_HOME":tmp,"MONO_PORTABLE":"1"}):
                self.assertTrue(mono.data_root().samefile(Path(tmp)))

    def test_private_folder_and_write_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)/"state"
            mono.ensure_private_directory(folder)
            self.assertTrue(folder.is_dir())
            self.assertFalse((folder/".write-test").exists())

    def test_lock_rejects_concurrent_launch(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock=Path(tmp)/".lock"
            with mono.exclusive_lock(lock) as owner:
                self.assertTrue(owner)
                with mono.exclusive_lock(lock) as second:
                    self.assertFalse(second)
            with mono.exclusive_lock(lock) as owner_again:
                self.assertTrue(owner_again)

    def test_bundle_requires_embedded_binaries_without_dev_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(mono.LaunchError):
                mono.select_runtimes(root=Path(tmp),allow_system=False)

    def test_environment_is_local_and_clean(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ,{"NODE_OPTIONS":"--require malicious.js",
                                       "NODE_PATH":"/malicious",
                                       "MONO_DEPLOY_MODE":"proxy",
                                       "MONO_HOST":"0.0.0.0",
                                       "PORT":"9000"}):
                data=Path(tmp)
                env=mono.server_environment(roots={"data":data},
                    executables={"node":"/usr/bin/node","ffmpeg":"/usr/bin/ffmpeg","ffprobe":"/usr/bin/ffprobe"})
                self.assertEqual(env["MONO_DEPLOY_MODE"],"local")
                self.assertEqual(env["MONO_HOST"],"127.0.0.1")
                self.assertEqual(env["PORT"],"4173")
                self.assertNotIn("NODE_OPTIONS",env)
                self.assertNotIn("NODE_PATH",env)
                self.assertTrue(env["MONO_DATA_DIR"].startswith(tmp))

    def test_chrome_browser_profile_is_persistent(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)
            with patch("subprocess.Popen") as proc:
                mono.launch_chromium("/fake/chromium",folder,mono.URL)
                args=proc.call_args[0][0]
                self.assertIn("--app="+mono.URL,args)
                self.assertIn("--user-data-dir="+str(folder/"browser-profile"),args)
                self.assertTrue((folder/"browser-profile").is_dir())


    @unittest.skipUnless(sys.platform=='win32' and os.environ.get('MONO_RELEASE_TOOLCHAIN')=='1','Requires the pinned Windows x64 release toolchain (set MONO_RELEASE_TOOLCHAIN=1)')


    def test_corrupt_runtime_refused(self):
        import importlib.util
        spec=importlib.util.spec_from_file_location("bundle_build",ROOT/"launcher"/"build_portable.py")
        builder=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        with tempfile.TemporaryDirectory() as tmp:
            stage=builder.prepare(Path(tmp)/"stage")
            mono.verify_runtime_manifest(stage)
            node_file=stage/"runtime"/"bin"/("node.exe" if os.name=="nt" else "node")
            with node_file.open("ab") as stream:
                stream.write(b"tampered")
            with self.assertRaises(mono.LaunchError):
                mono.verify_runtime_manifest(stage)
            # A modified SPA script must also fail the integrity check.
            previous_stage=stage;previous_node_sha=builder.sha256(node_file)
            stage=builder.prepare(Path(tmp)/"stage-ui-check")
            self.assertEqual(builder.sha256(node_file),previous_node_sha,'Previous tampered-stage evidence is preserved')
            self.assertTrue(previous_stage.is_dir())
            with (stage/"backend"/"public"/"app.js").open("ab") as stream:
                stream.write(b"// tampered")
            with self.assertRaises(mono.LaunchError):
                mono.verify_runtime_manifest(stage)

    def test_ui_engine_sticky_avoids_silent_browser_storage_loss(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)
            (folder/"ui-engine.json").write_text('{"engine":"native"}')
            self.assertEqual(mono.current_engine(folder),"native")
            # Chrome may exist, but a missing native engine must NOT switch profile.
            with patch("test_launcher.mono.discover_chromium",return_value="/fake/chromium"):
                with patch.dict(sys.modules,{"webview": None}):
                    with self.assertRaises(mono.LaunchError):
                        logger=mono.logger_for(folder)
                        try:mono.launch_window(folder,mono.URL,logger)
                        finally:mono.close_logger(logger)
            self.assertEqual(mono.current_engine(folder),"native")

    @unittest.skipUnless(sys.platform=='win32' and os.environ.get('MONO_RELEASE_TOOLCHAIN')=='1','Requires the pinned Windows x64 release toolchain (set MONO_RELEASE_TOOLCHAIN=1)')

    def test_packager_stage_contains_server_and_runtime_checksums(self):
        import importlib.util
        spec=importlib.util.spec_from_file_location("bundle_build",ROOT/"launcher"/"build_portable.py")
        builder=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        with tempfile.TemporaryDirectory() as tmp:
            stage=Path(tmp)/"stage"
            prepared=builder.prepare(stage)
            manifest=json.loads((prepared/"runtime"/"manifest.json").read_text())
            self.assertEqual(len(manifest["runtime"]),3)
            for item in manifest["runtime"]:
                p=stage/"runtime"/"bin"/item["name"]
                self.assertEqual(builder.sha256(p),item["sha256"])
            self.assertTrue((stage/"backend"/"public"/"index.html").is_file())
            self.assertTrue((stage/"backend"/"server.mjs").is_file())


    @unittest.skipUnless(sys.platform=='win32' and os.environ.get('MONO_RELEASE_TOOLCHAIN')=='1','Requires the pinned Windows x64 release toolchain (set MONO_RELEASE_TOOLCHAIN=1)')


    def test_embedded_node_ffmpeg_stage_starts_without_system_fallback(self):
        import importlib.util
        spec=importlib.util.spec_from_file_location("bundle_build",ROOT/"launcher"/"build_portable.py")
        builder=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        if not all(__import__("shutil").which(x) for x in ("node","ffmpeg","ffprobe")):
            self.skipTest("build machine does not have runtimes")
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp)
            stage=builder.prepare(base/"stage")
            with patch("test_launcher.mono.assets_root",return_value=stage):
                with patch.dict(os.environ,{"MONO_HOME":str(base/"private")},clear=False):
                    with socket.socket() as listener:
                        listener.bind(('127.0.0.1',0));port=listener.getsockname()[1]
                    with patch.multiple(mono,PORT=port,URL=f'http://127.0.0.1:{port}'):
                        result=mono.run(dev=False,smoke=True,preferred_ui="auto")
                        self.assertEqual(result,0)

    @unittest.skipUnless(sys.platform.startswith("linux"), "SIGKILL integration scenario runs on Linux")
    def test_backend_terminates_if_launcher_is_killed(self):
        import signal
        if not all(__import__("shutil").which(x) for x in ("node","ffmpeg","ffprobe")):
            self.skipTest("runtimes missing")
        with tempfile.TemporaryDirectory() as tmp:
            env=os.environ.copy()
            env["MONO_HOME"]=tmp
            parent=subprocess.Popen([sys.executable,str(ROOT/"launcher"/"mono_launcher.py"),
                                     "--dev","--smoke","--smoke-hold","20"],
                                    cwd=ROOT,env=env,stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL,text=True)
            try:
                deadline=__import__("time").monotonic()+13
                while not mono.healthy() and __import__("time").monotonic()<deadline:
                    __import__("time").sleep(.1)
                self.assertTrue(mono.healthy(),"launcher failed to open backend")
                parent.kill()
                parent.wait(timeout=4)
                deadline=__import__("time").monotonic()+10
                while mono.healthy(timeout=.3) and __import__("time").monotonic()<deadline:
                    __import__("time").sleep(.12)
                self.assertFalse(mono.healthy(timeout=.3), "orphan backend should exit on pipe EOF")
            finally:
                if parent.poll() is None:
                    parent.kill()
                    parent.wait(timeout=4)
                if parent.stdout:
                    parent.stdout.close()

    def test_real_backend_smoke_starts_and_exits(self):
        if not all(__import__("shutil").which(x) for x in ("node","ffmpeg","ffprobe")):
            self.skipTest("dev system runtimes not installed")
        with tempfile.TemporaryDirectory() as tmp:
            env=os.environ.copy()
            env["MONO_HOME"]=tmp
            env.pop("MONO_PROXY_SECRET",None)
            with socket.socket() as listener:
                listener.bind(('127.0.0.1',0));port=listener.getsockname()[1]
            url=f'http://127.0.0.1:{port}'
            proc=subprocess.run([sys.executable,str(ROOT/"launcher"/"mono_launcher.py"),
                                 "--dev","--smoke","--port",str(port)],cwd=ROOT,env=env,
                                text=True,capture_output=True,timeout=28)
            self.assertEqual(proc.returncode,0,proc.stderr[-600:])
            result=json.loads(proc.stdout.strip())
            self.assertTrue(result["ok"])
            self.assertEqual(result["url"],url)
            self.assertTrue((Path(tmp)/"server"/"jobs").is_dir())
            self.assertFalse(mono.healthy(url=url,timeout=.3))


if __name__=="__main__":
    unittest.main()
