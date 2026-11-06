// src-tauri/src/db/diagnostics.rs
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::error::AppResult;

/// Result of a database integrity check.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntegrityCheckResult {
    pub ok: bool,
    pub errors: Vec<String>,
    pub photo_count: i64,
    pub classification_count: i64,
    pub face_detection_count: i64,
    pub face_cluster_count: i64,
    pub custom_attr_count: i64,
    pub orphaned_classifications: i64,
    pub orphaned_face_detections: i64,
    pub orphaned_custom_attrs: i64,
    pub database_size_bytes: u64,
}

/// Result of an index rebuild operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexRebuildResult {
    pub indexes_rebuilt: usize,
    pub details: Vec<String>,
}

/// Overall diagnostics report.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticsReport {
    pub integrity: IntegrityCheckResult,
    pub index_info: Vec<IndexInfo>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexInfo {
    pub name: String,
    pub table: String,
}

/// Run a full database integrity check.
pub fn check_integrity(db_path: &Path) -> AppResult<IntegrityCheckResult> {
    let conn = Connection::open(db_path)?;

    // Run SQLite's built-in integrity check
    let mut errors = Vec::new();
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if integrity != "ok" {
        errors.push(format!("integrity_check: {}", integrity));
    }

    // Check foreign key integrity
    let fk_check: Vec<String> = conn
        .prepare("PRAGMA foreign_key_check")?
        .query_map([], |row| {
            let table: String = row.get(1)?;
            let rowid: i64 = row.get(3)?;
            Ok(format!("FK violation in {} row {}", table, rowid))
        })?
        .filter_map(|r| r.ok())
        .collect();
    errors.extend(fk_check);

    // Count records in each table
    let photo_count: i64 = conn.query_row("SELECT COUNT(*) FROM photos", [], |r| r.get(0))?;
    let classification_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM ai_classifications", [], |r| r.get(0))?;
    let face_detection_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM face_detections", [], |r| r.get(0))?;
    let face_cluster_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM face_clusters", [], |r| r.get(0))?;
    let custom_attr_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM custom_attributes", [], |r| r.get(0))?;

    // Find orphaned classifications (referencing deleted/missing photos)
    let orphaned_classifications: i64 = conn.query_row(
        "SELECT COUNT(*) FROM ai_classifications c \
         LEFT JOIN photos p ON c.photo_id = p.id \
         WHERE p.id IS NULL OR p.deleted = 1",
        [],
        |r| r.get(0),
    )?;

    // Find orphaned face detections
    let orphaned_face_detections: i64 = conn.query_row(
        "SELECT COUNT(*) FROM face_detections f \
         LEFT JOIN photos p ON f.photo_id = p.id \
         WHERE p.id IS NULL OR p.deleted = 1",
        [],
        |r| r.get(0),
    )?;

    // Find orphaned custom attributes
    let orphaned_custom_attrs: i64 = conn.query_row(
        "SELECT COUNT(*) FROM custom_attributes c \
         LEFT JOIN photos p ON c.photo_id = p.id \
         WHERE p.id IS NULL OR p.deleted = 1",
        [],
        |r| r.get(0),
    )?;

    // Get database file size
    let database_size_bytes = db_path.metadata().map(|m| m.len()).unwrap_or(0);

    let ok = errors.is_empty()
        && orphaned_classifications == 0
        && orphaned_face_detections == 0
        && orphaned_custom_attrs == 0;

    Ok(IntegrityCheckResult {
        ok,
        errors,
        photo_count,
        classification_count,
        face_detection_count,
        face_cluster_count,
        custom_attr_count,
        orphaned_classifications,
        orphaned_face_detections,
        orphaned_custom_attrs,
        database_size_bytes,
    })
}

/// Rebuild all database indexes.
pub fn rebuild_indexes(db_path: &Path) -> AppResult<IndexRebuildResult> {
    let conn = Connection::open(db_path)?;

    let index_defs = vec![
        "CREATE INDEX IF NOT EXISTS idx_photos_path ON photos(path)",
        "CREATE INDEX IF NOT EXISTS idx_photos_taken_at ON photos(taken_at)",
        "CREATE INDEX IF NOT EXISTS idx_photos_gps ON photos(latitude, longitude) WHERE latitude IS NOT NULL AND deleted = 0",
        "CREATE INDEX IF NOT EXISTS idx_ai_classifications_photo ON ai_classifications(photo_id)",
        "CREATE INDEX IF NOT EXISTS idx_ai_classifications_label ON ai_classifications(label)",
        "CREATE INDEX IF NOT EXISTS idx_face_detections_photo ON face_detections(photo_id)",
        "CREATE INDEX IF NOT EXISTS idx_face_detections_person ON face_detections(person_id)",
        "CREATE INDEX IF NOT EXISTS idx_face_detections_person_photo ON face_detections(person_id, photo_id)",
        "CREATE INDEX IF NOT EXISTS idx_face_clusters_count ON face_clusters(face_count DESC, id)",
        "CREATE INDEX IF NOT EXISTS idx_custom_attrs_photo ON custom_attributes(photo_id)",
        "CREATE INDEX IF NOT EXISTS idx_constraints_pair ON face_constraints(photo_id_1, face_index_1, photo_id_2, face_index_2)",
        "CREATE INDEX IF NOT EXISTS idx_photo_manual_tags_tag ON photo_manual_tags(tag_id, photo_id)",
    ];

    let mut details = Vec::new();
    let mut rebuilt = 0;

    // Drop and recreate each index
    let index_names = vec![
        "idx_photos_path",
        "idx_photos_taken_at",
        "idx_photos_gps",
        "idx_ai_classifications_photo",
        "idx_ai_classifications_label",
        "idx_face_detections_photo",
        "idx_face_detections_person",
        "idx_face_detections_person_photo",
        "idx_face_clusters_count",
        "idx_custom_attrs_photo",
        "idx_constraints_pair",
        "idx_photo_manual_tags_tag",
    ];

    for (name, def) in index_names.iter().zip(index_defs.iter()) {
        let drop_sql = format!("DROP INDEX IF EXISTS {}", name);
        conn.execute(&drop_sql, [])?;
        conn.execute(def, [])?;
        rebuilt += 1;
        details.push(format!("Rebuilt index: {}", name));
    }

    // Run VACUUM to reclaim space and optimize
    conn.execute_batch("VACUUM; REINDEX;")?;
    details.push("VACUUM and REINDEX completed".to_string());

    Ok(IndexRebuildResult {
        indexes_rebuilt: rebuilt,
        details,
    })
}

/// Clean up orphaned records (classifications, face detections, custom attrs
/// that reference deleted or missing photos).
pub fn cleanup_orphans(db_path: &Path) -> AppResult<(usize, usize, usize)> {
    let conn = Connection::open(db_path)?;

    let orphans_classifications = conn.execute(
        "DELETE FROM ai_classifications WHERE photo_id IN (\
            SELECT c.photo_id FROM ai_classifications c \
            LEFT JOIN photos p ON c.photo_id = p.id \
            WHERE p.id IS NULL OR p.deleted = 1)",
        [],
    )?;

    let orphans_face_detections = conn.execute(
        "DELETE FROM face_detections WHERE photo_id IN (\
            SELECT f.photo_id FROM face_detections f \
            LEFT JOIN photos p ON f.photo_id = p.id \
            WHERE p.id IS NULL OR p.deleted = 1)",
        [],
    )?;

    let orphans_custom_attrs = conn.execute(
        "DELETE FROM custom_attributes WHERE photo_id IN (\
            SELECT c.photo_id FROM custom_attributes c \
            LEFT JOIN photos p ON c.photo_id = p.id \
            WHERE p.id IS NULL OR p.deleted = 1)",
        [],
    )?;

    Ok((
        orphans_classifications,
        orphans_face_detections,
        orphans_custom_attrs,
    ))
}

/// Get a list of existing indexes.
pub fn list_indexes(db_path: &Path) -> AppResult<Vec<IndexInfo>> {
    let conn = Connection::open(db_path)?;

    let mut stmt = conn.prepare(
        "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
    )?;

    let indexes: Vec<IndexInfo> = stmt
        .query_map([], |row| {
            Ok(IndexInfo {
                name: row.get(0)?,
                table: row.get(1)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(indexes)
}

/// Run full diagnostics: integrity check + index info + warnings.
pub fn run_diagnostics(db_path: &Path) -> AppResult<DiagnosticsReport> {
    let integrity = check_integrity(db_path)?;
    let index_info = list_indexes(db_path)?;

    let mut warnings = Vec::new();

    // Warn about high orphan count
    if integrity.orphaned_classifications > 0 {
        warnings.push(format!(
            "{} orphaned AI classifications found (run cleanup to remove)",
            integrity.orphaned_classifications
        ));
    }
    if integrity.orphaned_face_detections > 0 {
        warnings.push(format!(
            "{} orphaned face detections found (run cleanup to remove)",
            integrity.orphaned_face_detections
        ));
    }
    if integrity.orphaned_custom_attrs > 0 {
        warnings.push(format!(
            "{} orphaned custom attributes found (run cleanup to remove)",
            integrity.orphaned_custom_attrs
        ));
    }

    // Warn about large database size (>500MB)
    if integrity.database_size_bytes > 500 * 1024 * 1024 {
        let size_mb = integrity.database_size_bytes / (1024 * 1024);
        warnings.push(format!(
            "Database size is {}MB, consider running index rebuild to optimize",
            size_mb
        ));
    }

    // Warn about photos stuck in pending status
    let conn = Connection::open(db_path)?;
    let pending_thumbnails: i64 = conn.query_row(
        "SELECT COUNT(*) FROM photos WHERE thumbnail_status = 0 AND deleted = 0",
        [],
        |r| r.get(0),
    )?;
    let pending_ai: i64 = conn.query_row(
        "SELECT COUNT(*) FROM photos WHERE (face_status = 0 OR classification_status = 0) AND deleted = 0",
        [],
        |r| r.get(0),
    )?;

    if pending_thumbnails > 1000 {
        warnings.push(format!(
            "{} photos pending thumbnail generation",
            pending_thumbnails
        ));
    }
    if pending_ai > 1000 {
        warnings.push(format!("{} photos pending AI processing", pending_ai));
    }

    Ok(DiagnosticsReport {
        integrity,
        index_info,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection::init_db;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn test_db() -> (std::path::PathBuf, Connection) {
        let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("pf_diag_test_{}", id));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("test.db");
        let conn = init_db(&db_path).unwrap();
        (db_path, conn)
    }

    #[test]
    fn test_check_integrity_clean_db() {
        let (db_path, _conn) = test_db();
        let result = check_integrity(&db_path).unwrap();
        assert!(result.ok, "Clean database should pass integrity check");
        assert!(result.errors.is_empty());
        assert_eq!(result.orphaned_classifications, 0);
        assert_eq!(result.orphaned_face_detections, 0);
        assert_eq!(result.orphaned_custom_attrs, 0);
        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    #[test]
    fn test_rebuild_indexes() {
        let (db_path, _conn) = test_db();
        let result = rebuild_indexes(&db_path).unwrap();
        assert_eq!(result.indexes_rebuilt, 12);
        assert!(result.details.iter().any(|d| d.contains("idx_photos_path")));
        assert!(result.details.iter().any(|d| d.contains("VACUUM")));
        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    #[test]
    fn test_cleanup_orphans() {
        let (db_path, conn) = test_db();

        // Insert a photo, then mark it deleted
        conn.execute(
            "INSERT INTO photos (path, filename, file_size, file_mtime, imported_at) VALUES (?, ?, ?, ?, ?)",
            rusqlite::params!["/test/photo.jpg", "photo.jpg", 1000, 12345, 12345],
        ).unwrap();
        let photo_id = conn.last_insert_rowid();

        // Add a classification referencing it
        conn.execute(
            "INSERT INTO ai_classifications (photo_id, category, label, confidence) VALUES (?, ?, ?, ?)",
            rusqlite::params![photo_id, "scene", "mountain", 0.9],
        ).unwrap();

        // Mark the photo as deleted
        conn.execute(
            "UPDATE photos SET deleted = 1 WHERE id = ?",
            rusqlite::params![photo_id],
        )
        .unwrap();

        let (classifications, faces, attrs) = cleanup_orphans(&db_path).unwrap();
        assert_eq!(classifications, 1);
        assert_eq!(faces, 0);
        assert_eq!(attrs, 0);

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    #[test]
    fn test_list_indexes() {
        let (db_path, _conn) = test_db();
        let indexes = list_indexes(&db_path).unwrap();
        // Includes explicit application indexes plus migration-added indexes.
        assert_eq!(indexes.len(), 28);
        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    #[test]
    fn test_run_diagnostics() {
        let (db_path, _conn) = test_db();
        let report = run_diagnostics(&db_path).unwrap();
        assert!(report.integrity.ok);
        assert_eq!(report.integrity.photo_count, 0);
        assert_eq!(report.index_info.len(), 28);
        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }
}
