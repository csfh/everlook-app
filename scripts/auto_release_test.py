#!/usr/bin/env python3
import subprocess
import tempfile
import unittest
from pathlib import Path

import auto_release

PRODUCT = "app"
VERSION_FILE = "package.json"
TAG = "app-v"


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True)


class Levels(unittest.TestCase):
    def test_bump_levels(self) -> None:
        self.assertEqual(auto_release.bump_version("0.4.1", "patch"), "0.4.2")
        self.assertEqual(auto_release.bump_version("0.4.1", "minor"), "0.5.0")
        self.assertEqual(auto_release.bump_version("1.4.1", "major"), "2.0.0")

    def test_breaking_change_stays_below_one_point_zero(self) -> None:
        self.assertEqual(auto_release.bump_version("0.4.1", "major"), "0.5.0")

    def test_rejects_prerelease(self) -> None:
        with self.assertRaises(ValueError):
            auto_release.bump_version("1.0.0-beta", "patch")

    def test_commit_levels(self) -> None:
        self.assertEqual(auto_release.commit_level("feat: add"), "minor")
        self.assertEqual(auto_release.commit_level("fix(x): repair"), "patch")
        self.assertEqual(auto_release.commit_level("feat!: drop"), "major")
        self.assertEqual(auto_release.commit_level("fix: x", "BREAKING CHANGE: y"), "major")
        self.assertIsNone(auto_release.commit_level("docs: explain"))
        self.assertIsNone(auto_release.commit_level("chore: tidy"))
        self.assertEqual(auto_release.commit_level("Tidy things up"), "patch")

    def test_highest_wins(self) -> None:
        self.assertEqual(auto_release.highest(["patch", None, "minor", "patch"]), "minor")
        self.assertIsNone(auto_release.highest([None, None]))


class Planning(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.repo = Path(self.temporary.name)
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.email", "test@example.com")
        git(self.repo, "config", "user.name", "Test")
        (self.repo / "src.txt").write_text("one\n")
        self.write_version("0.4.1")
        self.before = self.commit("src.txt", "one\n", "chore: start")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_version(self, version: str) -> None:
        path = self.repo / VERSION_FILE
        path.parent.mkdir(parents=True, exist_ok=True)
        if PRODUCT == "addon":
            path.write_text(f"## Version: {version}\n")
        else:
            path.write_text('{\n  "name": "everlook",\n  "version": "%s"\n}\n' % version)
            lock = '{\n  "name": "everlook",\n  "version": "%s",\n  "packages": {\n    "": {\n      "name": "everlook",\n      "version": "%s"\n    }\n  }\n}\n' % (version, version)
            (self.repo / "package-lock.json").write_text(lock)

    def commit(self, relative: str, text: str, message: str) -> str:
        (self.repo / relative).write_text(text)
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", message)
        return git(self.repo, "rev-parse", "HEAD").strip()

    def plan(self, after: str, before: str | None = None, tag: str | None = None):
        return auto_release.plan_release(self.repo, before or self.before, after, VERSION_FILE, ["."], tag)

    def test_feat_is_minor(self) -> None:
        self.assertEqual(self.plan(self.commit("src.txt", "two\n", "feat: change")), ("minor", True))

    def test_fix_is_patch(self) -> None:
        self.assertEqual(self.plan(self.commit("src.txt", "two\n", "fix: change")), ("patch", True))

    def test_the_biggest_commit_in_a_push_wins(self) -> None:
        self.commit("src.txt", "two\n", "fix: small")
        self.commit("src.txt", "three\n", "feat!: break it")
        after = self.commit("src.txt", "four\n", "fix: small again")
        self.assertEqual(self.plan(after), ("major", True))

    def test_housekeeping_only_does_not_release(self) -> None:
        self.commit("src.txt", "two\n", "docs: comment")
        after = self.commit("src.txt", "three\n", "chore: tidy")
        self.assertEqual(self.plan(after), (None, False))

    def test_a_hand_set_version_releases_as_written(self) -> None:
        self.write_version("0.9.0")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "fix: ship a number")
        after = git(self.repo, "rev-parse", "HEAD").strip()
        self.assertEqual(self.plan(after), (None, True))

    def test_the_release_commit_does_not_release_again(self) -> None:
        self.write_version("0.4.2")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "chore: release x 0.4.2")
        after = git(self.repo, "rev-parse", "HEAD").strip()
        self.assertEqual(self.plan(after), (None, False))

    def test_first_push_is_a_patch_release(self) -> None:
        after = self.commit("src.txt", "two\n", "docs: comment")
        self.assertEqual(auto_release.plan_release(self.repo, "0" * 40, after, VERSION_FILE, ["."]), ("patch", True))

    def test_a_failed_earlier_push_still_counts_after_the_last_tag(self) -> None:
        git(self.repo, "tag", TAG + "0.4.1")
        self.commit("src.txt", "two\n", "feat: never released")
        before = git(self.repo, "rev-parse", "HEAD").strip()
        after = self.commit("src.txt", "three\n", "docs: comment")
        self.assertEqual(self.plan(after, before, TAG), ("minor", True))

    def test_nothing_since_the_last_tag_does_not_release(self) -> None:
        git(self.repo, "tag", TAG + "0.4.1")
        after = self.commit("src.txt", "two\n", "docs: comment")
        self.assertEqual(self.plan(after, tag=TAG), (None, False))

    def test_the_first_commit_tag_seeds_counting(self) -> None:
        git(self.repo, "tag", TAG + "0.4.1", self.before)
        self.commit("src.txt", "two\n", "docs: comment")
        after = self.commit("src.txt", "three\n", "fix: real")
        self.assertEqual(auto_release.plan_release(self.repo, "0" * 40, after, VERSION_FILE, ["."], TAG), ("patch", True))

    def test_bumps_the_version_file(self) -> None:
        after = self.commit("src.txt", "two\n", "feat: change")
        version, bumped, release, level = auto_release.maybe_bump(PRODUCT, self.repo, self.before, after)
        self.assertEqual((version, bumped, release, level), ("0.5.0", True, True, "minor"))
        self.assertIn("0.5.0", (self.repo / VERSION_FILE).read_text())


class Notes(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.repo = Path(self.temporary.name)
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.email", "test@example.com")
        git(self.repo, "config", "user.name", "Test")
        self.commit("feat: start")
        git(self.repo, "tag", TAG + "0.1.0")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def commit(self, message: str) -> None:
        path = self.repo / "a.txt"
        path.write_text(path.read_text() + "x" if path.exists() else "x")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", message)

    def test_groups_commits_and_skips_housekeeping(self) -> None:
        self.commit("feat: show a chip")
        self.commit("fix: stop the crash")
        self.commit("docs: explain")
        self.commit("chore: release x 0.2.0")
        notes = auto_release.release_notes(self.repo, TAG + "0.1.0", PRODUCT)
        self.assertIn("## Features", notes)
        self.assertIn("show a chip", notes)
        self.assertIn("## Fixes and improvements", notes)
        self.assertNotIn("explain", notes)
        self.assertNotIn("release", notes)

    def test_housekeeping_only_is_a_maintenance_release(self) -> None:
        self.commit("chore: tidy")
        self.assertEqual(auto_release.release_notes(self.repo, TAG + "0.1.0", PRODUCT), "Maintenance release.\n")


if __name__ == "__main__":
    unittest.main()
