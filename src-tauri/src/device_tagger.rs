// src-tauri/src/device_tagger.rs
//
// Device tagging module.
// Generates device tags from EXIF camera_make and camera_model data.

use rusqlite::Connection;

use crate::db::classification_dao::insert_classification_with_type;
use crate::error::{AppError, AppResult};
use crate::models::AiClassification;

/// Run device tagging on photos that have camera_make but no device tag.
///
/// Queries photos with camera_make IS NOT NULL and tag_type != 'device',
/// combines make + model into a label (e.g., "Apple iPhone 15"),
/// and inserts into ai_classifications.
///
/// Returns the number of photos successfully tagged.
pub fn run_device_tagging(conn: &Connection, batch_size: usize) -> AppResult<usize> {
    let query = "
        SELECT id, camera_make, COALESCE(camera_model, '') FROM photos
        WHERE camera_make IS NOT NULL
          AND deleted = 0
          AND id NOT IN (
            SELECT photo_id FROM ai_classifications WHERE tag_type = 'device'
          )
        LIMIT ?
    ";

    let mut stmt = conn
        .prepare(query)
        .map_err(|e| AppError::Internal(format!("Failed to prepare photo query: {}", e)))?;

    let rows: Vec<(i64, String, String)> = stmt
        .query_map([batch_size as i64], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| AppError::Internal(format!("Failed to query photos: {}", e)))?
        .filter_map(|r| r.ok())
        .collect();

    let mut tagged = 0;

    for (photo_id, make, model) in rows {
        let label = if model.is_empty() {
            make
        } else {
            format!("{} {}", make, model)
        };

        let classification = AiClassification {
            id: None,
            photo_id,
            category: "device".into(),
            label,
            confidence: 1.0,
        };
        if insert_classification_with_type(conn, &classification, "device").is_ok() {
            tagged += 1;
        }
    }

    Ok(tagged)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn new_in_memory_db_with_device_data() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE photos (
                id INTEGER PRIMARY KEY, path TEXT, filename TEXT, file_size INTEGER,
                file_mtime INTEGER, width INTEGER, height INTEGER, format TEXT,
                taken_at INTEGER, camera_make TEXT, camera_model TEXT, latitude REAL,
                longitude REAL, orientation INTEGER DEFAULT 1, thumbnail_status INTEGER DEFAULT 0,
                ai_status INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, is_favorite INTEGER DEFAULT 0,
                exposure_time TEXT, f_number TEXT, iso INTEGER, imported_at INTEGER
            );
            CREATE TABLE ai_classifications (
                id INTEGER PRIMARY KEY, photo_id INTEGER, category TEXT, label TEXT,
                confidence REAL, parent_id INTEGER, label_type TEXT DEFAULT 'ai_scene',
                tag_type TEXT DEFAULT 'ai_scene', UNIQUE(photo_id, label)
            );"
        ).unwrap();
        conn
    }

    #[test]
    fn test_run_device_tagging_query_selects_correct_photos() {
        let conn = new_in_memory_db_with_device_data();

        // Photo 1: has camera_make and model, no tag
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, camera_make, camera_model, imported_at)
             VALUES (1, '/p1.jpg', 'p1.jpg', 1000, 0, 'Apple', 'iPhone 15', 0)",
            [],
        ).unwrap();

        // Photo 2: has camera_make only (no model), no tag
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, camera_make, camera_model, imported_at)
             VALUES (2, '/p2.jpg', 'p2.jpg', 1000, 0, 'Canon', NULL, 0)",
            [],
        ).unwrap();

        // Photo 3: already has device tag
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, camera_make, camera_model, imported_at)
             VALUES (3, '/p3.jpg', 'p3.jpg', 1000, 0, 'Sony', 'A7IV', 0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO ai_classifications (photo_id, category, label, confidence, tag_type)
             VALUES (3, 'device', 'Sony A7IV', 1.0, 'device')",
            [],
        )
        .unwrap();

        // Photo 4: no camera_make
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, camera_make, camera_model, imported_at)
             VALUES (4, '/p4.jpg', 'p4.jpg', 1000, 0, NULL, NULL, 0)",
            [],
        ).unwrap();

        // Photo 5: deleted
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, camera_make, camera_model, deleted, imported_at)
             VALUES (5, '/p5.jpg', 'p5.jpg', 1000, 0, 'Nikon', 'Z6', 1, 0)",
            [],
        ).unwrap();

        // Verify query logic
        let query = "
            SELECT id, camera_make, COALESCE(camera_model, '') FROM photos
            WHERE camera_make IS NOT NULL
              AND deleted = 0
              AND id NOT IN (
                SELECT photo_id FROM ai_classifications WHERE tag_type = 'device'
              )
            LIMIT 100
        ";
        let mut stmt = conn.prepare(query).unwrap();
        let rows: Vec<(i64, String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        // Should return photos 1 and 2, but not 3 (tagged), 4 (no make), or 5 (deleted)
        assert_eq!(rows.len(), 2);
        let ids: Vec<i64> = rows.iter().map(|(id, _, _)| *id).collect();
        assert!(ids.contains(&1));
        assert!(ids.contains(&2));
        assert!(!ids.contains(&3));
        assert!(!ids.contains(&4));
        assert!(!ids.contains(&5));
    }

    #[test]
    fn test_run_device_tagging_full_flow() {
        let conn = new_in_memory_db_with_device_data();

        // Insert photos with different device info
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, camera_make, camera_model, imported_at)
             VALUES (1, '/p1.jpg', 'p1.jpg', 1000, 0, 'Apple', 'iPhone 15', 0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, camera_make, camera_model, imported_at)
             VALUES (2, '/p2.jpg', 'p2.jpg', 1000, 0, 'Canon', NULL, 0)",
            [],
        ).unwrap();

        let tagged = run_device_tagging(&conn, 100).unwrap();
        assert_eq!(tagged, 2);

        // Verify photo 1: make + model
        let label1: String = conn
            .query_row(
                "SELECT label FROM ai_classifications WHERE photo_id = 1 AND tag_type = 'device'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(label1, "Apple iPhone 15");

        // Verify photo 2: make only (no model)
        let label2: String = conn
            .query_row(
                "SELECT label FROM ai_classifications WHERE photo_id = 2 AND tag_type = 'device'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(label2, "Canon");
    }

    #[test]
    fn test_run_device_tagging_idempotent() {
        let conn = new_in_memory_db_with_device_data();

        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, camera_make, camera_model, imported_at)
             VALUES (1, '/p1.jpg', 'p1.jpg', 1000, 0, 'Apple', 'iPhone 15', 0)",
            [],
        ).unwrap();

        // Run twice - second run should tag 0 photos
        let first = run_device_tagging(&conn, 100).unwrap();
        assert_eq!(first, 1);

        let second = run_device_tagging(&conn, 100).unwrap();
        assert_eq!(second, 0);
    }
}
