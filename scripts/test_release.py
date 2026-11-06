import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = patch.dict('os.environ', {'GITHUB_SHA': 'test-commit'})
        self.env.start()
        self.addCleanup(self.env.stop)

    def manifests(self):
        (self.root / 'src-tauri').mkdir()
        for name, value in [('package.json', {'version': '1.2.3'}),
                            ('package-lock.json', {'version': '1.2.3', 'packages': {'': {'version': '1.2.3'}}}),
                            ('src-tauri/tauri.conf.json', {'version': '1.2.3'})]:
            (self.root / name).write_text(json.dumps(value))
        (self.root / 'src-tauri/Cargo.toml').write_text('[package]\nname="photofactory"\nversion="1.2.3"')
        (self.root / 'src-tauri/Cargo.lock').write_text('[[package]]\nname="photofactory"\nversion="1.2.3"')

    def builds(self):
        for (platform, arch), extensions in release.MATRIX.items():
            target = platform + '-' + arch
            directory = self.root / 'src-tauri/target' / target / 'release/bundle'
            directory.mkdir(parents=True)
            for ext in extensions:
                (directory / ('installer' + ext)).write_bytes(b'installer-test-data')
            release.collect(self.root, '1.2.3', platform, arch, 'x64', target)

    def test_matching_versions(self):
        self.manifests()
        self.assertEqual(release.version(self.root, 'v1.2.3'), '1.2.3')

    def test_wrong_tag_rejected(self):
        self.manifests()
        with self.assertRaises(ValueError):
            release.version(self.root, 'v9.9.9')

    def test_stale_lock_rejected(self):
        self.manifests()
        (self.root / 'package-lock.json').write_text('{"version":"1.2.2","packages":{"":{"version":"1.2.2"}}}')
        with self.assertRaises(ValueError):
            release.version(self.root)

    def test_complete_release(self):
        self.builds()
        release.assemble(self.root, '1.2.3')
        self.assertEqual(len((self.root / 'release/SHA256SUMS.txt').read_text().splitlines()), 5)
        self.assertEqual(len(json.loads((self.root / 'release/build-manifest.json').read_text())), 4)

    def test_missing_architecture_rejected(self):
        self.builds()
        (self.root / 'artifacts/manifest-Windows-arm64.json').unlink()
        with self.assertRaises(ValueError):
            release.assemble(self.root, '1.2.3')
        self.assertFalse((self.root / 'release').exists())

    def test_tampered_installer_rejected(self):
        self.builds()
        (self.root / 'artifacts/PhotoFactory_1.2.3_Windows_arm64.exe').write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            release.assemble(self.root, '1.2.3')
        self.assertFalse((self.root / 'release').exists())

    def test_mixed_commit_rejected(self):
        self.builds()
        with patch.dict('os.environ', {'GITHUB_SHA': 'another-commit'}):
            with self.assertRaises(ValueError):
                release.assemble(self.root, '1.2.3')

    def test_missing_installer_rejected(self):
        with self.assertRaises(ValueError):
            release.collect(self.root, '1.2.3', 'Windows', 'arm64', 'x64', 'missing')


if __name__ == '__main__':
    unittest.main()
