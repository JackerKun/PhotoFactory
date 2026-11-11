#!/usr/bin/env python3
"""Render the bundled overview from Natural Earth 5.1.2 1:50m GeoJSON.

Pillow is required to regenerate the asset. The map tool reads it using SQLite.
"""

import argparse
import hashlib
import io
import json
import math
import sqlite3
from contextlib import closing
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


OCEAN = "#b7d8e5"
LAND = "#f2efe4"
BORDER = "#b0a19d"
LABEL = "#324650"
TILE_SIZE = 256
STRIP_HEIGHT = TILE_SIZE * 4
LABEL_MARGIN = 24


def features(directory, layer):
    path = directory / f"ne_50m_{layer}.geojson"
    if not path.is_file():
        path = path.with_suffix(".json")
    return json.loads(path.read_text(encoding="utf-8"))["features"]


def project(point):
    lon, lat = point[:2]
    lat = min(85.0511287798066, max(-85.0511287798066, lat))
    return (lon + 180) / 360, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2


def polygons(directory, layer):
    for feature in features(directory, layer):
        geometry = feature["geometry"]
        if not geometry:
            continue
        coordinates = geometry["coordinates"]
        for polygon in [coordinates] if geometry["type"] == "Polygon" else coordinates:
            rings = [[project(point) for point in ring] for ring in polygon]
            latitudes = [y for _, y in rings[0]]
            yield min(latitudes), max(latitudes), rings


def places(directory):
    for feature in features(directory, "populated_places"):
        props = feature["properties"]
        name = props.get("NAME_ZH") or props.get("NAME")
        if name and feature["geometry"]:
            yield props["SCALERANK"], -props["POP_MAX"], name, project(feature["geometry"]["coordinates"])


def labels(places, size, max_rank, font):
    occupied = []
    for rank, _, name, (world_x, world_y) in places:
        if rank > max_rank:
            break
        x, y = round(world_x * size), round(world_y * size)
        _, top, right, bottom = font.getbbox(name, anchor="lm")
        bounds = x - 5, y + top - 3, x + 5 + right + 3, y + bottom + 3
        west, north, east, south = bounds
        if any(west < e and east > w and north < s and south > n for w, n, e, s in occupied):
            continue
        occupied.append(bounds)
        yield x, y, name


def render_strip(size, top, height, groups, markers, font):
    # Draw glyph masks onto RGB pixels. A palette image blends color indexes,
    # which produces alternating dark/light pixels around antialiased glyphs.
    image = Image.new("RGB", (size, height + 2 * LABEL_MARGIN), OCEAN)
    draw = ImageDraw.Draw(image)
    offset = top - LABEL_MARGIN
    for group, fill, outline, holes in groups:
        for low, high, rings in group:
            if high * size < offset or low * size >= offset + image.height:
                continue
            for index, ring in enumerate(rings):
                draw.polygon(
                    [(round(x * size), round(y * size) - offset) for x, y in ring],
                    fill=holes if index else fill,
                    outline=outline,
                )
    for x, y, name in markers:
        # A label near the strip edge may have pixels inside the crop even
        # when its center is outside. Each strip uses the same world position.
        if offset <= y < offset + image.height:
            y -= offset
            draw.ellipse((x - 1, y - 1, x + 1, y + 1), fill=LABEL)
            draw.text((x + 5, y), name, fill=LABEL, font=font, anchor="lm")
    return image


def render(directory, output, font):
    groups = [
        (list(polygons(directory, "admin_0_countries")), LAND, BORDER, OCEAN),
        (list(polygons(directory, "lakes")), OCEAN, None, LAND),
    ]
    cities = sorted(places(directory))
    images = {}
    with closing(sqlite3.connect(output)) as conn, conn:
        conn.executescript("""
            CREATE TABLE images (id INTEGER PRIMARY KEY, data BLOB NOT NULL);
            CREATE TABLE coords (z INTEGER, x INTEGER, y INTEGER, id INTEGER,
                PRIMARY KEY (z,x,y)) WITHOUT ROWID;
            CREATE VIEW tiles AS SELECT z AS zoom_level, x AS tile_column,
                y AS tile_row, data AS tile_data FROM coords JOIN images USING(id);
        """)
        for z, rank in enumerate((-1, -1, 1, 2, 3, 5, 7)):
            edge = 1 << z
            size = edge * TILE_SIZE
            markers = list(labels(cities, size, rank, font))
            for top in range(0, size, STRIP_HEIGHT):
                height = min(STRIP_HEIGHT, size - top)
                strip = render_strip(size, top, height, groups, markers, font)
                for row in range(0, height, TILE_SIZE):
                    y = edge - 1 - (top + row) // TILE_SIZE
                    for x in range(edge):
                        left, upper = x * TILE_SIZE, row + LABEL_MARGIN
                        tile = strip.crop((left, upper, left + TILE_SIZE, upper + TILE_SIZE))
                        buffer = io.BytesIO()
                        tile.save(buffer, format="PNG", compress_level=6)
                        data = buffer.getvalue()
                        key = hashlib.sha256(data).digest()
                        if key not in images:
                            images[key] = conn.execute("INSERT INTO images(data) VALUES (?)", (data,)).lastrowid
                        conn.execute("INSERT INTO coords VALUES (?,?,?,?)", (z, x, y, images[key]))
            print(f"Rendered level {z}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("geojson", type=Path, help="directory containing the Natural Earth GeoJSON files")
    parser.add_argument("font", type=Path, help="font with Simplified Chinese glyphs")
    parser.add_argument("output", type=Path, help="new MBTiles asset")
    parser.add_argument("--font-index", type=int, default=0, help="font face index for TTC files")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("output already exists")
    render(args.geojson, args.output, ImageFont.truetype(str(args.font), 14, index=args.font_index))


if __name__ == "__main__":
    main()
