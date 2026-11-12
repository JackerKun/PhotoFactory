"""Validate versions and fail closed before publishing a complete desktop release."""
import argparse
import hashlib
import json
import os
import re
import shutil
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MATRIX = {('macOS', 'arm64'): ('.dmg',), ('macOS', 'x64'): ('.dmg',),
          ('Windows', 'x64'): ('.msi', '.exe'), ('Windows', 'arm64'): ('.exe',)}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def version(root, tag=''):
    package = json.loads((root / 'package.json').read_text())
    lock = json.loads((root / 'package-lock.json').read_text())
    tauri = json.loads((root / 'src-tauri/tauri.conf.json').read_text())
    cargo = tomllib.loads((root / 'src-tauri/Cargo.toml').read_text())
    cargo_lock = tomllib.loads((root / 'src-tauri/Cargo.lock').read_text())
    app_lock = next(p for p in cargo_lock['package'] if p['name'] == cargo['package']['name'])
    values = [package['version'], lock['version'], lock['packages']['']['version'],
              tauri['version'], cargo['package']['version'], app_lock['version']]
    if len(set(values)) != 1:
        raise ValueError(f'Version mismatch (package, npm lock, Tauri, Cargo, Cargo lock): {values}')
    value = values[0]
    if not re.fullmatch(r'\d+\.\d+\.\d+', value):
        raise ValueError('Installer releases require a stable MAJOR.MINOR.PATCH version')
    if tag and tag != 'v' + value:
        raise ValueError(f'Tag {tag!r} must match v{value}; update manifests and lockfiles first')
    return value


def collect(root, value, platform, arch, worker, target):
    expected = MATRIX[(platform, arch)]
    bundle = root / 'src-tauri/target' / target / 'release/bundle'
    out = root / 'artifacts'
    out.mkdir(exist_ok=True)
    entries = []
    for ext in expected:
        candidates = list(bundle.rglob('*' + ext))
        if len(candidates) != 1:
            raise ValueError(f'Expected exactly one {ext} in {bundle}, got {candidates}')
        source = candidates[0]
        if not source.stat().st_size:
            raise ValueError(f'Empty installer: {source}')
        name = f'PhotoFactory_{value}_{platform}_{arch}{ext}'
        shutil.copy2(source, out / name)
        entries.append({'name': name, 'sha256': digest(out / name), 'bytes': source.stat().st_size})
    manifest = dict(version=value, platform=platform, arch=arch, worker_arch=worker,
                    target=target, commit=os.getenv('GITHUB_SHA', ''), files=entries)
    (out / f'manifest-{platform}-{arch}.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def assemble(root, value):
    source, out = root / 'artifacts', root / 'release'
    manifests = [json.loads(f.read_text()) for f in sorted(source.glob('manifest-*.json'))]
    keys = [(m['platform'], m['arch']) for m in manifests]
    if len(keys) != 4 or set(keys) != set(MATRIX):
        raise ValueError(f'Incomplete release matrix: {keys}')
    verified = []
    for manifest in manifests:
        if manifest['version'] != value:
            raise ValueError('Mixed release versions')
        if os.getenv('GITHUB_SHA') and manifest['commit'] != os.environ['GITHUB_SHA']:
            raise ValueError('Mixed build commits')
        platform, arch = manifest['platform'], manifest['arch']
        expected = {f'PhotoFactory_{value}_{platform}_{arch}{ext}' for ext in MATRIX[(platform, arch)]}
        if {f['name'] for f in manifest['files']} != expected:
            raise ValueError(f'Wrong installers for {platform}/{arch}')
        for entry in manifest['files']:
            path = source / entry['name']
            if path.stat().st_size != entry['bytes'] or digest(path) != entry['sha256']:
                raise ValueError(f'Installer checksum mismatch: {path.name}')
            verified.append((path, entry))
    # Validate everything before creating publishable output.
    out.mkdir(exist_ok=True)
    for path, _ in verified:
        shutil.copy2(path, out / path.name)
    (out / 'SHA256SUMS.txt').write_text(''.join(f"{e['sha256']}  {p.name}\n" for p, e in verified))
    (out / 'build-manifest.json').write_text(json.dumps(manifests, indent=2) + '\n')
    changes = root / 'docs' / 'releases' / f'v{value}.md'
    notes = changes.read_text(encoding='utf-8').strip() + '\n\n' if changes.is_file() else ''
    (out / 'NOTES.md').write_text(f'''PhotoFactory {value}

{notes}| System | Architecture | Installer |
| --- | --- | --- |
| macOS | Apple Silicon / ARM64 | macOS_arm64.dmg |
| macOS | Intel / x64 | macOS_x64.dmg |
| Windows | Intel / AMD x64 | Windows_x64.exe or Windows_x64.msi |
| Windows 11 | ARM64 | Windows_arm64.exe |

All packages include the AI Worker and downloaded models; no separate Python install is required.
Windows ARM64 uses a native ARM64 app with an x64 AI Worker under Windows 11 emulation.
32-bit Windows is not supported by this AI dependency stack.
Verify downloads with SHA256SUMS.txt; build-manifest.json records targets and Worker architectures.
macOS builds are ad-hoc signed (not notarized); Windows builds have no publisher certificate.
OCR and writing GPS to original files still require optional Tesseract / ExifTool.
See the repository README and docs/BUILDING.md for usage and limitations.
''', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('version').add_argument('--tag', default='')
    c = sub.add_parser('collect')
    for name in ['version', 'platform', 'arch', 'worker', 'target']:
        c.add_argument('--' + name, required=True)
    sub.add_parser('assemble').add_argument('--version', required=True)
    args = parser.parse_args()
    if args.command == 'version':
        value = version(ROOT, args.tag)
        print(value)
        if os.getenv('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
                stream.write(f'version={value}\n')
    elif args.command == 'collect':
        collect(ROOT, args.version, args.platform, args.arch, args.worker, args.target)
    else:
        assemble(ROOT, args.version)


if __name__ == '__main__':
    main()
