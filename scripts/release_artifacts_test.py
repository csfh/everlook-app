import base64
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
from release_artifacts import manifest, publication_order, publish, specifications


class ReleaseArtifactsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.version = '0.6.0'
        for _, _, _, name in specifications(self.version):
            (self.root / name).write_bytes(b'packaged app fixture')
        (self.root / 'Everlook-0.6.0-windows-x64.exe.blockmap').write_bytes(b'blockmap')
        checksum = base64.b64encode(hashlib.sha512(b'packaged app fixture').digest()).decode()
        for feed, binary in [('latest-linux.yml', 'Everlook-0.6.0.AppImage'), ('latest.yml', 'Everlook-0.6.0-windows-x64.exe')]:
            (self.root / feed).write_text(f'version: 0.6.0\nfiles:\n  - url: {binary}\n    sha512: {checksum}\n    size: 20\npath: {binary}\nsha512: {checksum}\n')

    def test_complete_manifest_matches_exact_platform_names_and_bytes(self):
        release = manifest(self.root, self.version)
        self.assertEqual(len(release['artifacts']), 6)
        self.assertEqual([row['arch'] for row in release['artifacts'][-2:]], ['x64', 'arm64'])
        self.assertEqual(release['artifacts'][0]['sha256'], hashlib.sha256(b'packaged app fixture').hexdigest())
        self.assertRegex(release['publishedAt'], r'Z$')

    def test_a_missing_native_build_prevents_release(self):
        (self.root / 'Everlook-0.6.0-mac-arm64.dmg').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing'):
            manifest(self.root, self.version)

    def test_all_native_receipts_must_match_source_version_and_architecture(self):
        targets = [('linux-x64', 'linux', 'x64'), ('windows-x64', 'win32', 'x64'), ('macos-x64', 'darwin', 'x64'), ('macos-arm64', 'darwin', 'arm64')]
        for identity, platform, arch in targets:
            (self.root / f'build-{identity}.json').write_text(json.dumps(dict(sourceSha='a' * 40, version=self.version, platform=platform, arch=arch)))
        self.assertEqual(manifest(self.root, self.version, 'a' * 40)['version'], self.version)
        (self.root / 'build-macos-arm64.json').write_text(json.dumps(dict(sourceSha='b' * 40, version=self.version, platform='darwin', arch='arm64')))
        with self.assertRaisesRegex(ValueError, 'source revision'):
            manifest(self.root, self.version, 'a' * 40)

    def test_mismatched_feed_version_rejected(self):
        feed = self.root / 'latest.yml'
        feed.write_text(feed.read_text().replace('version: 0.6.0', 'version: 0.5.0'))
        with self.assertRaisesRegex(ValueError, 'version'):
            manifest(self.root, self.version)

    def test_external_or_traversal_feed_url_rejected(self):
        for replacement in ['https://example.test/app.exe?token=secret', '../Everlook-0.6.0-windows-x64.exe']:
            with self.subTest(replacement=replacement):
                feed = self.root / 'latest.yml'
                original = feed.read_text()
                feed.write_text(original.replace('url: Everlook-0.6.0-windows-x64.exe', 'url: ' + replacement))
                with self.assertRaisesRegex(ValueError, 'local filename'):
                    manifest(self.root, self.version)
                feed.write_text(original)

    def test_quoted_remote_extra_entry_rejected(self):
        feed = self.root / 'latest.yml'
        feed.write_text(feed.read_text().replace('files:\n', 'files:\n  - "url": https://example.invalid/other-x64.exe\n    "sha512": attacker-controlled\n    "size": 1\n'))
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            manifest(self.root, self.version)

    def linux_feed_with_deb(self, deb_checksum=None):
        checksum = base64.b64encode(hashlib.sha512(b'packaged app fixture').digest()).decode()
        deb = 'everlook_0.6.0_amd64.deb'
        feed = self.root / 'latest-linux.yml'
        feed.write_text(
            'version: 0.6.0\nfiles:\n'
            f'  - url: Everlook-0.6.0.AppImage\n    sha512: {checksum}\n    size: 20\n    blockMapSize: 10\n'
            f'  - url: {deb}\n    sha512: {deb_checksum or checksum}\n    size: 20\n'
            f'path: Everlook-0.6.0.AppImage\nsha512: {checksum}\n')
        return feed

    def test_linux_feed_may_list_the_release_deb_next_to_the_appimage(self):
        self.linux_feed_with_deb()
        self.assertEqual(manifest(self.root, self.version)['version'], self.version)

    def test_linux_feed_deb_checksum_is_checked(self):
        self.linux_feed_with_deb(deb_checksum='attacker-controlled')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            manifest(self.root, self.version)

    def test_linux_feed_cannot_list_anything_but_its_own_files(self):
        feed = self.linux_feed_with_deb()
        feed.write_text(feed.read_text().replace('url: everlook_0.6.0_amd64.deb', 'url: https://example.invalid/other.deb'))
        with self.assertRaisesRegex(ValueError, 'local filename'):
            manifest(self.root, self.version)

    def test_duplicate_yaml_key_rejected(self):
        feed = self.root / 'latest.yml'
        feed.write_text(feed.read_text() + 'path: https://example.invalid/remote.exe\n')
        with self.assertRaisesRegex(ValueError, 'invalid updater YAML'):
            manifest(self.root, self.version)

    def test_modified_binary_rejected_by_updater_checksum(self):
        (self.root / 'Everlook-0.6.0-windows-x64.exe').write_bytes(b'modified installer')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            manifest(self.root, self.version)

    def test_missing_blockmap_rejected(self):
        (self.root / 'Everlook-0.6.0-windows-x64.exe.blockmap').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing'):
            manifest(self.root, self.version)

    def test_pointers_publish_after_all_binaries_manifest_last(self):
        release = manifest(self.root, self.version)
        order = publication_order(self.root, release)
        self.assertEqual(order[-1], ('desktop-release.json', 'desktop-release.json'))
        self.assertTrue(all(not row[0].endswith('.yml') for row in order[:7]))
        self.assertEqual(order[7][0], 'latest-linux.yml')

    def test_credentials_missing_fails_without_any_upload(self):
        run = Mock()
        with self.assertRaisesRegex(ValueError, 'Missing release credentials'):
            publish(self.root, manifest(self.root, self.version), environment={}, run=run)
        run.assert_not_called()

    def test_upload_failure_stops_before_manifest(self):
        run = Mock(side_effect=RuntimeError('storage unavailable'))
        environment = dict.fromkeys(['APP_AWS_BUCKET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ENDPOINT', 'AWS_DEFAULT_REGION'], 'fixture')
        with self.assertRaises(RuntimeError):
            publish(self.root, manifest(self.root, self.version), environment=environment, run=run)
        self.assertEqual(run.call_count, 1)
        self.assertNotIn('desktop-release.json', ' '.join(run.call_args.args[0]))


if __name__ == '__main__':
    unittest.main()
