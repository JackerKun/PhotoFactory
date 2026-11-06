#!/usr/bin/env python3
"""Safely rebuild automatic face groups in an existing PhotoFactory project."""

import argparse
import shutil
import sqlite3
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("project_root", type=Path)
    parser.add_argument("--threshold", type=float, default=0.60)
    args = parser.parse_args()

    repository_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(repository_root / "ai_worker"))
    from face_clusterer import cluster_faces_v2

    pf_dir = args.project_root / ".pf"
    database = pf_dir / "photos.db"
    embeddings_dir = pf_dir / "ai_cache" / "faces"
    if not database.exists() or not embeddings_dir.exists():
        raise SystemExit("The selected directory is not a complete PhotoFactory project")

    connection = sqlite3.connect(database, timeout=30)
    connection.execute("PRAGMA busy_timeout = 30000")
    named_rows = connection.execute(
        "SELECT fd.embedding_path, fc.id "
        "FROM face_detections fd "
        "JOIN face_clusters fc ON fc.id = fd.person_id "
        "LEFT JOIN person_metadata pm ON pm.person_id = fc.id "
        "WHERE TRIM(COALESCE(fc.name, pm.user_name, '')) != '' "
        "AND fd.embedding_path IS NOT NULL"
    ).fetchall()
    existing = {path: int(cluster_id) for path, cluster_id in named_rows}
    reserved_ids = {
        int(row[0])
        for row in connection.execute(
            "SELECT fc.id FROM face_clusters fc "
            "LEFT JOIN person_metadata pm ON pm.person_id = fc.id "
            "WHERE TRIM(COALESCE(fc.name, pm.user_name, '')) != ''"
        )
    }

    assignments = cluster_faces_v2(
        str(embeddings_dir),
        existing_clusters=existing,
        threshold=args.threshold,
    )

    # When a named person currently has no face, its reserved id is invisible to
    # the clusterer. Move generated ids above every reserved id to avoid reuse.
    generated_ids = sorted(set(assignments.values()) - set(existing.values()))
    next_id = max(reserved_ids, default=-1) + 1
    remap = {cluster_id: next_id + index for index, cluster_id in enumerate(generated_ids)}
    existing_ids = set(existing.values())
    assignments = {
        filename: (cluster_id if cluster_id in existing_ids else remap[cluster_id])
        for filename, cluster_id in assignments.items()
    }

    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.execute(
            "UPDATE face_detections SET person_id = NULL WHERE person_id IN ("
            "SELECT fc.id FROM face_clusters fc "
            "LEFT JOIN person_metadata pm ON pm.person_id = fc.id "
            "WHERE TRIM(COALESCE(fc.name, pm.user_name, '')) = '')"
        )
        connection.execute(
            "DELETE FROM person_metadata WHERE person_id IN ("
            "SELECT id FROM face_clusters WHERE TRIM(COALESCE(name, '')) = '')"
        )
        connection.execute("DELETE FROM face_clusters WHERE TRIM(COALESCE(name, '')) = ''")
        now = int(__import__("time").time())
        connection.executemany(
            "INSERT OR IGNORE INTO face_clusters (id, face_count, created_at) VALUES (?, 0, ?)",
            [(cluster_id, now) for cluster_id in sorted(set(assignments.values()))],
        )
        connection.executemany(
            "UPDATE face_detections SET person_id = ? WHERE embedding_path = ?",
            [(cluster_id, filename) for filename, cluster_id in assignments.items()],
        )
        connection.execute(
            "UPDATE face_clusters SET face_count = ("
            "SELECT COUNT(*) FROM face_detections WHERE person_id = face_clusters.id)"
        )
        connection.commit()
    except Exception:
        connection.rollback()
        raise

    people = connection.execute("SELECT COUNT(*) FROM face_clusters WHERE face_count > 0").fetchone()[0]
    assigned = connection.execute("SELECT COUNT(*) FROM face_detections WHERE person_id IS NOT NULL").fetchone()[0]
    largest = connection.execute("SELECT COALESCE(MAX(face_count), 0) FROM face_clusters").fetchone()[0]
    connection.close()
    shutil.rmtree(pf_dir / "ai_cache" / "face_thumbnails", ignore_errors=True)
    print(f"Rebuilt {assigned} faces into {people} people; largest group: {largest}")


if __name__ == "__main__":
    main()
