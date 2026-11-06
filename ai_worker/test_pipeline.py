"""PhotoFactory AI Pipeline Test Tool.

Creates a .pf project for /Users/jackerkun/Media, imports photos,
runs face detection + scene classification + face clustering via
the AI worker HTTP API, and stores everything in the SQLite DB.
"""

import os
import sys
import json
import sqlite3
import time
import tempfile
import subprocess
from pathlib import Path
from datetime import datetime

MEDIA_DIR = "/Users/jackerkun/Media"
PF_DIR = os.path.join(MEDIA_DIR, ".pf")
DB_PATH = os.path.join(PF_DIR, "photos.db")
FACES_CACHE = os.path.join(PF_DIR, "ai_cache", "faces")
TEMP_EMBED_DIR = os.path.join(tempfile.gettempdir(), "photofactory_faces_test")

AI_WORKER_URL = "http://127.0.0.1:9876"

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".tiff", ".tif", ".bmp", ".arw", ".cr2", ".nef", ".dng", ".raw", ".orf", ".rw2", ".pef"}

CREATE_TABLES = """
CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, filename TEXT NOT NULL,
    file_size INTEGER NOT NULL, file_mtime INTEGER NOT NULL, width INTEGER,
    height INTEGER, format TEXT, taken_at INTEGER, camera_make TEXT,
    camera_model TEXT, latitude REAL, longitude REAL, orientation INTEGER DEFAULT 1,
    thumbnail_status INTEGER DEFAULT 0, ai_status INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0, is_favorite INTEGER DEFAULT 0, imported_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_classifications (
    id INTEGER PRIMARY KEY, photo_id INTEGER NOT NULL REFERENCES photos(id),
    category TEXT NOT NULL, label TEXT NOT NULL, confidence REAL NOT NULL,
    UNIQUE(photo_id, label)
);
CREATE TABLE IF NOT EXISTS face_detections (
    id INTEGER PRIMARY KEY, photo_id INTEGER NOT NULL REFERENCES photos(id),
    bbox_x INTEGER, bbox_y INTEGER, bbox_w INTEGER, bbox_h INTEGER,
    embedding_path TEXT, person_id INTEGER REFERENCES face_clusters(id),
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS face_clusters (
    id INTEGER PRIMARY KEY, name TEXT, face_count INTEGER DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_path ON photos(path);
CREATE INDEX IF NOT EXISTS idx_photos_taken_at ON photos(taken_at);
CREATE INDEX IF NOT EXISTS idx_ai_classifications_photo ON ai_classifications(photo_id);
CREATE INDEX IF NOT EXISTS idx_ai_classifications_label ON ai_classifications(label);
CREATE INDEX IF NOT EXISTS idx_face_detections_photo ON face_detections(photo_id);
CREATE INDEX IF NOT EXISTS idx_face_detections_person ON face_detections(person_id);
"""

RAW_EXTENSIONS = {".arw", ".cr2", ".nef", ".dng", ".raw", ".orf", ".rw2", ".pef"}


def convert_raw_to_jpeg(path: str) -> str | None:
    ext = os.path.splitext(path)[1].lower()
    if ext not in RAW_EXTENSIONS:
        return None
    tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
    tmp.close()
    try:
        import rawpy
        with rawpy.imread(path) as raw:
            rgb = raw.postprocess()
        from PIL import Image
        Image.fromarray(rgb).save(tmp.name, "JPEG", quality=90)
        if os.path.exists(tmp.name):
            return tmp.name
    except Exception as e:
        print(f"  rawpy failed: {e}")
    if sys.platform == "darwin":
        try:
            r = subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "90", path, "-o", tmp.name],
                               capture_output=True, timeout=30)
            if r.returncode == 0 and os.path.exists(tmp.name):
                return tmp.name
        except Exception as e:
            print(f"  sips failed: {e}")
    os.unlink(tmp.name)
    return None


def get_exif_basic(path: str) -> dict:
    """Minimal EXIF extraction (no external deps needed)."""
    result = {"width": None, "height": None, "taken_at": None, "camera_make": None,
              "camera_model": None, "latitude": None, "longitude": None, "orientation": 1}
    try:
        from PIL import Image
        from PIL.ExifTags import TAGS, GPSTAGS
        img = Image.open(path)
        w, h = img.size
        result["width"] = w
        result["height"] = h
        result["format"] = img.format

        if hasattr(img, "_getexif") and img._getexif():
            exif = img._getexif()
            tag_map = {v: k for k, v in TAGS.items()}
            for tag_id, value in exif.items():
                tag = tag_map.get(tag_id, str(tag_id))
                if tag == "DateTimeOriginal" and not result["taken_at"]:
                    try:
                        dt = datetime.strptime(value, "%Y:%m:%d %H:%M:%S")
                        result["taken_at"] = int(dt.timestamp())
                    except:
                        pass
                elif tag == "Make" and not result["camera_make"]:
                    result["camera_make"] = value
                elif tag == "Model" and not result["camera_model"]:
                    result["camera_model"] = value

        # GPS
        gps_info = None
        for tag_id, value in exif.items():
            if tag_map.get(tag_id) == "GPSInfo":
                gps_info = value
                break
        if gps_info:
            gps_tag_map = {v: k for k, v in GPSTAGS.items()}
            lat = gps_info.get(1)
            lat_ref = gps_info.get(2, 'N')
            lon = gps_info.get(3)
            lon_ref = gps_info.get(4, 'E')
            if lat and len(lat) == 3:
                lat_deg = lat[0][0] / lat[0][1] if lat[0][1] else 0
                lat_min = lat[1][0] / lat[1][1] if lat[1][1] else 0
                lat_sec = lat[2][0] / lat[2][1] if lat[2][1] else 0
                lat_val = lat_deg + lat_min / 60 + lat_sec / 3600
                result["latitude"] = -lat_val if lat_ref == 'S' else lat_val
            if lon and len(lon) == 3:
                lon_deg = lon[0][0] / lon[0][1] if lon[0][1] else 0
                lon_min = lon[1][0] / lon[1][1] if lon[1][1] else 0
                lon_sec = lon[2][0] / lon[2][1] if lon[2][1] else 0
                lon_val = lon_deg + lon_min / 60 + lon_sec / 3600
                result["longitude"] = -lon_val if lon_ref == 'W' else lon_val
    except Exception as e:
        print(f"  EXIF read failed: {e}")
    return result


def init_db():
    os.makedirs(PF_DIR, exist_ok=True)
    os.makedirs(FACES_CACHE, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(CREATE_TABLES)
    return conn


def scan_files():
    """Walk media dir and collect image files, excluding .pf directory."""
    files = []
    for root, dirs, filenames in os.walk(MEDIA_DIR):
        # Skip .pf directory (generated cache)
        if ".pf" in dirs:
            dirs.remove(".pf")
        for fn in filenames:
            ext = os.path.splitext(fn)[1].lower()
            if ext in IMAGE_EXTENSIONS:
                full = os.path.join(root, fn)
                stat = os.stat(full)
                files.append({
                    "path": full,
                    "filename": fn,
                    "file_size": stat.st_size,
                    "file_mtime": int(stat.st_mtime),
                })
    return files


def import_photos(conn, files):
    now = int(time.time())
    count = 0
    for f in files:
        exif = get_exif_basic(f["path"])
        try:
            conn.execute("""
                INSERT OR IGNORE INTO photos (path, filename, file_size, file_mtime, width, height,
                    format, taken_at, camera_make, camera_model, latitude, longitude, orientation,
                    thumbnail_status, ai_status, deleted, is_favorite, imported_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?)
            """, (f["path"], f["filename"], f["file_size"], f["file_mtime"],
                  exif.get("width"), exif.get("height"), exif.get("format"),
                  exif.get("taken_at"), exif.get("camera_make"), exif.get("camera_model"),
                  exif.get("latitude"), exif.get("longitude"), exif.get("orientation", 1), now))
            if conn.total_changes > 0:
                count += 1
        except sqlite3.Error as e:
            print(f"  DB insert failed for {f['filename']}: {e}")
    conn.commit()
    return count


def run_scene_classification(conn, batch_size=10):
    import requests
    pending = conn.execute(
        "SELECT id, path FROM photos WHERE deleted = 0 AND ai_status = 0 LIMIT ?",
        (batch_size,)
    ).fetchall()
    if not pending:
        return 0

    paths = [r[1] for r in pending]
    print(f"  Classifying {len(paths)} photos...")

    # Convert RAW files
    process_paths = {}
    for p in paths:
        jpeg = convert_raw_to_jpeg(p)
        process_paths[p] = jpeg or p

    try:
        resp = requests.post(f"{AI_WORKER_URL}/classify", json={
            "paths": list(process_paths.values()),
            "model": "resnet50_places365"
        }, timeout=120)
        resp.raise_for_status()
        data = resp.json()

        for result in data.get("results", []):
            orig_path = result["path"]
            # Map back from temp jpeg to original
            original = next((k for k, v in process_paths.items() if v == orig_path), orig_path)
            photo = next((p for p in pending if p[1] == original), None)
            if photo:
                photo_id = photo[0]
                for tag in result.get("tags", []):
                    conn.execute(
                        "INSERT OR IGNORE INTO ai_classifications (photo_id, category, label, confidence) VALUES (?, ?, ?, ?)",
                        (photo_id, "scene", tag["label"], tag["confidence"])
                    )
                conn.execute("UPDATE photos SET ai_status = 1 WHERE id = ?", (photo_id,))
        conn.commit()
        return len([r for r in data.get("results", []) if r.get("tags")])
    finally:
        # Cleanup temp JPEGs
        for orig, temp in process_paths.items():
            if orig != temp and os.path.exists(temp):
                os.unlink(temp)


def run_face_detection(conn, batch_size=5):
    import requests
    pending = conn.execute(
        "SELECT id, path FROM photos WHERE deleted = 0 AND ai_status = 0 LIMIT ?",
        (batch_size,)
    ).fetchall()
    if not pending:
        return 0

    paths = [r[1] for r in pending]
    print(f"  Detecting faces in {len(paths)} photos...")

    # Convert RAW files
    process_paths = {}
    for p in paths:
        jpeg = convert_raw_to_jpeg(p)
        process_paths[p] = jpeg or p

    temp_dir = TEMP_EMBED_DIR
    os.makedirs(temp_dir, exist_ok=True)
    # Clear previous run
    for f in os.listdir(temp_dir):
        os.unlink(os.path.join(temp_dir, f))

    try:
        resp = requests.post(f"{AI_WORKER_URL}/detect_faces", json={
            "paths": list(process_paths.values()),
            "cache_dir": temp_dir
        }, timeout=120)
        resp.raise_for_status()
        data = resp.json()

        total_faces = 0
        now = int(time.time())

        for result_idx, result in enumerate(data.get("results", [])):
            orig_path = result["path"]
            original = next((k for k, v in process_paths.items() if v == orig_path), orig_path)
            photo = next((p for p in pending if p[1] == original), None)
            if photo:
                photo_id = photo[0]
                for face_idx, face in enumerate(result.get("faces", [])):
                    py_embedding_name = f"{result_idx}_{face_idx}.npy"
                    src = os.path.join(temp_dir, py_embedding_name)
                    embedding_path = f"{photo_id:08x}.npy"
                    cache_file = os.path.join(FACES_CACHE, embedding_path)

                    if os.path.exists(src):
                        os.rename(src, cache_file)

                    conn.execute(
                        "INSERT INTO face_detections (photo_id, bbox_x, bbox_y, bbox_w, bbox_h, embedding_path, person_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
                        (photo_id, face.get("bbox", [0,0,0,0])[0], face.get("bbox", [0,0,0,0])[1],
                         face.get("bbox", [0,0,0,0])[2], face.get("bbox", [0,0,0,0])[3],
                         embedding_path, now)
                    )
                    total_faces += 1
                conn.execute("UPDATE photos SET ai_status = 1 WHERE id = ?", (photo_id,))
        conn.commit()
        return total_faces
    finally:
        for orig, temp in process_paths.items():
            if orig != temp and os.path.exists(temp):
                os.unlink(temp)


def run_face_clustering(conn):
    """Run DBSCAN-style clustering on face embeddings."""
    import numpy as np

    # Get all unassigned faces with embeddings
    faces = conn.execute(
        "SELECT id, embedding_path FROM face_detections WHERE embedding_path IS NOT NULL AND person_id IS NULL"
    ).fetchall()

    if not faces:
        return "No unassigned faces to cluster"

    print(f"  Clustering {len(faces)} face embeddings...")

    # Load embeddings
    valid_faces = []
    vectors = []
    for face_id, emb_path in faces:
        full_path = os.path.join(FACES_CACHE, emb_path)
        if os.path.exists(full_path):
            try:
                vec = np.load(full_path)
                valid_faces.append((face_id, emb_path))
                vectors.append(vec)
            except Exception as e:
                print(f"  Failed to load {emb_path}: {e}")

    if len(valid_faces) < 2:
        return f"Only {len(valid_faces)} valid embedding(s), skipping DBSCAN"

    from sklearn.cluster import DBSCAN
    X = np.array(vectors)
    clustering = DBSCAN(eps=0.6, min_samples=2, metric="cosine").fit(X)
    labels = clustering.labels_

    # Group by label
    clusters = {}
    noise_count = 0
    for i, (face_id, _) in enumerate(valid_faces):
        label = int(labels[i])
        if label == -1:
            noise_count += 1
            continue
        clusters.setdefault(label, []).append(face_id)

    now = int(time.time())
    new_clusters = 0
    for cluster_label, face_ids in clusters.items():
        # Create new cluster
        cursor = conn.execute(
            "INSERT INTO face_clusters (name, face_count, created_at) VALUES (NULL, ?, ?)",
            (len(face_ids), now)
        )
        cluster_id = cursor.lastrowid
        conn.executemany(
            "UPDATE face_detections SET person_id = ? WHERE id = ?",
            [(cluster_id, fid) for fid in face_ids]
        )
        new_clusters += 1

    conn.commit()
    return f"Created {new_clusters} people clusters ({noise_count} noise faces)"


def print_summary(conn):
    total = conn.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
    classified = conn.execute("SELECT COUNT(DISTINCT photo_id) FROM ai_classifications").fetchone()[0]
    faces = conn.execute("SELECT COUNT(*) FROM face_detections").fetchone()[0]
    clusters = conn.execute("SELECT COUNT(*) FROM face_clusters").fetchone()[0]
    people = conn.execute("SELECT COUNT(DISTINCT person_id) FROM face_detections WHERE person_id IS NOT NULL").fetchone()[0]

    print("\n" + "=" * 60)
    print("RESULTS SUMMARY")
    print("=" * 60)
    print(f"  Total photos imported:  {total}")
    print(f"  Scene classified:       {classified}")
    print(f"  Faces detected:         {faces}")
    print(f"  Face clusters created:  {clusters}")
    print(f"  People identified:      {people}")
    print(f"  DB location:            {DB_PATH}")
    print("=" * 60)

    # Show sample classifications
    print("\nSample classifications:")
    rows = conn.execute("""
        SELECT p.filename, ac.label, ac.confidence
        FROM ai_classifications ac JOIN photos p ON ac.photo_id = p.id
        ORDER BY ac.confidence DESC LIMIT 10
    """).fetchall()
    for fn, label, conf in rows:
        print(f"  {fn:40s}  {label:30s}  {conf:.4f}")

    # Show face clusters
    if clusters > 0:
        print("\nFace clusters (people):")
        rows = conn.execute("""
            SELECT fc.id, fc.name, fc.face_count,
                   (SELECT p.filename FROM face_detections fd JOIN photos p ON fd.photo_id = p.id WHERE fd.person_id = fc.id LIMIT 1)
            FROM face_clusters fc ORDER BY fc.face_count DESC
        """).fetchall()
        for cid, name, count, sample_fn in rows:
            print(f"  Person #{cid}: {count} faces  (sample: {sample_fn})")


def main():
    print("=" * 60)
    print("PhotoFactory AI Pipeline Test")
    print(f"  Media dir:  {MEDIA_DIR}")
    print(f"  AI worker:  {AI_WORKER_URL}")
    print("=" * 60)

    # Check AI worker
    import requests
    try:
        r = requests.get(f"{AI_WORKER_URL}/health", timeout=5)
        if r.json().get("status") != "ok":
            print("AI worker not healthy. Starting it...")
            ai_dir = os.path.join(os.path.dirname(__file__))
            subprocess.Popen(["python3", "server.py"], cwd=ai_dir)
            time.sleep(5)
        else:
            print("AI worker: OK")
    except Exception as e:
        print(f"AI worker not running ({e}), starting...")
        ai_dir = os.path.join(os.path.dirname(__file__))
        subprocess.Popen(["python3", "server.py"], cwd=ai_dir)
        time.sleep(5)

    # Step 1: Init DB
    print("\n[1/5] Initializing database...")
    conn = init_db()
    print(f"  DB created at {DB_PATH}")

    # Step 2: Scan files
    print("\n[2/5] Scanning files...")
    files = scan_files()
    print(f"  Found {len(files)} image files")

    # Step 3: Import
    print("\n[3/5] Importing photos...")
    count = import_photos(conn, files)
    print(f"  Imported {count} new photos")
    total = conn.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
    print(f"  Total in DB: {total}")

    # Step 4: AI Processing
    print("\n[4/5] Running AI pipeline...")

    # Scene classification loop
    total_classified = 0
    while True:
        n = run_scene_classification(conn, batch_size=20)
        total_classified += n
        if n == 0:
            break
        print(f"    Classified {total_classified} photos so far...")

    # Face detection loop
    total_faces_photos = 0
    while True:
        n = run_face_detection(conn, batch_size=5)
        if n == 0:
            # Check if there are still pending photos (no faces found but ai_status not updated)
            pending = conn.execute("SELECT COUNT(*) FROM photos WHERE deleted = 0 AND ai_status = 0").fetchone()[0]
            if pending == 0:
                break
            # Update remaining photos with no faces
            conn.execute("UPDATE photos SET ai_status = 1 WHERE deleted = 0 AND ai_status = 0")
            conn.commit()
            break
        total_faces_photos += n
        print(f"    Detected {total_faces_photos} faces so far...")

    print(f"\n  AI processing done:")
    print(f"    Classified: {total_classified} photos")
    print(f"    Faces:      {total_faces_photos}")

    # Step 5: Face clustering
    print("\n[5/5] Running face clustering...")
    result = run_face_clustering(conn)
    print(f"  {result}")

    # Summary
    print_summary(conn)
    conn.close()


if __name__ == "__main__":
    main()
