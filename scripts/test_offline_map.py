"""Exercises the command line packer's geographic selection and resume flow."""
import argparse
import base64
import sqlite3
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from offline_map import package, plan_package

CLI = Path(__file__).with_name('offline_map.py')
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf2sAAAAASUVORK5CYII=')


class OfflineMapTests(unittest.TestCase):
    def test_resumes_local_source_and_writes_tms_row(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            tile0 = root / 'tiles/0/0/0.png'
            tile0.parent.mkdir(parents=True)
            tile0.write_bytes(PNG)
            tile1 = root / 'tiles/1/1/0.png'  # a northeast bbox; XYZ y=0, TMS y=1
            output = root / '公司地图.mbtiles'
            args = [sys.executable, str(CLI), '--name', '测试地图', '--bbox=1,1,2,2',
                    '--min-zoom', '0', '--max-zoom', '1', '--tile-dir', str(root / 'tiles'),
                    '--output', str(output)]
            dry_run = subprocess.run([*args, '--dry-run'], capture_output=True, text=True, check=True)
            self.assertIn('2 tiles', dry_run.stdout)
            self.assertFalse(output.exists())
            incomplete = subprocess.run(args, capture_output=True, text=True)
            self.assertNotEqual(incomplete.returncode, 0)
            self.assertFalse(output.exists())
            self.assertTrue(output.with_name(output.name + '.part').exists())
            tile1.parent.mkdir(parents=True)
            tile1.write_bytes(PNG)
            completed = subprocess.run(args, capture_output=True, text=True, check=True)
            self.assertIn('Resuming: 1/2', completed.stdout)
            conn = sqlite3.connect(output)
            try:
                self.assertEqual(conn.execute('SELECT zoom_level,tile_column,tile_row FROM tiles ORDER BY zoom_level').fetchall(), [(0,0,0),(1,1,1)])
                self.assertEqual(conn.execute("SELECT value FROM metadata WHERE name='format'").fetchone(), ('png',))
            finally:
                conn.close()

    def test_scan_callback_reports_new_tiles_in_zoom_order_after_resuming(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = argparse.Namespace(
                output=root / 'scan.mbtiles', name='扫描测试', bbox=(1, 1, 2, 2),
                min_zoom=0, max_zoom=2, max_tiles=20, delay=0.1, layer='standard',
                tile_dir=root / 'tiles', tile_url=None, attribution='测试瓦片',
            )
            rectangles, total = plan_package(args)
            coords = [(z, x, y) for z, xs, ys in rectangles for x in xs for y in ys]
            observed = []

            def save_tile(z, x, y):
                tile = args.tile_dir / str(z) / str(x) / f'{y}.png'
                tile.parent.mkdir(parents=True, exist_ok=True)
                tile.write_bytes(PNG)

            def record(layer, z, x, y, data):
                self.assertEqual(layer, 'standard')
                self.assertEqual(data, PNG)
                observed.append((z, x, y))

            save_tile(*coords[0])
            with self.assertRaises(ValueError):
                package(args, rectangles, total, on_tile=record)
            self.assertEqual(observed, coords[:1])
            observed.clear()
            for coord in coords[1:]:
                save_tile(*coord)
            self.assertEqual(package(args, rectangles, total, on_tile=record), args.output.resolve())
            self.assertEqual(observed, coords[1:])

    def test_dual_layers_keep_independent_levels_and_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            standard = root / 'standard/1/1/0.png'
            standard.parent.mkdir(parents=True)
            standard.write_bytes(PNG)
            satellite = root / 'satellite/0/0/0.png'
            output = root / '双图层.pfmap'
            args = [sys.executable, str(CLI), '--name', '测试', '--bbox=1,1,2,2',
                    '--layer', 'both', '--min-zoom', '1', '--max-zoom', '1',
                    '--tile-dir', str(root / 'standard'), '--satellite-dir', str(root / 'satellite'),
                    '--satellite-min-zoom', '0', '--satellite-max-zoom', '0', '--output', str(output)]
            self.assertNotEqual(subprocess.run(args, capture_output=True).returncode, 0)
            self.assertFalse(output.exists())
            self.assertTrue(root.joinpath(output.name + '.parts/standard.mbtiles').is_file())
            satellite.parent.mkdir(parents=True)
            satellite.write_bytes(PNG)
            subprocess.run(args, capture_output=True, check=True)
            bundle = output.read_bytes()
            magic, first, second = struct.unpack('<8sQQ', bundle[:24])
            self.assertEqual(magic, b'PFMAP001')
            self.assertEqual(len(bundle), 24 + first + second)
            for index, (data, layer, zoom) in enumerate([
                (bundle[24:24 + first], 'standard', 1),
                (bundle[24 + first:], 'satellite', 0),
            ]):
                extracted = root / f'{index}.mbtiles'
                extracted.write_bytes(data)
                with sqlite3.connect(extracted) as conn:
                    self.assertEqual(conn.execute("SELECT value FROM metadata WHERE name='photofactory_layer'").fetchone(), (layer,))
                    self.assertEqual(conn.execute("SELECT zoom_level FROM tiles").fetchone(), (zoom,))

    def test_refuses_public_osm_bulk_even_in_dry_run(self):
        result = subprocess.run([sys.executable, str(CLI), '--name', 'OSM', '--bbox=1,1,2,2',
                                 '--min-zoom', '0', '--max-zoom', '1', '--output', 'osm.mbtiles',
                                 '--tile-url', 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                                 '--attribution', 'OpenStreetMap', '--dry-run'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('cannot be used for bulk packaging', result.stderr)


if __name__ == '__main__':
    unittest.main()
