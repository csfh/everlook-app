"""Verify one complete desktop release before publishing its discovery pointers."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def specifications(version):
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version):
        raise ValueError('Release version must be a stable semantic version.')
    return [
        ('linux-appimage', 'linux', 'x64', f'Everlook-{version}.AppImage'),
        ('linux-deb', 'linux', 'x64', f'everlook_{version}_amd64.deb'),
        ('linux-omarchy', 'linux', 'x64', f'Everlook-{version}-omarchy.zip'),
        ('windows', 'win32', 'x64', f'Everlook-{version}-windows-x64.exe'),
        ('macos-x64', 'darwin', 'x64', f'Everlook-{version}-mac-x64.dmg'),
        ('macos-arm64', 'darwin', 'arm64', f'Everlook-{version}-mac-arm64.dmg'),
    ]


def regular_file(directory, name):
    candidate = directory / name
    if candidate.is_symlink() or not candidate.is_file() or candidate.stat().st_size == 0:
        raise ValueError(f'Missing or invalid release artifact: {name}')
    return candidate


def validate_feed(directory, feed, binary, version, companions=()):
    """Check an updater feed. It may list `binary` and, as electron-builder writes for Linux, the
    release's own companion packages. Every listed file must be local and match its bytes."""
    candidate = regular_file(directory, feed)
    try:
        parsed = subprocess.check_output(['node', str(Path(__file__).with_name('read-updater-feed.mjs')), str(candidate)], stderr=subprocess.PIPE, text=True)
        metadata = json.loads(parsed)
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        raise ValueError(f'{feed} contains invalid updater YAML.') from None
    allowed = {'version', 'files', 'path', 'sha512', 'releaseDate', 'releaseName', 'releaseNotes'}
    if not isinstance(metadata, dict) or not set(metadata).issubset(allowed) or metadata.get('version') != version:
        raise ValueError(f'{feed} has an unexpected version or schema.')
    names = [binary, *companions]
    files = metadata.get('files')
    if not isinstance(files, list) or not files or len(files) > len(names) or not all(isinstance(info, dict) for info in files):
        raise ValueError(f'{feed} must contain exactly one local filename.' if not companions else f'{feed} must list only its own local files.')
    seen = set()
    for info in files:
        name = info.get('url')
        if not set(info).issubset({'url', 'sha512', 'size', 'blockMapSize'}) or name not in names or name in seen:
            raise ValueError(f'{feed} must refer only to its versioned local filename.')
        seen.add(name)
        with regular_file(directory, name).open('rb') as stream:
            expected = base64.b64encode(hashlib.file_digest(stream, 'sha512').digest()).decode()
        if info.get('sha512') != expected or (name == binary and metadata.get('sha512') != expected):
            raise ValueError(f'{feed} checksum does not match the binary.')
        size = info.get('size')
        if type(size) is not int or size != (directory / name).stat().st_size:
            raise ValueError(f'{feed} size does not match the binary.')
        if 'blockMapSize' in info and (type(info['blockMapSize']) is not int or info['blockMapSize'] <= 0):
            raise ValueError(f'{feed} has an invalid blockmap size.')
    if binary not in seen or metadata.get('path') != binary:
        raise ValueError(f'{feed} must refer only to its versioned local filename.')


def manifest(directory, version, source_sha=None):
    if source_sha is not None:
        if not re.fullmatch(r'[0-9a-f]{40}', source_sha):
            raise ValueError('Invalid build source revision.')
        for identity, platform, arch in [('linux-x64', 'linux', 'x64'), ('windows-x64', 'win32', 'x64'), ('macos-x64', 'darwin', 'x64'), ('macos-arm64', 'darwin', 'arm64')]:
            receipt = json.loads(regular_file(directory, f'build-{identity}.json').read_text())
            if receipt != dict(sourceSha=source_sha, version=version, platform=platform, arch=arch):
                raise ValueError(f'{identity} did not build the prepared version and source revision.')
    artifacts = []
    for identity, platform, arch, name in specifications(version):
        candidate = regular_file(directory, name)
        with candidate.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        artifacts.append(dict(id=identity, platform=platform, arch=arch, filename=name, size=candidate.stat().st_size, sha256=digest))
    validate_feed(directory, 'latest-linux.yml', f'Everlook-{version}.AppImage', version, companions=(f'everlook_{version}_amd64.deb',))
    validate_feed(directory, 'latest.yml', f'Everlook-{version}-windows-x64.exe', version)
    regular_file(directory, f'Everlook-{version}-windows-x64.exe.blockmap')
    return dict(version=version, publishedAt=datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'), artifacts=artifacts)


def publication_order(directory, release):
    names = [artifact['filename'] for artifact in release['artifacts']]
    for binary in [f"Everlook-{release['version']}.AppImage", f"Everlook-{release['version']}-windows-x64.exe"]:
        if (directory / (binary + '.blockmap')).exists():
            regular_file(directory, binary + '.blockmap')
            names.append(binary + '.blockmap')
    return [(name, name) for name in names] + [
        ('latest-linux.yml', 'latest-linux.yml'), ('latest-linux.yml', 'updates/latest-linux.yml'),
        ('latest.yml', 'latest.yml'), ('latest.yml', 'updates/latest.yml'),
        ('desktop-release.json', 'desktop-release.json')]


def publish(directory, release, environment=os.environ, run=subprocess.run):
    required = ['APP_AWS_BUCKET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ENDPOINT', 'AWS_DEFAULT_REGION']
    missing = [name for name in required if not environment.get(name)]
    if missing:
        raise ValueError('Missing release credentials: ' + ', '.join(missing))
    # No external writes occur until every file and both feeds have been verified.
    for source, destination in publication_order(directory, release):
        content_type = 'application/json' if source.endswith('.json') else 'text/yaml' if source.endswith('.yml') else 'application/zip' if source.endswith('.zip') else 'application/octet-stream'
        run(['aws', '--endpoint-url', environment['AWS_ENDPOINT'], 's3', 'cp', str(directory / source), f"s3://{environment['APP_AWS_BUCKET']}/{destination}", '--content-type', content_type, '--cache-control', 'no-cache' if source.endswith(('.yml', '.json')) else 'public, max-age=31536000, immutable'], check=True, env=environment)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    parser.add_argument('version')
    parser.add_argument('--publish', action='store_true')
    parser.add_argument('--source-sha')
    args = parser.parse_args()
    release = manifest(args.directory, args.version, args.source_sha)
    (args.directory / 'desktop-release.json').write_text(json.dumps(release, indent=2) + '\n')
    if args.publish:
        publish(args.directory, release)
    print(f"Verified {len(release['artifacts'])} desktop artifacts for {release['version']}.")


if __name__ == '__main__':
    main()
