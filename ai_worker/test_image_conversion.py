"""Regression tests for the desktop worker's model-free conversion command."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from PIL import Image
from pillow_heif import register_heif_opener


class ImageConversionTests(unittest.TestCase):
    def test_heic_unicode_path_converts_without_models_or_server(self):
        register_heif_opener()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / '中文 photo.HEIC'
            destination = root / 'preview.jpg'
            Image.new('RGB', (80, 60), (120, 60, 30)).save(source, format='HEIF')
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name('server.py')),
                 '--convert-image', str(source), str(destination)],
                env={**os.environ, 'AI_MODELS_DIR': str(root / 'no-models')},
                capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            with Image.open(destination) as decoded:
                self.assertEqual(decoded.format, 'JPEG')
                self.assertEqual(decoded.size, (80, 60))

    def test_thumbnail_stream_reuses_process_and_recovers_from_bad_image(self):
        register_heif_opener()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "中文图.HEIC"
            Image.new("RGB", (800, 600), (120, 60, 30)).save(source, format="HEIF")
            requests = [
                {"source": str(path), "target": str(root / f"{index}.webp"), "size": 256}
                for index, path in enumerate([source, root / "missing.HEIC", source])
            ]
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name("server.py")), "--thumbnail-stream"],
                input="".join(json.dumps(request) + "\n" for request in requests),
                capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual([json.loads(line) for line in result.stdout.splitlines()], [True, False, True])
            for index in (0, 2):
                with Image.open(root / f"{index}.webp") as thumbnail:
                    self.assertEqual(thumbnail.size, (256, 192))

    def test_invalid_heic_reports_failure_without_publishing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'broken.heic'
            destination = Path(directory) / 'preview.jpg'
            source.write_bytes(b'not an image')
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name('server.py')),
                 '--convert-image', str(source), str(destination)],
                capture_output=True, timeout=30,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(destination.exists())


if __name__ == '__main__':
    unittest.main()
