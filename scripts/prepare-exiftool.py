"""Stage a pinned ExifTool distribution for the native installers."""

import argparse
import hashlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

VERSION = "13.61"
SOURCE_COMMIT = "9b8664dfcf2c609d3cc8925d380e98ad2a379f9b"
ARCHIVES = {
    "macos": (
        f"https://codeload.github.com/exiftool/exiftool/tar.gz/{SOURCE_COMMIT}",
        "0ddaa7c6e7795348f942d85acecdd397dcbcdce93ab4ac4c7285670d3b68128f",
    ),
    "windows": (
        f"https://downloads.sourceforge.net/project/exiftool/exiftool-{VERSION}_64.zip",
        "ab75b37515385a753aa60a58f68ffffe1ff81e43b319df9540978fb19e0580e5",
    ),
}
DESTINATION = Path(__file__).resolve().parents[1] / "build" / "exiftool"


def rename_staged(source: Path, destination: Path) -> None:
    # Windows scanners can briefly hold files as soon as they are extracted.
    for delay in (0.25, 0.5, 1, 2, 4, 0):
        try:
            source.rename(destination)
            return
        except OSError as error:
            if not delay or getattr(error, "winerror", None) not in (5, 32, 33):
                raise
            time.sleep(delay)


def stage(platform: str, local_archive: Path | None) -> None:
    url, sha256 = ARCHIVES[platform]
    marker = DESTINATION / ".archive-sha256"
    executable = "exiftool.exe" if platform == "windows" else "exiftool"
    support_file = "exiftool_files/exiftool.pl" if platform == "windows" else "lib/Image/ExifTool.pm"
    if (
        local_archive is None and marker.is_file() and marker.read_text().strip() == sha256
        and (DESTINATION / executable).is_file() and (DESTINATION / support_file).is_file()
    ):
        return

    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=DESTINATION.parent) as work:
        work = Path(work)
        archive = local_archive or (work / "archive")
        if local_archive is None:
            request = urllib.request.Request(url, headers={"User-Agent": "PhotoFactory release builder"})
            with urllib.request.urlopen(request, timeout=60) as source, archive.open("wb") as out:
                shutil.copyfileobj(source, out)
        with archive.open("rb") as source:
            actual = hashlib.file_digest(source, "sha256").hexdigest()
        if actual != sha256:
            raise ValueError(f"ExifTool archive checksum mismatch: expected {sha256}, got {actual}")

        staged = work / "staged"
        if platform == "windows":
            with zipfile.ZipFile(archive) as distribution:
                distribution.extractall(work)
            rename_staged(work / f"exiftool-{VERSION}_64", staged)
            rename_staged(staged / "exiftool(-k).exe", staged / executable)
            command = [str(DESTINATION / executable)]
        else:
            prefix = f"exiftool-{SOURCE_COMMIT}"
            with tarfile.open(archive, "r:gz") as distribution:
                members = [
                    member for member in distribution.getmembers()
                    if member.name in {f"{prefix}/{name}" for name in ("exiftool", "LICENSE", "README")}
                    or member.name.startswith(f"{prefix}/lib/")
                ]
                distribution.extractall(work, members=members, filter="data")
            (work / prefix).rename(staged)
            (staged / executable).chmod(0o755)
            command = ["/usr/bin/perl", str(DESTINATION / executable)]

        if not (staged / support_file).is_file():
            raise FileNotFoundError(f"ExifTool support file missing: {support_file}")
        if DESTINATION.exists():
            shutil.rmtree(DESTINATION)
        rename_staged(staged, DESTINATION)

    # Verify in place. Windows ARM64 can retain handles to the x64 launcher
    # after it exits, which prevents moving the resource directory afterward.
    native = sys.platform == ("win32" if platform == "windows" else "darwin")
    if native:
        reported = subprocess.check_output([*command, "-ver"], text=True).strip()
        if reported != VERSION:
            raise ValueError(f"Unexpected ExifTool version: {reported}")
    marker.write_text(sha256 + "\n")
    print(f"Staged ExifTool {VERSION} for {platform}: {DESTINATION}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("platform", type=str.lower, choices=ARCHIVES)
    parser.add_argument("--archive", type=Path, help="Use a local archive with the pinned checksum.")
    args = parser.parse_args()
    stage(args.platform, args.archive)
