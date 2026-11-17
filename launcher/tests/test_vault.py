import os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from local_core.protocol import CoreError
try:
    from local_core.vault import CredentialVault
except ImportError:CredentialVault=None

CANARY='gsk_'+('MonoSecretCanary91'*4)
class VaultTests(unittest.TestCase):
    def test_real_current_user_protection_round_trip_reopen_delete_and_no_plaintext(self):
        self.assertIsNotNone(CredentialVault,'System vault is missing')
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);vault=CredentialVault(root)
            self.assertFalse(vault.status()['configured']);stored=vault.store(CANARY,verified_at='2026-10-18T00:00:00Z');self.assertTrue(stored['configured']);self.assertTrue(stored['verified']);self.assertNotIn(CANARY,str(stored));self.assertEqual(stored['masked'],'•••• '+CANARY[-4:])
            self.assertEqual(CredentialVault(root).read(),CANARY)
            for file in root.rglob('*'):
                if file.is_file():self.assertNotIn(CANARY.encode(),file.read_bytes())
            vault.delete();self.assertFalse(vault.status()['configured']);self.assertIsNone(vault.read())
    def test_failed_protection_preserves_existing_key_and_never_claims_saved(self):
        self.assertIsNotNone(CredentialVault,'System vault is missing')
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);vault=CredentialVault(root);vault.store(CANARY,verified_at='2026-10-18T00:00:00Z')
            before={p.name:p.read_bytes() for p in root.iterdir() if p.is_file()}
            with patch.object(vault.backend,'store',side_effect=CoreError('VAULT_LOCKED','VAULT_LOCKED')):
                with self.assertRaises(CoreError):vault.store('gsk_'+('Replacement83'*5),verified_at='2026-10-18T00:00:01Z')
            self.assertEqual({p.name:p.read_bytes() for p in root.iterdir() if p.is_file()},before);self.assertEqual(vault.read(),CANARY)
    def test_corruption_fails_closed_and_invalid_keys_create_no_blob(self):
        self.assertIsNotNone(CredentialVault,'System vault is missing')
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);vault=CredentialVault(root)
            for value in ['',CANARY+'\n','x'*513,{'key':CANARY}]:
                with self.subTest(value=type(value).__name__):
                    with self.assertRaises(CoreError):vault.store(value,verified_at='2026-10-18T00:00:00Z')
            self.assertEqual(list(root.iterdir()),[])
            vault.store(CANARY,verified_at='2026-10-18T00:00:00Z')
            if sys.platform=='win32':
                file=root/'groq.dpapi';file.write_bytes(file.read_bytes()[:10]+b'corrupted')
                with self.assertRaises(CoreError):vault.read()
                self.assertTrue(file.exists())
