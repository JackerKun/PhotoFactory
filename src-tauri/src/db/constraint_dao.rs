use crate::error::AppResult;
use rusqlite::{params, Connection};

/// Represents a face constraint (must-link or cannot-link).
#[derive(Debug, Clone, serde::Serialize)]
pub struct FaceConstraint {
    pub id: i64,
    pub photo_id_1: i64,
    pub face_index_1: i32,
    pub photo_id_2: i64,
    pub face_index_2: i32,
    pub constraint_type: String,
    pub created_at: String,
}

/// Add a new face constraint.
pub fn add_constraint(
    conn: &Connection,
    photo_id_1: i64,
    face_index_1: i32,
    photo_id_2: i64,
    face_index_2: i32,
    constraint_type: &str,
) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO face_constraints (photo_id_1, face_index_1, photo_id_2, face_index_2, constraint_type)
         SELECT ?1, ?2, ?3, ?4, ?5
         WHERE NOT EXISTS (
             SELECT 1 FROM face_constraints
             WHERE constraint_type = ?5 AND (
                 (photo_id_1 = ?1 AND face_index_1 = ?2 AND photo_id_2 = ?3 AND face_index_2 = ?4)
                 OR (photo_id_1 = ?3 AND face_index_1 = ?4 AND photo_id_2 = ?1 AND face_index_2 = ?2)
             )
         )",
        params![photo_id_1, face_index_1 as i64, photo_id_2, face_index_2 as i64, constraint_type],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn add_constraint_by_face_keys(
    conn: &Connection,
    left_key: i64,
    right_key: i64,
    constraint_type: &str,
) -> AppResult<i64> {
    add_constraint(
        conn,
        left_key >> 8,
        (left_key & 0xff) as i32,
        right_key >> 8,
        (right_key & 0xff) as i32,
        constraint_type,
    )
}

/// Remove a constraint by ID.
pub fn remove_constraint(conn: &Connection, constraint_id: i64) -> AppResult<()> {
    conn.execute(
        "DELETE FROM face_constraints WHERE id = ?1",
        [constraint_id],
    )?;
    Ok(())
}

/// Get all constraints.
pub fn get_all_constraints(conn: &Connection) -> AppResult<Vec<FaceConstraint>> {
    let mut stmt = conn.prepare(
        "SELECT id, photo_id_1, face_index_1, photo_id_2, face_index_2, constraint_type, created_at
         FROM face_constraints",
    )?;
    let constraints = stmt.query_map([], |row| {
        Ok(FaceConstraint {
            id: row.get(0)?,
            photo_id_1: row.get(1)?,
            face_index_1: row.get(2)?,
            photo_id_2: row.get(3)?,
            face_index_2: row.get(4)?,
            constraint_type: row.get(5)?,
            created_at: row.get(6)?,
        })
    })?;
    constraints
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.into())
}

/// Get constraints for a specific face.
pub fn get_constraints_for_face(
    conn: &Connection,
    photo_id: i64,
    face_index: i32,
) -> AppResult<Vec<FaceConstraint>> {
    let mut stmt = conn.prepare(
        "SELECT id, photo_id_1, face_index_1, photo_id_2, face_index_2, constraint_type, created_at
         FROM face_constraints
         WHERE (photo_id_1 = ?1 AND face_index_1 = ?2)
            OR (photo_id_2 = ?1 AND face_index_2 = ?2)",
    )?;
    let constraints = stmt.query_map([photo_id, face_index as i64], |row| {
        Ok(FaceConstraint {
            id: row.get(0)?,
            photo_id_1: row.get(1)?,
            face_index_1: row.get(2)?,
            photo_id_2: row.get(3)?,
            face_index_2: row.get(4)?,
            constraint_type: row.get(5)?,
            created_at: row.get(6)?,
        })
    })?;
    constraints
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.into())
}

/// Get must-link pairs as face keys: (photo_id << 8 | face_index) pairs.
pub fn get_must_links(conn: &Connection) -> AppResult<Vec<(i64, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT
            (photo_id_1 << 8) | face_index_1,
            (photo_id_2 << 8) | face_index_2
         FROM face_constraints
         WHERE constraint_type = 'must_link'",
    )?;
    let pairs = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    pairs.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
}

/// Get cannot-link pairs as face keys.
pub fn get_cannot_links(conn: &Connection) -> AppResult<Vec<(i64, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT
            (photo_id_1 << 8) | face_index_1,
            (photo_id_2 << 8) | face_index_2
         FROM face_constraints
         WHERE constraint_type = 'cannot_link'",
    )?;
    let pairs = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    pairs.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
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
        let dir = std::env::temp_dir().join(format!("pf_constraint_test_{}", id));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("test.db");
        let conn = init_db(&db_path).unwrap();
        // Insert placeholder photos so foreign key constraints are satisfied
        conn.execute_batch(
            "INSERT INTO photos (path, filename, file_size, file_mtime, imported_at) VALUES ('/tmp/p1.jpg', 'p1.jpg', 1000, 0, 0);
             INSERT INTO photos (path, filename, file_size, file_mtime, imported_at) VALUES ('/tmp/p2.jpg', 'p2.jpg', 1000, 0, 0);
             INSERT INTO photos (path, filename, file_size, file_mtime, imported_at) VALUES ('/tmp/p3.jpg', 'p3.jpg', 1000, 0, 0);
             INSERT INTO photos (path, filename, file_size, file_mtime, imported_at) VALUES ('/tmp/p4.jpg', 'p4.jpg', 1000, 0, 0);
             INSERT INTO photos (path, filename, file_size, file_mtime, imported_at) VALUES ('/tmp/p5.jpg', 'p5.jpg', 1000, 0, 0);"
        ).unwrap();
        (db_path, conn)
    }

    fn cleanup(dir: std::path::PathBuf) {
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_add_and_get_constraint() {
        let (db_path, conn) = test_db();
        let id = add_constraint(&conn, 1, 0, 2, 1, "must_link").unwrap();
        assert!(id > 0);
        let all = get_all_constraints(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].photo_id_1, 1);
        assert_eq!(all[0].photo_id_2, 2);
        assert_eq!(all[0].constraint_type, "must_link");
        cleanup(db_path.parent().unwrap().to_path_buf());
    }

    #[test]
    fn test_remove_constraint() {
        let (db_path, conn) = test_db();
        let id = add_constraint(&conn, 1, 0, 2, 1, "cannot_link").unwrap();
        remove_constraint(&conn, id).unwrap();
        let all = get_all_constraints(&conn).unwrap();
        assert_eq!(all.len(), 0);
        cleanup(db_path.parent().unwrap().to_path_buf());
    }

    #[test]
    fn test_get_must_links() {
        let (db_path, conn) = test_db();
        add_constraint(&conn, 1, 0, 2, 1, "must_link").unwrap();
        add_constraint(&conn, 3, 2, 4, 0, "cannot_link").unwrap();
        let must = get_must_links(&conn).unwrap();
        assert_eq!(must.len(), 1);
        let cannot = get_cannot_links(&conn).unwrap();
        assert_eq!(cannot.len(), 1);
        cleanup(db_path.parent().unwrap().to_path_buf());
    }

    #[test]
    fn test_get_constraints_for_face() {
        let (db_path, conn) = test_db();
        add_constraint(&conn, 1, 0, 2, 1, "must_link").unwrap();
        add_constraint(&conn, 1, 0, 5, 3, "cannot_link").unwrap();
        let constraints = get_constraints_for_face(&conn, 1, 0).unwrap();
        assert_eq!(constraints.len(), 2);
        cleanup(db_path.parent().unwrap().to_path_buf());
    }
}
