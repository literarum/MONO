"""Source-build contract: real pinned inputs, unsafe input denial, legacy neighbors."""
import hashlib,json,os,subprocess,tempfile,unittest,zipfile,tarfile,io
from pathlib import Path
from unittest.mock import patch

class SourceBuildTests(unittest.TestCase):
    def test_existing_output_is_preserved_without_download_or_execution(self):
        import build_ffmpeg_windows as build
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder);(output/'keep').write_bytes(b'original')
            with patch.object(build.urllib.request,'urlopen',side_effect=AssertionError('No download')),patch.object(build.subprocess,'run',side_effect=AssertionError('No execution')):
                with self.assertRaises(FileExistsError):build.build(output,Path('unused'))
            self.assertEqual((output/'keep').read_bytes(),b'original')

    def test_bad_cached_input_is_rejected_before_execution_or_request(self):
        import build_ffmpeg_windows as build
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);cache=root/'cache';cache.mkdir();(cache/'fixture.zip').write_bytes(b'wrong')
            item={'name':'fixture.zip','sha256':'a'*64,'size':5,'url':'https://example.invalid/unused'}
            with patch.object(build.urllib.request,'urlopen',side_effect=AssertionError('No request')),patch.object(build.subprocess,'run',side_effect=AssertionError('No execution')):
                with self.assertRaisesRegex(RuntimeError,'checksum'):build.acquire(item,root/'saved.zip',cache)
            self.assertFalse((root/'saved.zip').exists())

    def test_zip_and_tar_paths_links_case_collisions_are_refused(self):
        import build_ffmpeg_windows as build
        for kind,name in [('zip','../escape'),('zip','C:/escape'),('zip','top\\bad'),('zip','top/name:stream'),('zip','top/CON'),('zip','top/ending.'),('zip','top/a'),('tar','../escape'),('tar','top/link')]:
            with self.subTest(kind=kind,name=name),tempfile.TemporaryDirectory() as folder:
                root=Path(folder);archive=root/('input.'+kind)
                if kind=='zip':
                    with zipfile.ZipFile(archive,'w') as output:
                        entry=zipfile.ZipInfo(name);entry.filename=name;output.writestr(entry,b'a')
                        if name=='top/a':output.writestr('top/A',b'b')
                else:
                    with tarfile.open(archive,'w') as output:
                        entry=tarfile.TarInfo(name);entry.size=1
                        if name.endswith('link'):entry.type=tarfile.SYMTYPE;entry.linkname='elsewhere';entry.size=0
                        output.addfile(entry,io.BytesIO(b'a'))
                with self.assertRaisesRegex(RuntimeError,'Unsafe|inventory'):build.extract(archive,root/'out')
                self.assertFalse((root/'escape').exists())

    def test_configuration_covers_audio_assembly_and_zlib_without_gpl_or_network(self):
        import build_ffmpeg_windows as build
        # Minimal syntactically valid declaration inputs test option selection;
        # the actual compile and frozen consumer are separate acceptance gates.
        codecs='/* audio codecs */\nextern const FFCodec ff_aac_decoder;\nextern const FFCodec ff_flac_encoder;\n/* subtitles */'
        filters='extern const FFFilter ff_af_loudnorm;\nextern const FFFilter ff_asrc_sine;'
        options=build.configure_options(codecs,filters,Path('C:/build/install'),Path('C:/build/zlib'))
        for flag in ['--disable-autodetect','--disable-gpl','--disable-nonfree','--disable-version3','--disable-network','--enable-zlib']:
            self.assertIn(flag,options)
        self.assertNotIn('--disable-x86asm',options)
        self.assertIn('amovie',next(x for x in options if x.startswith('--enable-filter=')))
        self.assertIn('concat',next(x for x in options if x.startswith('--enable-filter=')))

class SourceBundleConsumerTests(unittest.TestCase):
    def test_real_source_bundle_and_notices_roundtrip_and_tamper_denial(self):
        from ffmpeg_bundle import read_bundle,stage_support,verify_support,SOURCE_NOTICES
        directory=Path(os.environ['MONO_TEST_SOURCE_FFMPEG_BUNDLE']);value=read_bundle(directory)
        self.assertEqual(value['schema'],2)
        self.assertEqual(set(value['licenses'].values()),{'LGPL-2.1-or-later'})
        with tempfile.TemporaryDirectory() as folder:
            runtime=Path(folder);support=stage_support(directory,runtime,value)
            verify_support(runtime,support)
            self.assertEqual(support['schema'],2)
            self.assertEqual(len([x for x in support['files'] if x['path'].endswith('.dll')]),7)
            for name in SOURCE_NOTICES:
                file=runtime/'licenses/ffmpeg'/name
                self.assertEqual(file.read_bytes(),(directory/name).read_bytes())
                original=file.read_bytes();file.write_bytes(b'tampered')
                with self.assertRaises(RuntimeError):verify_support(runtime,support)
                file.write_bytes(original)

    def test_source_recipe_lock_and_archives_cannot_be_self_consistently_replaced(self):
        import shutil,copy
        from ffmpeg_bundle import read_bundle
        directory=Path(os.environ['MONO_TEST_SOURCE_FFMPEG_BUNDLE'])
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'copy';shutil.copytree(directory,root)
            original=json.loads((root/'PROVENANCE.json').read_text(encoding='utf-8'))
            for name in ['BUILD-RECIPE.py','FFMPEG-SOURCE.tar.gz','ZLIB-SOURCE.tar.gz','BUILD-LOCK.json']:
                file=root/name;raw=file.read_bytes();file.write_bytes(b'replaced')
                changed=copy.deepcopy(original);row=next(v for v in changed['files'] if v['path']==name)
                row.update(size=file.stat().st_size,sha256=hashlib.sha256(file.read_bytes()).hexdigest())
                (root/'PROVENANCE.json').write_text(json.dumps(changed),encoding='utf-8')
                with self.assertRaises(RuntimeError):read_bundle(root)
                file.write_bytes(raw)
            (root/'PROVENANCE.json').write_text(json.dumps(original),encoding='utf-8');read_bundle(root)

    def test_release_gate_rejects_legacy_schema_before_any_child_execution(self):
        from ffmpeg_bundle import read_bundle,stage_support,require_source_support,LICENSES
        import copy
        directory=Path(os.environ['MONO_TEST_SOURCE_FFMPEG_BUNDLE'])
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);support=stage_support(directory,root,read_bundle(directory))
            legacy=copy.deepcopy(support);legacy['schema']=1
            legacy['files']=[v for v in legacy['files'] if v['path'].endswith('.dll') or v['path'].removeprefix('licenses/ffmpeg/') in LICENSES|{'PROVENANCE.json'}]
            with patch('subprocess.run',side_effect=AssertionError('No child may run')):
                with self.assertRaisesRegex(RuntimeError,'requires source-built'):require_source_support(root,legacy)

    def test_copy_changed_after_input_validation_is_not_blessed_by_new_hash(self):
        import shutil
        from ffmpeg_bundle import read_bundle,stage_support
        directory=Path(os.environ['MONO_TEST_SOURCE_FFMPEG_BUNDLE']);value=read_bundle(directory)
        real_copy=shutil.copy2
        def changed_copy(source,target,*args,**kwargs):
            result=real_copy(source,target,*args,**kwargs)
            if Path(target).name=='avcodec-63.dll':
                raw=bytearray(Path(target).read_bytes());raw[-1]^=1;Path(target).write_bytes(raw)
            return result
        with tempfile.TemporaryDirectory() as folder,patch('ffmpeg_bundle.shutil.copy2',side_effect=changed_copy):
            with self.assertRaisesRegex(RuntimeError,'changed during'):stage_support(directory,Path(folder),value)
