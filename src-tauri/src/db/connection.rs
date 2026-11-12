// src-tauri/src/db/connection.rs
use rusqlite::{Connection, OpenFlags};
use std::path::Path;

use crate::db::schema::{
    CREATE_TABLES, FACE_CONSTRAINTS_TABLE, PERSON_METADATA_TABLE, SMART_ALBUMS_TABLE,
    SMART_ALBUM_PHOTOS_TABLE,
};
use crate::error::AppResult;

/// Browse a library whose schema has already been initialized on open.
pub fn open_read_db(db_path: &Path) -> AppResult<Connection> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(conn)
}

pub fn init_db(db_path: &Path) -> AppResult<Connection> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "busy_timeout", "5000")?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "cache_size", "-50000")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.execute_batch(CREATE_TABLES)?;
    crate::db::task_error_dao::import_legacy_errors(&conn)?;
    // Migration: add is_favorite column to existing databases
    conn.execute(
        "ALTER TABLE photos ADD COLUMN is_favorite INTEGER DEFAULT 0",
        [],
    )
    .ok();
    conn.execute(
        "ALTER TABLE photos ADD COLUMN rating INTEGER NOT NULL DEFAULT 0 CHECK(rating BETWEEN 0 AND 5)",
        [],
    ).ok();
    // Face detection and scene classification progress must be tracked independently.
    // The legacy ai_status field could cause the second stage to be skipped entirely.
    let added_face_status = conn
        .execute(
            "ALTER TABLE photos ADD COLUMN face_status INTEGER DEFAULT 0",
            [],
        )
        .is_ok();
    let added_classification_status = conn
        .execute(
            "ALTER TABLE photos ADD COLUMN classification_status INTEGER DEFAULT 0",
            [],
        )
        .is_ok();
    if added_face_status {
        // ai_status historically mostly represented face detection. Preserve that work,
        // including photos where no face was found and therefore no face row exists.
        conn.execute(
            "UPDATE photos SET face_status = ai_status WHERE ai_status != 0",
            [],
        )
        .ok();
    }
    if added_classification_status {
        // Only mark classification complete when there is evidence it actually ran.
        conn.execute(
            "UPDATE photos SET classification_status = 1
             WHERE EXISTS (SELECT 1 FROM ai_classifications c WHERE c.photo_id = photos.id)",
            [],
        )
        .ok();
    }
    // Migration: add EXIF capture columns to existing databases
    conn.execute_batch(
        "ALTER TABLE photos ADD COLUMN exposure_time TEXT;
         ALTER TABLE photos ADD COLUMN f_number TEXT;
         ALTER TABLE photos ADD COLUMN iso INTEGER;",
    )
    .ok();
    conn.execute(
        "ALTER TABLE photos ADD COLUMN storage_source_id INTEGER REFERENCES storage_sources(id)",
        [],
    )
    .ok();
    conn.execute(
        "ALTER TABLE ai_pipeline_state ADD COLUMN stage_base_processed INTEGER NOT NULL DEFAULT 0",
        [],
    )
    .ok();
    // Older projects were scanned before the format column was populated.
    // Backfill it from the real file extension so the new EXIF format facet is
    // immediately useful without forcing the user to re-import the library.
    let missing_formats: Vec<(i64, String)> = {
        let mut stmt =
            conn.prepare("SELECT id, path FROM photos WHERE format IS NULL OR TRIM(format) = ''")?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .filter_map(|row| row.ok())
            .collect();
        rows
    };
    for (id, path) in missing_formats {
        if let Some(format) = Path::new(&path).extension().and_then(|ext| ext.to_str()) {
            conn.execute(
                "UPDATE photos SET format = ?1 WHERE id = ?2",
                rusqlite::params![format.to_lowercase(), id],
            )?;
        }
    }
    // Migration: add quality_score and person_name to face_detections
    conn.execute_batch(
        "ALTER TABLE face_detections ADD COLUMN quality_score REAL DEFAULT 0.0;
         ALTER TABLE face_detections ADD COLUMN person_name TEXT;",
    )
    .ok();
    for migration in [
        "ALTER TABLE face_detections ADD COLUMN detection_confidence REAL DEFAULT 0.0",
        "ALTER TABLE face_detections ADD COLUMN landmarks_json TEXT",
        "ALTER TABLE face_detections ADD COLUMN pose_yaw REAL DEFAULT 0.0",
        "ALTER TABLE face_detections ADD COLUMN pose_pitch REAL DEFAULT 0.0",
        "ALTER TABLE face_detections ADD COLUMN pose_roll REAL DEFAULT 0.0",
        "ALTER TABLE face_detections ADD COLUMN alignment_success INTEGER DEFAULT 0",
        "ALTER TABLE face_detections ADD COLUMN review_status TEXT NOT NULL DEFAULT 'active'",
    ] {
        conn.execute(migration, []).ok();
    }
    // Migration: add parent_id, label_type, and tag_type to ai_classifications
    conn.execute_batch(
        "ALTER TABLE ai_classifications ADD COLUMN parent_id INTEGER REFERENCES ai_classifications(id);
         ALTER TABLE ai_classifications ADD COLUMN label_type TEXT DEFAULT 'ai_scene';
         ALTER TABLE ai_classifications ADD COLUMN tag_type TEXT DEFAULT 'ai_scene';",
    ).ok();
    // AI-generated labels and user-created labels share the same editable catalog.
    // This marker lets us import historical/new AI results exactly once, so a tag
    // deliberately deleted by the user is not recreated on every page load.
    conn.execute(
        "ALTER TABLE ai_classifications ADD COLUMN manual_tag_synced INTEGER DEFAULT 0",
        [],
    )
    .ok();
    // Create new tables
    conn.execute_batch(FACE_CONSTRAINTS_TABLE)?;
    conn.execute_batch(PERSON_METADATA_TABLE)?;
    conn.execute_batch(SMART_ALBUMS_TABLE)?;
    conn.execute_batch(SMART_ALBUM_PHOTOS_TABLE)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS face_merge_operations (
            id INTEGER PRIMARY KEY,
            threshold REAL NOT NULL,
            merged_group_count INTEGER NOT NULL DEFAULT 0,
            removed_cluster_count INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'applied',
            created_at INTEGER NOT NULL,
            undone_at INTEGER
         );
         CREATE TABLE IF NOT EXISTS face_merge_history (
            operation_id INTEGER NOT NULL REFERENCES face_merge_operations(id),
            face_id INTEGER NOT NULL,
            original_person_id INTEGER NOT NULL,
            merged_person_id INTEGER NOT NULL,
            PRIMARY KEY (operation_id, face_id)
         );
         CREATE TABLE IF NOT EXISTS ai_model_state (
            component TEXT PRIMARY KEY,
            version TEXT NOT NULL,
            updated_at INTEGER NOT NULL
         );",
    )?;
    // Create new indexes
    conn.execute_batch("
        CREATE INDEX IF NOT EXISTS idx_constraints_pair ON face_constraints(photo_id_1, face_index_1, photo_id_2, face_index_2);
        CREATE INDEX IF NOT EXISTS idx_classifications_label_type ON ai_classifications(tag_type, label);
        CREATE INDEX IF NOT EXISTS idx_classifications_photo_type ON ai_classifications(photo_id, tag_type);
        CREATE INDEX IF NOT EXISTS idx_photos_face_pending ON photos(face_status, deleted);
        CREATE INDEX IF NOT EXISTS idx_photos_classification_pending ON photos(classification_status, deleted);
        CREATE INDEX IF NOT EXISTS idx_photos_rating ON photos(rating, deleted);
        CREATE INDEX IF NOT EXISTS idx_face_detections_review ON face_detections(review_status, quality_score);
        CREATE INDEX IF NOT EXISTS idx_face_clusters_count ON face_clusters(face_count DESC, id);
        CREATE INDEX IF NOT EXISTS idx_face_merge_history_operation ON face_merge_history(operation_id);
        CREATE INDEX IF NOT EXISTS idx_photo_intelligence_duplicate ON photo_intelligence(duplicate_group);
        CREATE INDEX IF NOT EXISTS idx_photo_intelligence_stack ON photo_intelligence(stack_key);
        CREATE INDEX IF NOT EXISTS idx_library_jobs_status ON library_jobs(status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_photos_storage_source ON photos(storage_source_id, deleted);
        CREATE INDEX IF NOT EXISTS idx_face_detections_ignored_page ON face_detections(review_status, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_photo_trash_page ON photo_trash(trashed_at DESC, photo_id DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_photo_tasks_queue ON ai_photo_tasks(stage, status, lease_until, photo_id);
        CREATE INDEX IF NOT EXISTS idx_ai_photo_tasks_updated ON ai_photo_tasks(updated_at DESC);
    ")?;
    conn.execute_batch(
        "\n        INSERT OR IGNORE INTO model_plugins(id,name,capability,version,status) VALUES
          ('builtin-face','内置人物识别','face','1.0','available'),
          ('builtin-scene','内置场景分类','scene','1.0','available'),
          ('builtin-semantic','本地语义标签','semantic','1.0','available'),
          ('system-tesseract','系统 OCR','ocr','1.0','auto'),
          ('builtin-dhash','相似照片指纹','similarity','1.0','available');
        INSERT OR IGNORE INTO library_settings(key,value) VALUES
          ('folder_monitor_enabled','false'),
          ('folder_monitor_interval','60'),
          ('privacy_mode','true');
    ",
    )?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn browsing_reads_committed_data_while_a_writer_is_active() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.db");
        let mut writer = init_db(&path).unwrap();
        let tx = writer.transaction().unwrap();
        tx.execute(
            "INSERT INTO photos(path,filename,file_size,file_mtime,imported_at) VALUES('/new.jpg','new.jpg',1,1,1)",
            [],
        ).unwrap();
        let reader = open_read_db(&path).unwrap();
        let photo_count = || {
            reader
                .query_row("SELECT COUNT(*) FROM photos", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap()
        };
        assert_eq!(photo_count(), 0);
        tx.commit().unwrap();
        assert_eq!(photo_count(), 1);
    }

    #[test]
    fn test_init_db_creates_tables() {
        let dir = std::env::temp_dir().join("pf_test_db");
        let _ = fs::remove_dir_all(&dir);
        let db_path = dir.join("test.db");
        let conn = init_db(&db_path).unwrap();
        // Verify tables exist
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(names.contains(&"photos".to_string()));
        assert!(names.contains(&"ai_classifications".to_string()));
        assert!(names.contains(&"face_detections".to_string()));
        assert!(names.contains(&"face_clusters".to_string()));
        assert!(names.contains(&"custom_attributes".to_string()));
        assert!(names.contains(&"sync_log".to_string()));
        assert!(names.contains(&"face_constraints".to_string()));
        assert!(names.contains(&"person_metadata".to_string()));
        assert!(names.contains(&"smart_albums".to_string()));
        assert!(names.contains(&"smart_album_photos".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }
}
