import unittest
from runtime_licenses import classify

class WrappedRuntimeLicenseTests(unittest.TestCase):
    def test_canonical_lgpl21_wrapped_title_is_recognized(self):
        # FFmpeg's real LGPL2.1 -L output wraps between Public and License.
        for program in ['ffmpeg','ffprobe']:
            output=f'{program} version 9.0.2\nGNU Lesser General Public\r\nLicense as published by the Free Software Foundation; either\r\nversion 2.1 of the License, or any later version.\n'
            self.assertEqual(classify(program,output),'LGPL-2.1-or-later')

    def test_whitespace_wrap_does_not_change_known_license_identity(self):
        for title,version,expected in [('GNU Lesser General Public License','3','LGPL-3.0-or-later'),('GNU General Public License','2','GPL-2.0-or-later'),('GNU General Public License','3','GPL-3.0-or-later'),('GNU Lesser General Public License','3.0','LGPL-3.0-or-later'),('GNU General Public License','2.0','GPL-2.0-or-later'),('GNU General Public License','3.0','GPL-3.0-or-later')]:
            wrapped=' \r\n\t'.join(title.split())
            self.assertEqual(classify('ffmpeg',f'ffmpeg version 9\n{wrapped} version\r\n{version} of the License'),'{}'.format(expected))

    def test_unknown_dotted_or_suffixed_versions_are_never_rounded_down(self):
        for title,versions in [('GNU Lesser General Public License',['2.1.1','2.10','3.1','3preview']),('GNU General Public License',['2.1','2preview','3.1','3preview'])]:
            for version in versions:
                with self.subTest(title=title,version=version),self.assertRaises(RuntimeError):
                    classify('ffmpeg',f'ffmpeg version 9\n{title} version {version}')

    def test_wrapped_title_still_refuses_nonfree_and_wrong_program(self):
        output='ffprobe version 9\nGNU Lesser General Public\nLicense version 2.1'
        with self.assertRaises(RuntimeError):classify('ffmpeg',output)
        with self.assertRaises(RuntimeError):classify('ffprobe',output+'\nconfiguration: --enable-nonfree')

if __name__=='__main__':unittest.main()
