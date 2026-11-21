"""Only redirecting links are unsafe; cloud placeholders and OS layout links are storage."""
import stat,unittest
from types import SimpleNamespace as S
from local_core.paths import is_link

DIR=stat.S_IFDIR|0o755
class LinkDetectionTests(unittest.TestCase):
    def test_onedrive_cloud_placeholder_directory_is_not_a_link(self):
        for tag in (0x9000001A,0x9000101A,0x9000F01A):  # IO_REPARSE_TAG_CLOUD[_1..F]
            self.assertFalse(is_link(S(st_mode=DIR,st_file_attributes=0x400,st_reparse_tag=tag)))
    def test_symlinks_and_junctions_are_links(self):
        self.assertTrue(is_link(S(st_mode=DIR,st_file_attributes=0x400,st_reparse_tag=0xA000000C)))
        self.assertTrue(is_link(S(st_mode=DIR,st_file_attributes=0x400,st_reparse_tag=0xA0000003)))
        self.assertTrue(is_link(S(st_mode=stat.S_IFLNK|0o777)))
    def test_plain_directory_is_not_a_link(self):
        self.assertFalse(is_link(S(st_mode=DIR)))

if __name__=='__main__':unittest.main()
