#!/usr/bin/env python3
"""Pick the next desktop app version from commit messages.

Each push is read as conventional commits. The biggest change wins: a breaking change is a major bump,
feat is minor, fix, perf, refactor and revert are patch. docs, test, chore, ci,
style and build do not release. A subject that is not a conventional commit
counts as patch, so a change never ships silently without a version.
Before 1.0.0 a breaking change bumps minor, so it never jumps to 1.0.0 by accident.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
TOC_VERSION = re.compile(r"^(## Version: )(\S+)", re.MULTILINE)
LOCK_VERSION = re.compile(
    r'("name": "everlook",\n\s*"version": ")([^"]+)(")',
)
JSON_VERSION_LINE = re.compile(r'^"version"\s*:\s*"([^"]+)"')
TOC_VERSION_LINE = re.compile(r"^## Version:\s*(\S+)", re.IGNORECASE)
ZERO_SHA = "0" * 40


LEVELS = ("patch", "minor", "major")
CONVENTIONAL = re.compile(r"^(\w+)(\([^)]*\))?(!)?:\s")
BREAKING_BODY = re.compile(r"^BREAKING[ -]CHANGE:", re.MULTILINE)
LEVEL_BY_TYPE = {
    "feat": "minor",
    "fix": "patch",
    "perf": "patch",
    "refactor": "patch",
    "revert": "patch",
}
SILENT_TYPES = {"docs", "test", "tests", "chore", "ci", "style", "build"}
RELEASE_SUBJECT = re.compile(r"^chore: release ")


def bump_version(version: str, level: str = "patch") -> str:
    match = SEMVER.fullmatch(version.strip())
    if match is None:
        raise ValueError(f"unsupported version {version!r}")
    major, minor, patch = (int(part) for part in match.groups())
    if level == "major" and major == 0:
        level = "minor"
    if level == "major":
        return f"{major + 1}.0.0"
    if level == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def commit_level(subject: str, body: str = "") -> str | None:
    """The bump one commit asks for, or None when it does not release."""
    match = CONVENTIONAL.match(subject)
    if match is None:
        return "patch"
    kind = match.group(1).lower()
    if match.group(3) == "!" or BREAKING_BODY.search(body):
        return "major"
    if kind in SILENT_TYPES:
        return None
    return LEVEL_BY_TYPE.get(kind, "patch")


def highest(levels: list[str | None]) -> str | None:
    found = [level for level in levels if level is not None]
    return max(found, key=LEVELS.index) if found else None


def bump_app(root: Path, level: str = "patch") -> str:
    package_path = root / "package.json"
    lock_path = root / "package-lock.json"
    package = json.loads(package_path.read_text())
    current = package["version"]
    if not isinstance(current, str):
        raise ValueError("package.json version is not a string")
    version = bump_version(current, level)
    package["version"] = version
    package_path.write_text(json.dumps(package, indent=2) + "\n")
    lock = lock_path.read_text()
    updated, count = LOCK_VERSION.subn(rf"\g<1>{version}\3", lock, count=2)
    if count != 2:
        raise ValueError(f"expected 2 everlook version fields in package-lock.json, found {count}")
    lock_path.write_text(updated)
    return version


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(root), *args], text=True)


def commits_touching(
    root: Path, before: str, after: str, product_paths: list[str]
) -> list[tuple[str, str]]:
    """Subject and body of each commit in before..after that touches the product."""
    out = git(
        root, "log", "--format=%s%x1f%b%x1e", f"{before}..{after}", "--", *product_paths
    )
    commits = []
    for record in out.split("\x1e"):
        if record.strip():
            subject, _, body = record.partition("\x1f")
            commits.append((subject.strip(), body.strip()))
    return commits


PRODUCTS = {
    "app": {"file": "package.json", "paths": ["."], "tag": "app-v"},
}
PRODUCT_PATHS = {name: product["paths"] for name, product in PRODUCTS.items()}
NOTE_SECTIONS = (
    ("major", "Breaking changes"),
    ("minor", "Features"),
    ("patch", "Fixes and improvements"),
)


def release_notes(root: Path, since: str, product: str) -> str:
    """Markdown notes for the commits that touched a product since a ref.

    Housekeeping commits and release commits are left out. A missing or empty
    ref falls back to the latest commit, so a first release still has notes.
    """
    paths = PRODUCT_PATHS[product]
    if since in ("", ZERO_SHA):
        out = git(root, "log", "-1", "--format=%h%x1f%s%x1f%b%x1e", "--", *paths)
    else:
        out = git(root, "log", f"--format=%h%x1f%s%x1f%b%x1e", f"{since}..HEAD", "--", *paths)
    grouped: dict[str, list[str]] = {level: [] for level, _ in NOTE_SECTIONS}
    for record in out.split("\x1e"):
        if not record.strip():
            continue
        short, _, rest = record.strip().partition("\x1f")
        subject, _, body = rest.partition("\x1f")
        subject = subject.strip()
        if RELEASE_SUBJECT.match(subject):
            continue
        level = commit_level(subject, body)
        if level is None:
            continue
        match = CONVENTIONAL.match(subject)
        text = subject[match.end():] if match else subject
        grouped[level].append(f"- {text} ({short})")
    sections = [
        f"## {title}\n\n" + "\n".join(grouped[level])
        for level, title in NOTE_SECTIONS
        if grouped[level]
    ]
    return "\n\n".join(sections) + "\n" if sections else "Maintenance release.\n"


def latest_tag(root: Path, prefix: str, ref: str) -> str | None:
    try:
        out = subprocess.check_output(
            ["git", "-C", str(root), "describe", "--tags", "--abbrev=0", "--match", f"{prefix}*", ref],
            text=True,
            stderr=subprocess.DEVNULL,
        )
        return out.strip() or None
    except subprocess.CalledProcessError:
        return None


def release_base(root: Path, tag_prefix: str | None, version_file: str, ref: str) -> str | None:
    """Where counting starts for a product: its last release tag.

    A product that was released before tags were made has none. Its last
    "chore: release" commit on its own version file marks the same point, so
    work after it is still counted when a push fails to release it.
    """
    tag = latest_tag(root, tag_prefix, ref) if tag_prefix else None
    if tag is not None:
        return tag
    for line in git(root, "log", "--format=%H%x1f%s", ref, "--", version_file).splitlines():
        sha, _, subject = line.partition("\x1f")
        if RELEASE_SUBJECT.match(subject):
            return sha
    return None


def plan_release(
    root: Path,
    before: str,
    after: str,
    version_file: str,
    product_paths: list[str],
    tag_prefix: str | None = None,
    former_files: tuple[str, ...] = (),
) -> tuple[str | None, bool]:
    """Return (bump level, whether to release).

    Commits are counted from the product's last release (see release_base), so
    a push whose tests failed or whose run was cancelled still counts in the
    next one. With no release at all, only this push counts. A level of None
    with release True means the push already set the version by hand, so the
    release ships it as it is. The diff also covers the version file's former
    paths, so moving the file reads as the old version leaving and the same
    version arriving, not as a hand-set one.
    """
    base = release_base(root, tag_prefix, version_file, after)
    if base is None and before in ("", ZERO_SHA):
        return "patch", True
    commits = commits_touching(root, base or before, after, product_paths)
    ours = [(s, b) for s, b in commits if not RELEASE_SUBJECT.match(s)]
    if not ours:
        return None, False
    diff = "" if before in ("", ZERO_SHA) else git(root, "diff", before, after, "--", version_file, *former_files)
    if version_field_changed(diff):
        return None, True
    level = highest([commit_level(s, b) for s, b in ours])
    return level, level is not None


def version_value(line_body: str) -> str | None:
    match = JSON_VERSION_LINE.match(line_body) or TOC_VERSION_LINE.match(line_body)
    if match:
        return match.group(1)
    return line_body if SEMVER.fullmatch(line_body) else None


def version_field_changed(diff: str) -> bool:
    old = None
    new = None
    for line in diff.splitlines():
        if not line.startswith(("+", "-")) or line.startswith(("+++", "---")):
            continue
        value = version_value(line[1:].strip())
        if value is None:
            continue
        if line.startswith("-"):
            old = value
        else:
            new = value
    return old != new and (old is not None or new is not None)


def write_output(version: str, bumped: bool, release: bool, level: str | None) -> None:
    lines = (
        f"version={version}\n"
        f"bumped={'true' if bumped else 'false'}\n"
        f"release={'true' if release else 'false'}\n"
        f"level={level or ''}\n"
    )
    sys.stdout.write(lines)
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with Path(output).open("a", encoding="utf-8") as handle:
            handle.write(lines)


def current_app_version(root: Path) -> str:
    version = json.loads((root / "package.json").read_text())["version"]
    if not isinstance(version, str):
        raise ValueError("package.json version is not a string")
    return version


VERSIONS = {
    "app": (current_app_version, bump_app),
}


def maybe_bump(
    product: str, root: Path, before: str, after: str
) -> tuple[str, bool, bool, str | None]:
    current, bump = VERSIONS[product]
    info = PRODUCTS[product]
    level, release = plan_release(
        root, before, after, info["file"], info["paths"], info["tag"], info.get("former_files", ())
    )
    if level is not None:
        return bump(root, level), True, True, level
    return current(root), False, release, None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("maybe-bump-app", "release-notes"))
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--before", default=ZERO_SHA)
    parser.add_argument("--after", default="HEAD")
    parser.add_argument("--product", choices=tuple(PRODUCT_PATHS))
    parser.add_argument("--since", default="")
    args = parser.parse_args(argv)
    root = args.root.resolve()
    if args.command == "release-notes":
        if args.product is None:
            parser.error("release-notes needs --product")
        since = args.since
        info = PRODUCTS[args.product]
        if latest_tag(root, info["tag"], "HEAD") is None:
            since = release_base(root, info["tag"], info["file"], "HEAD") or since
        sys.stdout.write(release_notes(root, since, args.product))
        return 0
    product = args.command.removeprefix("maybe-bump-")
    version, bumped, release, level = maybe_bump(product, root, args.before, args.after)
    write_output(version, bumped, release, level)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
