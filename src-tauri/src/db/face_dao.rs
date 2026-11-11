// src-tauri/src/db/face_dao.rs
use chrono::Utc;
use rusqlite::params;

use crate::error::AppResult;
use crate::models::{FaceCluster, FaceDetection};

#[derive(Debug, Clone, serde::Serialize)]
pub struct SuspectedFace {
    pub id: i64,
    pub photo_id: i64,
    pub quality_score: f64,
    pub detection_confidence: f64,
}

pub fn insert_face_detection(conn: &rusqlite::Connection, face: &FaceDetection) -> AppResult<()> {
    conn.execute(
        "INSERT INTO face_detections (photo_id, bbox_x, bbox_y, bbox_w, bbox_h, embedding_path, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![face.photo_id, face.bbox_x, face.bbox_y, face.bbox_w, face.bbox_h, face.embedding_path, face.created_at],
    )?;
    Ok(())
}

pub fn insert_face_detection_with_metadata(
    conn: &rusqlite::Connection,
    face: &FaceDetection,
    metadata: &crate::models::FaceDetectionMetadata,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO face_detections (
            photo_id, bbox_x, bbox_y, bbox_w, bbox_h, embedding_path, created_at,
            quality_score, detection_confidence, landmarks_json, pose_yaw,
            pose_pitch, pose_roll, alignment_success, review_status
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            face.photo_id,
            face.bbox_x,
            face.bbox_y,
            face.bbox_w,
            face.bbox_h,
            face.embedding_path,
            face.created_at,
            metadata.quality_score,
            metadata.confidence,
            metadata.landmarks_json,
            metadata.pose_yaw,
            metadata.pose_pitch,
            metadata.pose_roll,
            metadata.alignment_success as i32,
            metadata.review_status,
        ],
    )?;
    Ok(())
}

pub fn update_named_face_after_reanalysis(
    conn: &rusqlite::Connection,
    face_id: i64,
    face: &FaceDetection,
    metadata: &crate::models::FaceDetectionMetadata,
) -> AppResult<()> {
    conn.execute(
        "UPDATE face_detections SET
            bbox_x=?1, bbox_y=?2, bbox_w=?3, bbox_h=?4, embedding_path=?5,
            quality_score=?6, detection_confidence=?7, landmarks_json=?8,
            pose_yaw=?9, pose_pitch=?10, pose_roll=?11, alignment_success=?12,
            review_status='active', created_at=?13
         WHERE id=?14",
        params![
            face.bbox_x,
            face.bbox_y,
            face.bbox_w,
            face.bbox_h,
            face.embedding_path,
            metadata.quality_score,
            metadata.confidence,
            metadata.landmarks_json,
            metadata.pose_yaw,
            metadata.pose_pitch,
            metadata.pose_roll,
            metadata.alignment_success as i32,
            face.created_at,
            face_id,
        ],
    )?;
    Ok(())
}

pub fn get_named_faces_for_photo(
    conn: &rusqlite::Connection,
    photo_id: i64,
) -> AppResult<Vec<FaceDetection>> {
    let mut stmt = conn.prepare(
        "SELECT fd.id, fd.photo_id, fd.bbox_x, fd.bbox_y, fd.bbox_w, fd.bbox_h,
                fd.embedding_path, fd.person_id, fd.created_at
         FROM face_detections fd
         JOIN face_clusters fc ON fc.id = fd.person_id
         LEFT JOIN person_metadata pm ON pm.person_id = fc.id
         WHERE fd.photo_id = ?1 AND (TRIM(COALESCE(fc.name, pm.user_name, '')) != '' OR pm.confidence = 'high')",
    )?;
    let rows = stmt.query_map([photo_id], |r| {
        Ok(FaceDetection {
            id: r.get(0)?,
            photo_id: r.get(1)?,
            bbox_x: r.get(2)?,
            bbox_y: r.get(3)?,
            bbox_w: r.get(4)?,
            bbox_h: r.get(5)?,
            embedding_path: r.get(6)?,
            person_id: r.get(7)?,
            created_at: r.get(8)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn get_ignored_faces_for_photo(
    conn: &rusqlite::Connection,
    photo_id: i64,
) -> AppResult<Vec<FaceDetection>> {
    let mut stmt = conn.prepare(
        "SELECT id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, embedding_path, person_id, created_at
         FROM face_detections WHERE photo_id = ?1 AND review_status = 'ignored'",
    )?;
    let rows = stmt.query_map([photo_id], |r| {
        Ok(FaceDetection {
            id: r.get(0)?,
            photo_id: r.get(1)?,
            bbox_x: r.get(2)?,
            bbox_y: r.get(3)?,
            bbox_w: r.get(4)?,
            bbox_h: r.get(5)?,
            embedding_path: r.get(6)?,
            person_id: r.get(7)?,
            created_at: r.get(8)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn prepare_face_reanalysis(conn: &rusqlite::Connection) -> AppResult<usize> {
    let tx = conn.unchecked_transaction()?;
    let removed = tx.execute(
        "DELETE FROM face_detections
         WHERE ((person_id IS NULL AND COALESCE(review_status, 'active') != 'ignored')
            OR person_id IN (
             SELECT fc.id FROM face_clusters fc
             LEFT JOIN person_metadata pm ON pm.person_id = fc.id
             WHERE TRIM(COALESCE(fc.name, pm.user_name, '')) = '' AND COALESCE(pm.confidence,'') <> 'high'
         )) AND NOT EXISTS (
             SELECT 1 FROM face_constraints c
             WHERE face_detections.embedding_path = printf('%08x.npy',(c.photo_id_1 << 8) | c.face_index_1)
                OR face_detections.embedding_path = printf('%08x.npy',(c.photo_id_2 << 8) | c.face_index_2)
         )",
        [],
    )?;
    tx.execute(
        "DELETE FROM person_metadata WHERE TRIM(COALESCE(user_name,''))=''
           AND COALESCE(confidence,'') <> 'high'
           AND EXISTS (SELECT 1 FROM face_clusters fc WHERE fc.id=person_id AND TRIM(COALESCE(fc.name,''))='')
           AND NOT EXISTS (SELECT 1 FROM face_detections fd WHERE fd.person_id=person_metadata.person_id)",
        [],
    )?;
    tx.execute(
        "DELETE FROM face_clusters WHERE TRIM(COALESCE(name,''))=''
           AND NOT EXISTS (SELECT 1 FROM face_detections fd WHERE fd.person_id=face_clusters.id)
           AND NOT EXISTS (SELECT 1 FROM person_metadata pm WHERE pm.person_id=face_clusters.id)",
        [],
    )?;
    tx.execute("DELETE FROM face_merge_history", [])?;
    tx.execute("DELETE FROM face_merge_operations", [])?;
    tx.execute("UPDATE photos SET face_status = 0 WHERE deleted = 0", [])?;
    tx.execute(
        "DELETE FROM ai_model_state WHERE component = 'face_pipeline'",
        [],
    )?;
    tx.commit()?;
    Ok(removed)
}

pub fn get_ai_model_version(
    conn: &rusqlite::Connection,
    component: &str,
) -> AppResult<Option<String>> {
    match conn.query_row(
        "SELECT version FROM ai_model_state WHERE component = ?1",
        [component],
        |row| row.get(0),
    ) {
        Ok(version) => Ok(Some(version)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn set_ai_model_version(
    conn: &rusqlite::Connection,
    component: &str,
    version: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO ai_model_state (component, version, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(component) DO UPDATE SET version=excluded.version, updated_at=excluded.updated_at",
        params![component, version, Utc::now().timestamp()],
    )?;
    Ok(())
}

pub fn get_faces_for_photo(
    conn: &rusqlite::Connection,
    photo_id: i64,
) -> AppResult<Vec<FaceDetection>> {
    let mut stmt = conn.prepare("SELECT id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, embedding_path, person_id, created_at FROM face_detections WHERE photo_id = ?")?;
    let rows = stmt
        .query_map([photo_id], |r| {
            Ok(FaceDetection {
                id: r.get(0)?,
                photo_id: r.get(1)?,
                bbox_x: r.get(2)?,
                bbox_y: r.get(3)?,
                bbox_w: r.get(4)?,
                bbox_h: r.get(5)?,
                embedding_path: r.get(6)?,
                person_id: r.get(7)?,
                created_at: r.get(8)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

pub fn get_face_by_id(conn: &rusqlite::Connection, face_id: i64) -> AppResult<FaceDetection> {
    conn.query_row(
        "SELECT id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, embedding_path, person_id, created_at
         FROM face_detections WHERE id = ?1",
        [face_id],
        |r| {
            Ok(FaceDetection {
                id: r.get(0)?,
                photo_id: r.get(1)?,
                bbox_x: r.get(2)?,
                bbox_y: r.get(3)?,
                bbox_w: r.get(4)?,
                bbox_h: r.get(5)?,
                embedding_path: r.get(6)?,
                person_id: r.get(7)?,
                created_at: r.get(8)?,
            })
        },
    )
    .map_err(Into::into)
}

pub fn create_cluster(conn: &rusqlite::Connection) -> AppResult<i64> {
    let now = Utc::now().timestamp();
    conn.execute(
        "INSERT INTO face_clusters (face_count, created_at) VALUES (0, ?1)",
        params![now],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Create a cluster with a specific ID (idempotent — does nothing if it already exists).
pub fn create_cluster_with_id(conn: &rusqlite::Connection, cluster_id: i64) -> AppResult<()> {
    let now = Utc::now().timestamp();
    conn.execute(
        "INSERT OR IGNORE INTO face_clusters (id, face_count, created_at) VALUES (?1, 0, ?2)",
        params![cluster_id, now],
    )?;
    Ok(())
}

pub fn get_all_clusters(conn: &rusqlite::Connection) -> AppResult<Vec<FaceCluster>> {
    let mut stmt = conn.prepare(
        "SELECT fc.id, fc.name,
                COUNT(CASE WHEN p.deleted = 0 THEN fd.id END) AS face_count,
                COUNT(DISTINCT CASE WHEN p.deleted = 0 THEN fd.photo_id END) AS photo_count,
                COALESCE(pm.confidence,
                    CASE WHEN COUNT(CASE WHEN p.deleted = 0 THEN fd.id END) <= 1 THEN 'low' ELSE 'medium' END
                ) AS confidence,
                fc.created_at
         FROM face_clusters fc
         LEFT JOIN face_detections fd ON fd.person_id = fc.id
         LEFT JOIN photos p ON p.id = fd.photo_id
         LEFT JOIN person_metadata pm ON pm.person_id = fc.id
         GROUP BY fc.id
         HAVING face_count > 0
         ORDER BY face_count DESC"
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(FaceCluster {
                id: r.get(0)?,
                name: r.get(1)?,
                face_count: r.get(2)?,
                photo_count: r.get(3)?,
                confidence: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

pub fn get_cluster_page(
    conn: &rusqlite::Connection,
    tab: &str,
    offset: i64,
    limit: i64,
) -> AppResult<crate::models::FaceClusterPage> {
    let condition = match tab {
        "named" => "TRIM(COALESCE(fc.name, '')) != ''",
        "unnamed" => "TRIM(COALESCE(fc.name, '')) = ''",
        "review" => "COALESCE(pm.confidence, CASE WHEN fc.face_count <= 1 THEN 'low' ELSE 'medium' END) = 'low'",
        _ => {
            return Err(crate::error::AppError::Project(
                "Invalid person page tab".into(),
            ))
        }
    };
    let counts = conn.query_row(
        "SELECT
            COALESCE(SUM(CASE WHEN TRIM(COALESCE(fc.name, '')) != '' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN TRIM(COALESCE(fc.name, '')) = '' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN COALESCE(pm.confidence, CASE WHEN fc.face_count <= 1 THEN 'low' ELSE 'medium' END) = 'low' THEN 1 ELSE 0 END), 0)
         FROM face_clusters fc
         LEFT JOIN person_metadata pm ON pm.person_id = fc.id
         WHERE fc.face_count > 0",
        [],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
    )?;
    let sql = format!(
        "SELECT fc.id, fc.name, fc.face_count,
                (SELECT COUNT(DISTINCT fd.photo_id)
                 FROM face_detections fd
                 JOIN photos p ON p.id = fd.photo_id
                 WHERE fd.person_id = fc.id AND p.deleted = 0) AS photo_count,
                COALESCE(pm.confidence,
                    CASE WHEN fc.face_count <= 1 THEN 'low' ELSE 'medium' END
                ) AS confidence,
                fc.created_at
         FROM face_clusters fc
         LEFT JOIN person_metadata pm ON pm.person_id = fc.id
         WHERE fc.face_count > 0 AND {condition}
         ORDER BY fc.face_count DESC, fc.id
         LIMIT ?1 OFFSET ?2"
    );
    let mut statement = conn.prepare(&sql)?;
    let items = statement
        .query_map(params![limit.clamp(1, 200), offset.max(0)], |row| {
            Ok(FaceCluster {
                id: row.get(0)?,
                name: row.get(1)?,
                face_count: row.get(2)?,
                photo_count: row.get(3)?,
                confidence: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let total = match tab {
        "named" => counts.0,
        "unnamed" => counts.1,
        _ => counts.2,
    };
    Ok(crate::models::FaceClusterPage {
        items,
        total,
        named_count: counts.0,
        unnamed_count: counts.1,
        review_count: counts.2,
    })
}

/// Remove only machine-created group assignments so a safer clustering
/// algorithm can rebuild them. Named people are user data and are preserved.
pub fn reset_automatic_clusters(conn: &rusqlite::Connection) -> AppResult<usize> {
    let tx = conn.unchecked_transaction()?;
    let reset = tx.execute(
        "UPDATE face_detections
         SET person_id = NULL, review_status = CASE WHEN review_status = 'identity_review' THEN 'active' ELSE review_status END
         WHERE person_id IN (
             SELECT fc.id FROM face_clusters fc
             LEFT JOIN person_metadata pm ON pm.person_id = fc.id
             WHERE TRIM(COALESCE(fc.name, pm.user_name, '')) = '' AND COALESCE(pm.confidence,'') <> 'high'
         )",
        [],
    )?;
    tx.execute(
        "DELETE FROM person_metadata
         WHERE person_id IN (
             SELECT fc.id FROM face_clusters fc
             WHERE TRIM(COALESCE(fc.name, '')) = ''
               AND NOT EXISTS (SELECT 1 FROM face_detections fd WHERE fd.person_id=fc.id)
         )",
        [],
    )?;
    tx.execute(
        "DELETE FROM face_clusters
         WHERE TRIM(COALESCE(name, '')) = ''
           AND NOT EXISTS (SELECT 1 FROM face_detections fd WHERE fd.person_id=face_clusters.id)
           AND NOT EXISTS (SELECT 1 FROM person_metadata pm WHERE pm.person_id=face_clusters.id AND TRIM(COALESCE(pm.user_name,''))<>'')",
        [],
    )?;
    tx.execute(
        "UPDATE face_clusters
         SET face_count = (SELECT COUNT(*) FROM face_detections WHERE person_id = face_clusters.id)",
        [],
    )?;
    tx.commit()?;
    Ok(reset)
}

pub fn rename_cluster(conn: &rusqlite::Connection, cluster_id: i64, name: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE face_detections SET review_status = 'active' WHERE person_id = ?1 AND review_status = 'identity_review'",
        [cluster_id],
    )?;
    conn.execute(
        "UPDATE face_clusters SET name = ? WHERE id = ?",
        params![name, cluster_id],
    )?;
    Ok(())
}

/// Persist a user's review decision for an automatically created person.
/// The row is separate from the cluster so a future incremental clustering run
/// does not turn a confirmed singleton back into a low-confidence review item.
pub fn set_cluster_confidence(
    conn: &rusqlite::Connection,
    cluster_id: i64,
    confidence: &str,
) -> AppResult<()> {
    if !matches!(confidence, "low" | "medium" | "high") {
        return Err(crate::error::AppError::Project(
            "Invalid person confidence".into(),
        ));
    }
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM face_clusters WHERE id = ?1",
        [cluster_id],
        |row| row.get(0),
    )?;
    if exists == 0 {
        return Err(crate::error::AppError::NotFound(format!(
            "Person {} not found",
            cluster_id
        )));
    }
    conn.execute(
        "INSERT INTO person_metadata (person_id, confidence, centroid_cached)
         VALUES (?1, ?2, 1)
         ON CONFLICT(person_id) DO UPDATE SET confidence = excluded.confidence",
        params![cluster_id, confidence],
    )?;
    if confidence != "low" {
        conn.execute("UPDATE face_detections SET review_status = 'active' WHERE person_id = ?1 AND review_status = 'identity_review'", [cluster_id])?;
    }
    Ok(())
}

pub fn assign_face_to_person(
    conn: &rusqlite::Connection,
    face_id: i64,
    person_id: Option<i64>,
) -> AppResult<()> {
    conn.execute(
        "UPDATE face_detections SET person_id = ? WHERE id = ?",
        params![person_id, face_id],
    )?;
    Ok(())
}

fn face_embedding_key(conn: &rusqlite::Connection, face_id: i64) -> AppResult<Option<i64>> {
    let path: Option<String> = conn.query_row(
        "SELECT embedding_path FROM face_detections WHERE id=?1",
        [face_id],
        |row| row.get(0),
    )?;
    Ok(path.and_then(|path| {
        path.strip_suffix(".npy")
            .and_then(|stem| i64::from_str_radix(stem, 16).ok())
    }))
}

fn record_face_correction(
    conn: &rusqlite::Connection,
    face_id: i64,
    old: Option<i64>,
    target: i64,
) -> AppResult<()> {
    if old == Some(target) {
        return Ok(());
    }
    let Some(key) = face_embedding_key(conn, face_id)? else {
        return Ok(());
    };
    let target_key = get_other_face_key_for_cluster(conn, target, Some(face_id))?;
    let old_key = match old {
        Some(person) => get_other_face_key_for_cluster(conn, person, Some(face_id))?,
        None => None,
    };
    for (other, kind) in [(old_key, "cannot_link"), (target_key, "must_link")] {
        if let Some(other) = other.filter(|other| *other != key) {
            crate::db::constraint_dao::set_constraint_by_face_keys(conn, key, other, kind)?;
        }
    }
    Ok(())
}

/// Move one detected face to another existing person. This is intentionally
/// narrower than merging people: only the selected face on one photo changes.
pub fn reassign_face_to_person(
    conn: &rusqlite::Connection,
    face_id: i64,
    person_id: i64,
) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    let target_exists: i64 = tx.query_row(
        "SELECT COUNT(*) FROM face_clusters WHERE id = ?1",
        [person_id],
        |row| row.get(0),
    )?;
    if target_exists == 0 {
        return Err(crate::error::AppError::NotFound(format!(
            "Person {} not found",
            person_id
        )));
    }
    let old_person_id: Option<i64> = tx
        .query_row(
            "SELECT person_id FROM face_detections WHERE id = ?1",
            [face_id],
            |row| row.get(0),
        )
        .map_err(|_| crate::error::AppError::NotFound(format!("Face {} not found", face_id)))?;

    record_face_correction(&tx, face_id, old_person_id, person_id)?;
    tx.execute(
        "UPDATE face_detections SET person_id = ?1, review_status = CASE WHEN review_status IN ('identity_review','suspected_false_positive') THEN 'active' ELSE review_status END WHERE id = ?2",
        params![person_id, face_id],
    )?;
    tx.execute(
        "UPDATE face_clusters SET face_count = (SELECT COUNT(*) FROM face_detections WHERE person_id = face_clusters.id)",
        [],
    )?;
    if let Some(old_id) = old_person_id.filter(|old_id| *old_id != person_id) {
        tx.execute(
            "DELETE FROM person_metadata WHERE person_id = ?1
             AND NOT EXISTS (SELECT 1 FROM face_detections WHERE person_id = ?1)
             AND EXISTS (SELECT 1 FROM face_clusters WHERE id = ?1 AND TRIM(COALESCE(name, '')) = '')",
            [old_id],
        )?;
        tx.execute(
            "DELETE FROM face_clusters WHERE id = ?1 AND TRIM(COALESCE(name, '')) = ''
             AND NOT EXISTS (SELECT 1 FROM face_detections WHERE person_id = ?1)",
            [old_id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Create a named person and move one selected face into it atomically.
pub fn create_named_person_for_face(
    conn: &rusqlite::Connection,
    face_id: i64,
    name: &str,
) -> AppResult<i64> {
    let name = name.trim();
    if name.is_empty() {
        return Err(crate::error::AppError::Project(
            "Person name cannot be empty".into(),
        ));
    }
    let tx = conn.unchecked_transaction()?;
    let old_person_id: Option<i64> = tx
        .query_row(
            "SELECT person_id FROM face_detections WHERE id = ?1",
            [face_id],
            |row| row.get(0),
        )
        .map_err(|_| crate::error::AppError::NotFound(format!("Face {} not found", face_id)))?;
    let now = chrono::Utc::now().timestamp();
    tx.execute(
        "INSERT INTO face_clusters (name, face_count, created_at) VALUES (?1, 0, ?2)",
        params![name, now],
    )?;
    let person_id = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO person_metadata (person_id, confidence, centroid_cached) VALUES (?1, 'high', 1)",
        [person_id],
    )?;
    record_face_correction(&tx, face_id, old_person_id, person_id)?;
    tx.execute(
        "UPDATE face_detections SET person_id = ?1, review_status = CASE WHEN review_status IN ('identity_review','suspected_false_positive') THEN 'active' ELSE review_status END WHERE id = ?2",
        params![person_id, face_id],
    )?;
    tx.execute(
        "UPDATE face_clusters SET face_count = (SELECT COUNT(*) FROM face_detections WHERE person_id = face_clusters.id)",
        [],
    )?;
    if let Some(old_id) = old_person_id.filter(|old_id| *old_id != person_id) {
        tx.execute(
            "DELETE FROM person_metadata WHERE person_id = ?1
             AND NOT EXISTS (SELECT 1 FROM face_detections WHERE person_id = ?1)
             AND EXISTS (SELECT 1 FROM face_clusters WHERE id = ?1 AND TRIM(COALESCE(name, '')) = '')",
            [old_id],
        )?;
        tx.execute(
            "DELETE FROM face_clusters WHERE id = ?1 AND TRIM(COALESCE(name, '')) = ''
             AND NOT EXISTS (SELECT 1 FROM face_detections WHERE person_id = ?1)",
            [old_id],
        )?;
    }
    tx.commit()?;
    Ok(person_id)
}

/// Remove a false-positive face detection from one photo without touching the
/// source image or any other face belonging to the same person.
pub fn delete_face_detection(conn: &rusqlite::Connection, face_id: i64) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    let old_person_id: Option<i64> = tx
        .query_row(
            "SELECT person_id FROM face_detections WHERE id = ?1",
            [face_id],
            |row| row.get(0),
        )
        .map_err(|_| crate::error::AppError::NotFound(format!("Face {} not found", face_id)))?;
    tx.execute("DELETE FROM face_detections WHERE id = ?1", [face_id])?;
    tx.execute(
        "UPDATE face_clusters SET face_count = (SELECT COUNT(*) FROM face_detections WHERE person_id = face_clusters.id)",
        [],
    )?;
    if let Some(old_id) = old_person_id {
        tx.execute(
            "DELETE FROM person_metadata WHERE person_id = ?1
             AND NOT EXISTS (SELECT 1 FROM face_detections WHERE person_id = ?1)
             AND EXISTS (SELECT 1 FROM face_clusters WHERE id = ?1 AND TRIM(COALESCE(name, '')) = '')",
            [old_id],
        )?;
        tx.execute(
            "DELETE FROM face_clusters WHERE id = ?1 AND TRIM(COALESCE(name, '')) = ''
             AND NOT EXISTS (SELECT 1 FROM face_detections WHERE person_id = ?1)",
            [old_id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn get_faces_for_person(
    conn: &rusqlite::Connection,
    person_id: i64,
    limit: i64,
) -> AppResult<Vec<FaceDetection>> {
    let mut stmt = conn.prepare("SELECT fd.id, fd.photo_id, fd.bbox_x, fd.bbox_y, fd.bbox_w, fd.bbox_h, fd.embedding_path, fd.person_id, fd.created_at FROM face_detections fd JOIN photos p ON p.id = fd.photo_id WHERE fd.person_id = ? AND p.deleted = 0 ORDER BY COALESCE(fd.quality_score, 0) DESC, COALESCE(fd.detection_confidence, 0) DESC, (COALESCE(fd.bbox_w, 0) * COALESCE(fd.bbox_h, 0)) DESC LIMIT ?")?;
    let rows = stmt
        .query_map(params![person_id, limit], |r| {
            Ok(FaceDetection {
                id: r.get(0)?,
                photo_id: r.get(1)?,
                bbox_x: r.get(2)?,
                bbox_y: r.get(3)?,
                bbox_w: r.get(4)?,
                bbox_h: r.get(5)?,
                embedding_path: r.get(6)?,
                person_id: r.get(7)?,
                created_at: r.get(8)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

pub fn merge_clusters(conn: &rusqlite::Connection, from_id: i64, to_id: i64) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE face_detections SET person_id = ? WHERE person_id = ?",
        params![to_id, from_id],
    )?;
    tx.execute(
        "DELETE FROM person_metadata WHERE person_id = ?1",
        [from_id],
    )?;
    crate::db::smart_album_dao::replace_combination_person(&tx, from_id, to_id)?;
    tx.execute("DELETE FROM face_clusters WHERE id = ?1", params![from_id])?;
    tx.execute(
        "UPDATE face_clusters SET face_count = (SELECT COUNT(*) FROM face_detections WHERE person_id = ?1) WHERE id = ?1",
        [to_id],
    )?;
    set_cluster_confidence(&tx, to_id, "high")?;
    tx.commit()?;
    Ok(())
}

/// Merge several people into one transactionally. Either every face moves and
/// the redundant clusters disappear, or the database remains unchanged.
pub fn merge_clusters_batch(
    conn: &rusqlite::Connection,
    target_id: i64,
    source_ids: &[i64],
    name: Option<&str>,
) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    for source_id in source_ids {
        if *source_id == target_id {
            continue;
        }
        tx.execute(
            "UPDATE face_detections SET person_id = ?1, review_status = CASE WHEN review_status = 'identity_review' THEN 'active' ELSE review_status END WHERE person_id = ?2",
            params![target_id, source_id],
        )?;
        // Confirmed/named people have a metadata row that references the cluster.
        // Remove only the redundant source metadata before deleting that cluster;
        // the target person's metadata and name remain untouched.
        tx.execute(
            "DELETE FROM person_metadata WHERE person_id = ?1",
            params![source_id],
        )?;
        crate::db::smart_album_dao::replace_combination_person(&tx, *source_id, target_id)?;
        tx.execute(
            "DELETE FROM face_clusters WHERE id = ?1",
            params![source_id],
        )?;
    }
    if let Some(name) = name.map(str::trim).filter(|name| !name.is_empty()) {
        tx.execute(
            "UPDATE face_clusters SET name = ?1 WHERE id = ?2",
            params![name, target_id],
        )?;
    }
    tx.execute(
        "UPDATE face_clusters SET face_count = (SELECT COUNT(*) FROM face_detections WHERE person_id = ?1) WHERE id = ?1",
        params![target_id],
    )?;
    set_cluster_confidence(&tx, target_id, "high")?;
    tx.commit()?;
    Ok(())
}

/// Apply reviewed automatic merge groups and keep enough history for an exact undo.
pub fn apply_automatic_merge_groups(
    conn: &rusqlite::Connection,
    groups: &[Vec<i64>],
    threshold: f64,
) -> AppResult<(i64, usize, usize)> {
    let tx = conn.unchecked_transaction()?;
    let now = Utc::now().timestamp();
    tx.execute(
        "INSERT INTO face_merge_operations (threshold, created_at) VALUES (?1, ?2)",
        params![threshold, now],
    )?;
    let operation_id = tx.last_insert_rowid();
    let mut merged_group_count = 0usize;
    let mut removed_cluster_count = 0usize;

    for requested in groups {
        let mut ids = requested.clone();
        ids.sort_unstable();
        ids.dedup();
        if ids.len() < 2 {
            continue;
        }
        let mut counts = Vec::new();
        let mut valid = true;
        for id in &ids {
            let result = tx.query_row(
                "SELECT COUNT(fd.id), TRIM(COALESCE(fc.name, pm.user_name, ''))
                 FROM face_clusters fc
                 LEFT JOIN face_detections fd ON fd.person_id = fc.id
                 LEFT JOIN person_metadata pm ON pm.person_id = fc.id
                 WHERE fc.id = ?1 GROUP BY fc.id",
                [id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            );
            match result {
                Ok((count, name)) if name.is_empty() => counts.push((*id, count)),
                _ => {
                    valid = false;
                    break;
                }
            }
        }
        if !valid {
            continue;
        }
        let ids_json = serde_json::json!(ids).to_string();
        let conflicts: bool = tx.query_row(
            "WITH selected AS (SELECT CAST(value AS INTEGER) FROM json_each(?1)),
             faces AS (SELECT fd.* FROM face_detections fd JOIN photos p ON p.id=fd.photo_id
                       WHERE fd.person_id IN selected AND p.deleted=0)
             SELECT EXISTS (SELECT 1 FROM faces WHERE review_status='identity_review')
                 OR EXISTS (SELECT 1 FROM person_metadata WHERE person_id IN selected AND confidence='high')
                 OR EXISTS (SELECT 1 FROM faces GROUP BY photo_id HAVING COUNT(DISTINCT person_id)>1)
                 OR EXISTS (SELECT 1 FROM face_constraints c
                    JOIN faces a ON a.embedding_path=printf('%08x.npy',(c.photo_id_1<<8)|c.face_index_1)
                    JOIN faces b ON b.embedding_path=printf('%08x.npy',(c.photo_id_2<<8)|c.face_index_2)
                    WHERE c.constraint_type='cannot_link' AND a.person_id<>b.person_id)",
            [&ids_json], |row| row.get(0),
        )?;
        if conflicts {
            continue;
        }
        let target = counts
            .iter()
            .max_by_key(|(_, count)| *count)
            .map(|(id, _)| *id)
            .unwrap();

        for id in &ids {
            let faces: Vec<i64> = {
                let mut stmt = tx.prepare("SELECT id FROM face_detections WHERE person_id = ?1")?;
                let rows = stmt
                    .query_map([id], |row| row.get(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            for face_id in faces {
                tx.execute(
                    "INSERT INTO face_merge_history
                     (operation_id, face_id, original_person_id, merged_person_id)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![operation_id, face_id, id, target],
                )?;
            }
        }
        for id in &ids {
            if *id != target {
                tx.execute(
                    "UPDATE face_detections SET person_id = ?1, review_status = CASE WHEN review_status = 'identity_review' THEN 'active' ELSE review_status END WHERE person_id = ?2",
                    params![target, id],
                )?;
                tx.execute("DELETE FROM person_metadata WHERE person_id = ?1", [id])?;
                tx.execute("DELETE FROM face_clusters WHERE id = ?1", [id])?;
            }
        }
        merged_group_count += 1;
        removed_cluster_count += ids.len() - 1;
    }

    if merged_group_count == 0 {
        tx.rollback()?;
        return Ok((0, 0, 0));
    }
    tx.execute(
        "UPDATE face_clusters SET face_count = (
            SELECT COUNT(*) FROM face_detections WHERE person_id = face_clusters.id
         )",
        [],
    )?;
    tx.execute(
        "UPDATE face_merge_operations
         SET merged_group_count = ?1, removed_cluster_count = ?2 WHERE id = ?3",
        params![merged_group_count, removed_cluster_count, operation_id],
    )?;
    tx.commit()?;
    Ok((operation_id, merged_group_count, removed_cluster_count))
}

pub fn undo_last_automatic_merge(conn: &rusqlite::Connection) -> AppResult<Option<(usize, usize)>> {
    let operation_id = match conn.query_row(
        "SELECT id FROM face_merge_operations WHERE status = 'applied' ORDER BY id DESC LIMIT 1",
        [],
        |row| row.get::<_, i64>(0),
    ) {
        Ok(id) => id,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let named_targets: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT fc.id)
         FROM face_merge_history h
         JOIN face_clusters fc ON fc.id = h.merged_person_id
         LEFT JOIN person_metadata pm ON pm.person_id = fc.id
         WHERE h.operation_id = ?1
           AND TRIM(COALESCE(fc.name, pm.user_name, '')) != ''",
        [operation_id],
        |row| row.get(0),
    )?;
    if named_targets > 0 {
        return Err(crate::error::AppError::Project(
            "The last automatic merge has since been named and cannot be automatically undone"
                .into(),
        ));
    }
    let tx = conn.unchecked_transaction()?;
    let history: Vec<(i64, i64, i64)> = {
        let mut stmt = tx.prepare(
            "SELECT face_id, original_person_id, merged_person_id
             FROM face_merge_history WHERE operation_id = ?1",
        )?;
        let rows = stmt
            .query_map([operation_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let original_ids: std::collections::HashSet<i64> =
        history.iter().map(|(_, original, _)| *original).collect();
    let now = Utc::now().timestamp();
    for id in &original_ids {
        tx.execute(
            "INSERT OR IGNORE INTO face_clusters (id, face_count, created_at) VALUES (?1, 0, ?2)",
            params![id, now],
        )?;
    }
    let mut restored = 0usize;
    for (face_id, original_id, merged_id) in history {
        restored += tx.execute(
            "UPDATE face_detections SET person_id = ?1 WHERE id = ?2 AND person_id = ?3",
            params![original_id, face_id, merged_id],
        )?;
    }
    tx.execute(
        "UPDATE face_clusters SET face_count = (
            SELECT COUNT(*) FROM face_detections WHERE person_id = face_clusters.id
         )",
        [],
    )?;
    tx.execute(
        "UPDATE face_merge_operations SET status = 'undone', undone_at = ?1 WHERE id = ?2",
        params![Utc::now().timestamp(), operation_id],
    )?;
    tx.commit()?;
    Ok(Some((original_ids.len(), restored)))
}

pub fn has_automatic_merge_to_undo(conn: &rusqlite::Connection) -> AppResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM face_merge_operations WHERE status = 'applied'",
        [],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

pub fn get_best_face_key_for_cluster(
    conn: &rusqlite::Connection,
    cluster_id: i64,
) -> AppResult<Option<i64>> {
    get_other_face_key_for_cluster(conn, cluster_id, None)
}

fn get_other_face_key_for_cluster(
    conn: &rusqlite::Connection,
    cluster_id: i64,
    except: Option<i64>,
) -> AppResult<Option<i64>> {
    let path = match conn.query_row(
        "SELECT embedding_path FROM face_detections
         WHERE person_id = ?1 AND embedding_path IS NOT NULL AND (?2 IS NULL OR id <> ?2)
         ORDER BY COALESCE(quality_score, 0) DESC,
                  COALESCE(detection_confidence, 0) DESC, id LIMIT 1",
        params![cluster_id, except],
        |row| row.get::<_, String>(0),
    ) {
        Ok(path) => path,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let stem = std::path::Path::new(&path)
        .file_stem()
        .and_then(|value| value.to_str());
    Ok(stem.and_then(|value| i64::from_str_radix(value, 16).ok()))
}

pub fn get_unassigned_faces(conn: &rusqlite::Connection) -> AppResult<Vec<FaceDetection>> {
    get_unassigned_faces_limited(conn, i64::MAX)
}

pub fn get_unassigned_faces_limited(
    conn: &rusqlite::Connection,
    limit: i64,
) -> AppResult<Vec<FaceDetection>> {
    let mut stmt = conn.prepare(
        "SELECT fd.id, fd.photo_id, fd.bbox_x, fd.bbox_y, fd.bbox_w, fd.bbox_h, fd.embedding_path, fd.person_id, fd.created_at FROM face_detections fd JOIN photos p ON p.id = fd.photo_id WHERE fd.person_id IS NULL AND fd.embedding_path IS NOT NULL AND COALESCE(fd.review_status, 'active') = 'active' AND p.deleted = 0 ORDER BY fd.id LIMIT ?1"
    )?;
    let rows = stmt
        .query_map([limit.max(1)], |r| {
            Ok(FaceDetection {
                id: r.get(0)?,
                photo_id: r.get(1)?,
                bbox_x: r.get(2)?,
                bbox_y: r.get(3)?,
                bbox_w: r.get(4)?,
                bbox_h: r.get(5)?,
                embedding_path: r.get(6)?,
                person_id: r.get(7)?,
                created_at: r.get(8)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

pub fn get_unassigned_embedding_qualities(
    conn: &rusqlite::Connection,
    limit: i64,
) -> AppResult<std::collections::HashMap<String, f64>> {
    let mut stmt = conn.prepare(
        "SELECT fd.embedding_path, COALESCE(fd.quality_score, 0)
         FROM face_detections fd JOIN photos p ON p.id = fd.photo_id
         WHERE fd.person_id IS NULL AND fd.embedding_path IS NOT NULL
           AND COALESCE(fd.review_status, 'active') = 'active' AND p.deleted = 0
         ORDER BY fd.id LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect::<Result<_, _>>().map_err(Into::into)
}

pub fn get_suspected_faces(
    conn: &rusqlite::Connection,
    limit: i64,
) -> AppResult<Vec<SuspectedFace>> {
    let mut stmt = conn.prepare(
        "SELECT fd.id, fd.photo_id, COALESCE(fd.quality_score, 0),
                COALESCE(fd.detection_confidence, 0)
         FROM face_detections fd JOIN photos p ON p.id = fd.photo_id
         WHERE fd.review_status = 'suspected_false_positive' AND p.deleted = 0
         ORDER BY fd.quality_score ASC, fd.detection_confidence ASC LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], |row| {
        Ok(SuspectedFace {
            id: row.get(0)?,
            photo_id: row.get(1)?,
            quality_score: row.get(2)?,
            detection_confidence: row.get(3)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn get_suspected_face_count(conn: &rusqlite::Connection) -> AppResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM face_detections WHERE review_status = 'suspected_false_positive'",
        [],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

pub fn keep_suspected_face(conn: &rusqlite::Connection, face_id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE face_detections SET review_status = 'active' WHERE id = ?1",
        [face_id],
    )?;
    Ok(())
}

pub fn delete_all_suspected_faces(conn: &rusqlite::Connection) -> AppResult<usize> {
    conn.execute(
        "DELETE FROM face_detections WHERE review_status = 'suspected_false_positive'",
        [],
    )
    .map_err(Into::into)
}

/// Read all persisted embedding-to-person assignments in one query. This replaces
/// the previous per-cluster lookup, which became increasingly expensive as a
/// library accumulated people.
pub fn get_embedding_cluster_assignments(
    conn: &rusqlite::Connection,
) -> AppResult<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT fd.embedding_path, fd.person_id FROM face_detections fd \
         JOIN photos p ON p.id = fd.photo_id \
         WHERE fd.person_id IS NOT NULL AND fd.embedding_path IS NOT NULL AND COALESCE(fd.review_status, 'active') IN ('active', 'identity_review') AND p.deleted = 0",
    )?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

/// Return a small, quality-ranked prototype set for each existing person.
/// Incremental clustering uses these representatives instead of reopening every
/// historical embedding in the library.
pub fn get_embedding_cluster_prototypes(
    conn: &rusqlite::Connection,
    per_cluster: i64,
) -> AppResult<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "WITH ranked AS (
             SELECT fd.embedding_path, fd.person_id, fd.id,
                    COALESCE(fd.quality_score,0) AS quality,
                    COALESCE(fd.detection_confidence,0) AS confidence,
                    ROW_NUMBER() OVER(PARTITION BY fd.person_id, fd.photo_id
                       ORDER BY COALESCE(fd.quality_score,0) DESC, fd.id) AS photo_rank,
                    CASE WHEN fd.pose_yaw < -15 THEN -1 WHEN fd.pose_yaw > 15 THEN 1 ELSE 0 END AS pose
             FROM face_detections fd JOIN photos p ON p.id=fd.photo_id
             WHERE fd.person_id IS NOT NULL AND fd.embedding_path IS NOT NULL
               AND COALESCE(fd.review_status,'active')='active' AND p.deleted=0
         ), poses AS (
             SELECT *, ROW_NUMBER() OVER(PARTITION BY person_id, pose ORDER BY quality DESC, confidence DESC, id) AS pose_rank
             FROM ranked WHERE photo_rank=1
         )
         SELECT embedding_path,person_id FROM (
             SELECT *, ROW_NUMBER() OVER(PARTITION BY person_id
               ORDER BY (quality > 0 AND quality < 0.55), pose_rank, quality DESC, confidence DESC, id) AS rank
             FROM poses
         ) WHERE rank<=?1",
    )?;
    let rows = stmt.query_map([per_cluster.clamp(1, 8)], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

/// Automatic merge candidates deliberately exclude every user-owned person.
/// A name in either legacy face_clusters or person_metadata is authoritative.
pub fn get_unnamed_embedding_cluster_assignments(
    conn: &rusqlite::Connection,
) -> AppResult<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT fd.embedding_path, fd.person_id
         FROM face_detections fd
         JOIN face_clusters fc ON fc.id = fd.person_id
         JOIN photos p ON p.id = fd.photo_id
         LEFT JOIN person_metadata pm ON pm.person_id = fc.id
         WHERE fd.embedding_path IS NOT NULL
           AND fd.person_id IS NOT NULL
           AND p.deleted = 0
           AND COALESCE(fd.review_status, 'active') = 'active'
           AND TRIM(COALESCE(fc.name, pm.user_name, '')) = ''
           AND COALESCE(pm.confidence,'') <> 'high'",
    )?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.filter_map(Result::ok).collect())
}

pub fn clusters_are_unnamed(conn: &rusqlite::Connection, ids: &[i64]) -> AppResult<bool> {
    for id in ids {
        let named: i64 = conn.query_row(
            "SELECT CASE WHEN TRIM(COALESCE(fc.name, pm.user_name, '')) = '' THEN 0 ELSE 1 END
             FROM face_clusters fc
             LEFT JOIN person_metadata pm ON pm.person_id = fc.id
             WHERE fc.id = ?1",
            [id],
            |row| row.get(0),
        )?;
        if named != 0 {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Remove unimportant automatic people from the People experience without
/// deleting their source photos. Ignored face rows remain as durable exclusion
/// regions, so a later AI rebuild does not recreate the same people.
pub fn ignore_automatic_clusters(
    conn: &rusqlite::Connection,
    cluster_ids: &[i64],
) -> AppResult<(usize, usize)> {
    let mut ids = cluster_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Ok((0, 0));
    }
    let tx = conn.unchecked_transaction()?;
    let mut ignored_groups = 0usize;
    let mut ignored_faces = 0usize;
    for id in ids {
        let name = match tx.query_row(
            "SELECT TRIM(COALESCE(fc.name, pm.user_name, ''))
             FROM face_clusters fc LEFT JOIN person_metadata pm ON pm.person_id = fc.id
             WHERE fc.id = ?1",
            [id],
            |row| row.get::<_, String>(0),
        ) {
            Ok(name) => name,
            Err(rusqlite::Error::QueryReturnedNoRows) => continue,
            Err(error) => return Err(error.into()),
        };
        if !name.is_empty() {
            return Err(crate::error::AppError::Project(
                "Named people cannot be ignored from this view".into(),
            ));
        }
        tx.execute(
            "UPDATE face_merge_operations SET status = 'superseded'
             WHERE status = 'applied' AND id IN (
                 SELECT operation_id FROM face_merge_history
                 WHERE original_person_id = ?1 OR merged_person_id = ?1
             )",
            [id],
        )?;
        ignored_faces += tx.execute(
            "UPDATE face_detections
             SET person_id = NULL, review_status = 'ignored'
             WHERE person_id = ?1",
            [id],
        )?;
        tx.execute("DELETE FROM person_metadata WHERE person_id = ?1", [id])?;
        tx.execute("DELETE FROM face_clusters WHERE id = ?1", [id])?;
        ignored_groups += 1;
    }
    tx.commit()?;
    Ok((ignored_groups, ignored_faces))
}

pub fn get_ignored_face_count(conn: &rusqlite::Connection) -> AppResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM face_detections WHERE review_status = 'ignored'",
        [],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

pub fn restore_all_ignored_faces(conn: &rusqlite::Connection) -> AppResult<usize> {
    conn.execute(
        "UPDATE face_detections SET review_status = 'active'
         WHERE review_status = 'ignored' AND person_id IS NULL",
        [],
    )
    .map_err(Into::into)
}

/// Create any new clusters and apply assignments in one SQLite transaction.
pub fn apply_cluster_assignments(
    conn: &rusqlite::Connection,
    new_cluster_ids: &[i64],
    assignments: &[(i64, i64, bool)],
) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    let now = Utc::now().timestamp();
    {
        let mut create = tx.prepare_cached(
            "INSERT OR IGNORE INTO face_clusters (id, face_count, created_at) VALUES (?1, 0, ?2)",
        )?;
        for cluster_id in new_cluster_ids {
            create.execute(params![cluster_id, now])?;
        }
    }
    {
        let mut assign =
            tx.prepare_cached("UPDATE face_detections SET person_id = ?1, review_status = ?3 WHERE id = ?2 AND person_id IS NULL AND COALESCE(review_status, 'active') = 'active'")?;
        for (face_id, cluster_id, review) in assignments {
            assign.execute(params![
                cluster_id,
                face_id,
                if *review { "identity_review" } else { "active" }
            ])?;
        }
    }
    tx.execute(
        "UPDATE face_clusters SET face_count = (SELECT COUNT(*) FROM face_detections WHERE person_id = face_clusters.id)",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn update_cluster_face_counts(conn: &rusqlite::Connection) -> AppResult<()> {
    conn.execute(
        "UPDATE face_clusters SET face_count = (SELECT COUNT(*) FROM face_detections WHERE person_id = face_clusters.id)",
        [],
    )?;
    Ok(())
}

/// Update face quality score.
pub fn update_face_quality(
    conn: &rusqlite::Connection,
    face_id: i64,
    quality_score: f64,
) -> AppResult<()> {
    conn.execute(
        "UPDATE face_detections SET quality_score = ?1 WHERE id = ?2",
        params![quality_score, face_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod merge_tests {
    use super::*;

    #[test]
    fn manual_face_move_remembers_both_identities() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema::CREATE_TABLES)
            .unwrap();
        for id in 1..=3i64 {
            conn.execute("INSERT INTO photos (id,path,filename,file_size,file_mtime,imported_at) VALUES (?1,?2,?2,0,0,0)", params![id, format!("/{id}.jpg")]).unwrap();
        }
        for id in [10, 11] {
            conn.execute(
                "INSERT INTO face_clusters(id,created_at) VALUES (?1,0)",
                [id],
            )
            .unwrap();
        }
        for (id, person) in [(1, 10), (2, 10), (3, 11)] {
            conn.execute("INSERT INTO face_detections(id,photo_id,person_id,embedding_path,created_at,bbox_x,bbox_y,bbox_w,bbox_h) VALUES(?1,?1,?2,?3,0,10,10,20,20)",
                params![id, person, format!("{:08x}.npy",id << 8)]).unwrap();
        }
        reassign_face_to_person(&conn, 1, 11).unwrap();
        assert_eq!(
            crate::db::constraint_dao::get_must_links(&conn).unwrap(),
            vec![(0x100, 0x300)]
        );
        assert_eq!(
            crate::db::constraint_dao::get_cannot_links(&conn).unwrap(),
            vec![(0x100, 0x200)]
        );
        prepare_face_reanalysis(&conn).unwrap();
        assert_eq!(
            get_faces_for_photo(&conn, 1).unwrap()[0]
                .embedding_path
                .as_deref(),
            Some("00000100.npy")
        );
    }

    #[test]
    fn batch_merge_named_people_removes_source_metadata_before_cluster() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema::CREATE_TABLES)
            .unwrap();
        for id in 1..=2 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at) VALUES (?1, ?2, ?3, 1, 1, 1)",
                params![id, format!("/{id}.jpg"), format!("{id}.jpg")],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO face_clusters (id, name, face_count, created_at) VALUES (?1, '同名人物', 1, 1)",
                [id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO person_metadata(person_id, user_name, confidence) VALUES(?1, '同名人物', 'high')",
                [id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO face_detections (photo_id, person_id, created_at) VALUES (?1, ?1, 1)",
                [id],
            )
            .unwrap();
        }

        merge_clusters_batch(&conn, 1, &[1, 2], Some("同名人物")).unwrap();

        let source_cluster: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM face_clusters WHERE id = 2",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let source_metadata: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM person_metadata WHERE person_id = 2",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let target_metadata: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM person_metadata WHERE person_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let target_faces: i64 = conn
            .query_row(
                "SELECT face_count FROM face_clusters WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(source_cluster, 0);
        assert_eq!(source_metadata, 0);
        assert_eq!(target_metadata, 1);
        assert_eq!(target_faces, 2);
    }

    #[test]
    fn cluster_page_filters_counts_and_limits_results() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema::CREATE_TABLES)
            .unwrap();
        for id in 1..=4 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at) VALUES (?1, ?2, ?3, 1, 1, 1)",
                params![id, format!("/{id}.jpg"), format!("{id}.jpg")],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO face_clusters (id, name, face_count, created_at) VALUES (?1, ?2, ?3, 1)",
                params![id, if id == 1 { Some("已命名") } else { None }, 5 - id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO face_detections (photo_id, person_id, created_at) VALUES (?1, ?1, 1)",
                [id],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO person_metadata(person_id, confidence) VALUES(2, 'low')",
            [],
        )
        .unwrap();

        let unnamed = get_cluster_page(&conn, "unnamed", 0, 2).unwrap();
        assert_eq!(unnamed.total, 3);
        assert_eq!(unnamed.items.len(), 2);
        assert_eq!(unnamed.named_count, 1);
        assert_eq!(unnamed.unnamed_count, 3);
        assert_eq!(unnamed.review_count, 2);
        assert_eq!(unnamed.items[0].id, Some(2));

        let second_page = get_cluster_page(&conn, "unnamed", 2, 2).unwrap();
        assert_eq!(second_page.items.len(), 1);
        assert_eq!(second_page.items[0].id, Some(4));
    }

    #[test]
    fn batch_merge_moves_faces_deletes_sources_and_names_target() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema::CREATE_TABLES)
            .unwrap();
        for id in 1..=3 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at) VALUES (?1, ?2, ?3, 1, 1, 1)",
                params![id, format!("/{id}.jpg"), format!("{id}.jpg")],
            ).unwrap();
            conn.execute(
                "INSERT INTO face_clusters (id, face_count, created_at) VALUES (?1, 1, 1)",
                params![id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO face_detections (photo_id, person_id, created_at) VALUES (?1, ?1, 1)",
                params![id],
            )
            .unwrap();
        }

        merge_clusters_batch(&conn, 1, &[1, 2, 3], Some("同一个人")).unwrap();

        let clusters: i64 = conn
            .query_row("SELECT COUNT(*) FROM face_clusters", [], |row| row.get(0))
            .unwrap();
        let faces: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM face_detections WHERE person_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let (name, count): (String, i64) = conn
            .query_row(
                "SELECT name, face_count FROM face_clusters WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(clusters, 1);
        assert_eq!(faces, 3);
        assert_eq!(name, "同一个人");
        assert_eq!(count, 3);
    }

    #[test]
    fn batch_merge_can_move_an_automatic_group_into_an_existing_named_person() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema::CREATE_TABLES)
            .unwrap();
        for id in 1..=2 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at) VALUES (?1, ?2, ?3, 1, 1, 1)",
                params![id, format!("/{id}.jpg"), format!("{id}.jpg")],
            ).unwrap();
            conn.execute(
                "INSERT INTO face_clusters (id, name, face_count, created_at) VALUES (?1, ?2, 1, 1)",
                params![id, if id == 1 { Some("已有姓名") } else { None }],
            ).unwrap();
            conn.execute(
                "INSERT INTO face_detections (photo_id, person_id, created_at) VALUES (?1, ?1, 1)",
                params![id],
            )
            .unwrap();
        }

        merge_clusters_batch(&conn, 1, &[2], None).unwrap();

        let (name, count): (String, i64) = conn
            .query_row(
                "SELECT name, face_count FROM face_clusters WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let source_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM face_clusters WHERE id = 2",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(name, "已有姓名");
        assert_eq!(count, 2);
        assert_eq!(source_exists, 0);
    }

    #[test]
    fn one_photo_face_can_be_reassigned_then_removed_without_touching_named_people() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema::CREATE_TABLES)
            .unwrap();
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at) VALUES (1, '/1.jpg', '1.jpg', 1, 1, 1)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO face_clusters (id, name, face_count, created_at) VALUES (10, '甲', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO face_clusters (id, name, face_count, created_at) VALUES (11, '乙', 0, 1)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO face_detections (id, photo_id, person_id, created_at) VALUES (100, 1, 10, 1)", []).unwrap();

        reassign_face_to_person(&conn, 100, 11).unwrap();
        let assigned: i64 = conn
            .query_row(
                "SELECT person_id FROM face_detections WHERE id = 100",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let counts: (i64, i64) = conn
            .query_row(
                "SELECT (SELECT face_count FROM face_clusters WHERE id = 10),
                    (SELECT face_count FROM face_clusters WHERE id = 11)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(assigned, 11);
        assert_eq!(counts, (0, 1));

        delete_face_detection(&conn, 100).unwrap();
        let remaining_faces: i64 = conn
            .query_row("SELECT COUNT(*) FROM face_detections", [], |row| row.get(0))
            .unwrap();
        let named_people: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM face_clusters WHERE id IN (10, 11)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining_faces, 0);
        assert_eq!(named_people, 2);
    }

    #[test]
    fn one_photo_face_can_create_a_new_named_person() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema::CREATE_TABLES)
            .unwrap();
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at) VALUES (1, '/1.jpg', '1.jpg', 1, 1, 1)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO face_clusters (id, face_count, created_at) VALUES (10, 1, 1)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO face_detections (id, photo_id, person_id, created_at) VALUES (100, 1, 10, 1)", []).unwrap();

        let new_id = create_named_person_for_face(&conn, 100, " 新人物 ").unwrap();
        let (name, count): (String, i64) = conn
            .query_row(
                "SELECT name, face_count FROM face_clusters WHERE id = ?1",
                [new_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let assigned: i64 = conn
            .query_row(
                "SELECT person_id FROM face_detections WHERE id = 100",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let old_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM face_clusters WHERE id = 10",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(name, "新人物");
        assert_eq!(count, 1);
        assert_eq!(assigned, new_id);
        assert_eq!(old_exists, 0);
    }

    #[test]
    fn removing_the_last_false_positive_cleans_up_an_empty_automatic_person() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema::CREATE_TABLES)
            .unwrap();
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at) VALUES (1, '/1.jpg', '1.jpg', 1, 1, 1)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO face_clusters (id, face_count, created_at) VALUES (10, 1, 1)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO face_detections (id, photo_id, person_id, created_at) VALUES (100, 1, 10, 1)", []).unwrap();

        delete_face_detection(&conn, 100).unwrap();

        let automatic_people: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM face_clusters WHERE id = 10",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(automatic_people, 0);
    }

    #[test]
    fn automatic_cluster_reset_preserves_named_people() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema::CREATE_TABLES)
            .unwrap();
        for id in 1..=2 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at) VALUES (?1, ?2, ?3, 1, 1, 1)",
                params![id, format!("/{id}.jpg"), format!("{id}.jpg")],
            ).unwrap();
        }
        conn.execute(
            "INSERT INTO face_clusters (id, name, face_count, created_at) VALUES (10, NULL, 1, 1)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO face_clusters (id, name, face_count, created_at) VALUES (11, '家人', 1, 1)", []).unwrap();
        conn.execute(
            "INSERT INTO face_detections (photo_id, person_id, created_at) VALUES (1, 10, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO face_detections (photo_id, person_id, created_at) VALUES (2, 11, 1)",
            [],
        )
        .unwrap();

        assert_eq!(reset_automatic_clusters(&conn).unwrap(), 1);
        let unnamed_person: Option<i64> = conn
            .query_row(
                "SELECT person_id FROM face_detections WHERE photo_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let named_person: Option<i64> = conn
            .query_row(
                "SELECT person_id FROM face_detections WHERE photo_id = 2",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unnamed_person, None);
        assert_eq!(named_person, Some(11));
    }

    #[test]
    fn confirming_a_person_removes_it_from_low_confidence_review() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema::CREATE_TABLES)
            .unwrap();
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at) VALUES (1, '/1.jpg', '1.jpg', 1, 1, 1)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO face_clusters (id, face_count, created_at) VALUES (10, 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO face_detections (photo_id, person_id, created_at) VALUES (1, 10, 1)",
            [],
        )
        .unwrap();

        assert_eq!(get_all_clusters(&conn).unwrap()[0].confidence, "low");
        set_cluster_confidence(&conn, 10, "high").unwrap();
        assert_eq!(get_all_clusters(&conn).unwrap()[0].confidence, "high");
    }

    #[test]
    fn automatic_merge_candidates_exclude_all_named_people() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema::CREATE_TABLES)
            .unwrap();
        for id in 1..=3 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at) VALUES (?1, ?2, ?3, 1, 1, 1)",
                params![id, format!("/{id}.jpg"), format!("{id}.jpg")],
            ).unwrap();
            conn.execute(
                "INSERT INTO face_clusters (id, name, face_count, created_at) VALUES (?1, ?2, 1, 1)",
                params![id, if id == 2 { Some("数据库姓名") } else { None }],
            ).unwrap();
            conn.execute(
                "INSERT INTO face_detections (photo_id, person_id, embedding_path, created_at) VALUES (?1, ?1, ?2, 1)",
                params![id, format!("{id:08x}.npy")],
            ).unwrap();
        }
        conn.execute(
            "INSERT INTO person_metadata (person_id, user_name) VALUES (3, '元数据姓名')",
            [],
        )
        .unwrap();

        let candidates = get_unnamed_embedding_cluster_assignments(&conn).unwrap();
        assert_eq!(candidates, vec![("00000001.npy".to_string(), 1)]);
        assert!(clusters_are_unnamed(&conn, &[1]).unwrap());
        assert!(!clusters_are_unnamed(&conn, &[1, 2]).unwrap());
        assert!(!clusters_are_unnamed(&conn, &[3]).unwrap());
    }

    #[test]
    fn automatic_merge_can_be_undone_exactly() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema::CREATE_TABLES)
            .unwrap();
        for id in 1..=3 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at) VALUES (?1, ?2, ?3, 1, 1, 1)",
                params![id, format!("/{id}.jpg"), format!("{id}.jpg")],
            ).unwrap();
            conn.execute(
                "INSERT INTO face_clusters (id, face_count, created_at) VALUES (?1, 1, 1)",
                [id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO face_detections (id, photo_id, person_id, created_at) VALUES (?1, ?1, ?1, 1)",
                [id],
            ).unwrap();
        }

        let (_, merged, removed) =
            apply_automatic_merge_groups(&conn, &[vec![1, 2, 3]], 0.72).unwrap();
        assert_eq!((merged, removed), (1, 2));
        assert!(has_automatic_merge_to_undo(&conn).unwrap());
        let people_after_merge: i64 = conn
            .query_row("SELECT COUNT(*) FROM face_clusters", [], |row| row.get(0))
            .unwrap();
        assert_eq!(people_after_merge, 1);

        let (restored_people, restored_faces) = undo_last_automatic_merge(&conn).unwrap().unwrap();
        assert_eq!((restored_people, restored_faces), (3, 3));
        let restored: Vec<(i64, i64)> = {
            let mut stmt = conn
                .prepare("SELECT id, person_id FROM face_detections ORDER BY id")
                .unwrap();
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(restored, vec![(1, 1), (2, 2), (3, 3)]);
        assert!(!has_automatic_merge_to_undo(&conn).unwrap());
    }

    #[test]
    fn face_reanalysis_preserves_names_from_both_metadata_locations() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema::CREATE_TABLES)
            .unwrap();
        for id in 1..=3 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, face_status, imported_at) VALUES (?1, ?2, ?3, 1, 1, 1, 1)",
                params![id, format!("/{id}.jpg"), format!("{id}.jpg")],
            ).unwrap();
            conn.execute(
                "INSERT INTO face_clusters (id, name, face_count, created_at) VALUES (?1, ?2, 1, 1)",
                params![id, if id == 1 { Some("主表姓名") } else { None }],
            ).unwrap();
            conn.execute(
                "INSERT INTO face_detections (id, photo_id, person_id, created_at) VALUES (?1, ?1, ?1, 1)",
                [id],
            ).unwrap();
        }
        conn.execute(
            "INSERT INTO person_metadata (person_id, user_name) VALUES (2, '元数据姓名')",
            [],
        )
        .unwrap();

        assert_eq!(prepare_face_reanalysis(&conn).unwrap(), 1);
        let remaining: Vec<i64> = {
            let mut stmt = conn
                .prepare("SELECT id FROM face_clusters ORDER BY id")
                .unwrap();
            stmt.query_map([], |row| row.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(remaining, vec![1, 2]);
        let remaining_faces: i64 = conn
            .query_row("SELECT COUNT(*) FROM face_detections", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining_faces, 2);
    }

    #[test]
    fn ignored_automatic_people_stay_ignored_across_reanalysis() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema::CREATE_TABLES)
            .unwrap();
        for id in 1..=2 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at) VALUES (?1, ?2, ?3, 1, 1, 1)",
                params![id, format!("/{id}.jpg"), format!("{id}.jpg")],
            ).unwrap();
            conn.execute(
                "INSERT INTO face_clusters (id, name, face_count, created_at) VALUES (?1, ?2, 1, 1)",
                params![id, if id == 2 { Some("已命名") } else { None }],
            ).unwrap();
            conn.execute(
                "INSERT INTO face_detections (id, photo_id, person_id, review_status, created_at) VALUES (?1, ?1, ?1, 'active', 1)",
                [id],
            ).unwrap();
        }

        assert_eq!(ignore_automatic_clusters(&conn, &[1]).unwrap(), (1, 1));
        let ignored: (Option<i64>, String) = conn
            .query_row(
                "SELECT person_id, review_status FROM face_detections WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(ignored, (None, "ignored".into()));
        assert_eq!(get_ignored_face_count(&conn).unwrap(), 1);
        assert!(ignore_automatic_clusters(&conn, &[2]).is_err());

        prepare_face_reanalysis(&conn).unwrap();
        assert_eq!(get_ignored_face_count(&conn).unwrap(), 1);
        assert_eq!(restore_all_ignored_faces(&conn).unwrap(), 1);
        assert_eq!(get_ignored_face_count(&conn).unwrap(), 0);
    }
}

/// Get person details.
pub fn get_person_details(
    conn: &rusqlite::Connection,
    person_id: i64,
) -> AppResult<Option<crate::models::PersonDetail>> {
    let mut stmt = conn.prepare(
        "SELECT
            fc.id as person_id,
            fc.name as user_name,
            fc.face_count,
            COALESCE(pm.confidence, 'medium') as confidence,
            MIN(p.taken_at) as first_seen,
            MAX(p.taken_at) as last_seen,
            (SELECT fd2.photo_id FROM face_detections fd2
             WHERE fd2.person_id = fc.id AND fd2.quality_score = (
                 SELECT MAX(quality_score) FROM face_detections WHERE person_id = fc.id
             )
             LIMIT 1) as cover_photo_id
         FROM face_clusters fc
         LEFT JOIN person_metadata pm ON pm.person_id = fc.id
         LEFT JOIN face_detections fd ON fd.person_id = fc.id
         LEFT JOIN photos p ON p.id = fd.photo_id
         WHERE fc.id = ?1
         GROUP BY fc.id",
    )?;

    use rusqlite::OptionalExtension;
    let result = stmt
        .query_row([person_id], |row| {
            Ok(crate::models::PersonDetail {
                person_id: row.get(0)?,
                user_name: row.get(1)?,
                face_count: row.get(2)?,
                confidence: row.get(3)?,
                first_seen: row.get(4)?,
                last_seen: row.get(5)?,
                cover_photo_id: row.get(6)?,
            })
        })
        .optional()?;

    Ok(result)
}

/// Get person timeline: (year_month, count) tuples.
pub fn get_person_timeline(
    conn: &rusqlite::Connection,
    person_id: i64,
) -> AppResult<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT
            strftime('%Y-%m', COALESCE(p.taken_at, p.file_mtime)) as month,
            COUNT(*) as cnt
         FROM face_detections fd
         JOIN photos p ON p.id = fd.photo_id
         WHERE fd.person_id = ?1 AND p.deleted = 0
         GROUP BY month
         ORDER BY month DESC",
    )?;

    let rows = stmt.query_map([person_id], |row| Ok((row.get(0)?, row.get(1)?)))?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
}

/// Get top scene tags for a person's photos.
pub fn get_person_scene_tags(
    conn: &rusqlite::Connection,
    person_id: i64,
) -> AppResult<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT
            ac.label,
            COUNT(*) as cnt
         FROM face_detections fd
         JOIN ai_classifications ac ON ac.photo_id = fd.photo_id
         WHERE fd.person_id = ?1 AND ac.tag_type = 'ai_scene'
         GROUP BY ac.label
         ORDER BY cnt DESC
         LIMIT 10",
    )?;

    let rows = stmt.query_map([person_id], |row| Ok((row.get(0)?, row.get(1)?)))?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
}

/// Set person name.
pub fn set_person_name(conn: &rusqlite::Connection, person_id: i64, name: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE face_clusters SET name = ?1 WHERE id = ?2",
        params![name, person_id],
    )?;
    Ok(())
}

/// Get all named persons (face_clusters with a non-null name).
pub fn get_named_persons(conn: &rusqlite::Connection) -> AppResult<Vec<(i64, String)>> {
    let mut stmt = conn.prepare(
        "SELECT fc.id, fc.name FROM face_clusters fc WHERE fc.name IS NOT NULL AND fc.name != '' ORDER BY fc.name"
    )?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
}

/// Get all photo_ids for a given person_id.
pub fn get_person_photo_ids(conn: &rusqlite::Connection, person_id: i64) -> AppResult<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT fd.photo_id FROM face_detections fd JOIN photos p ON p.id = fd.photo_id WHERE fd.person_id = ?1 AND p.deleted = 0 ORDER BY p.taken_at DESC"
    )?;
    let rows = stmt.query_map([person_id], |row| row.get(0))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
}

/// Get total face detection count.
pub fn get_face_detection_count(conn: &rusqlite::Connection) -> AppResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM face_detections fd JOIN photos p ON p.id = fd.photo_id
         WHERE p.deleted = 0 AND COALESCE(fd.review_status, 'active') = 'active'",
        [],
        |row| row.get(0),
    )
    .map_err(|e| e.into())
}

/// Get count of unassigned faces (detected but not yet clustered).
pub fn get_unassigned_face_count(conn: &rusqlite::Connection) -> AppResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM face_detections fd JOIN photos p ON p.id = fd.photo_id
         WHERE fd.person_id IS NULL AND p.deleted = 0
           AND COALESCE(fd.review_status, 'active') = 'active'",
        [],
        |row| row.get(0),
    )
    .map_err(|e| e.into())
}

/// Split: move specified faces to a new cluster.
pub fn split_person(
    conn: &rusqlite::Connection,
    person_id: i64,
    face_ids: &[i64],
) -> AppResult<i64> {
    let tx = conn.unchecked_transaction()?;
    let selected: std::collections::HashSet<_> = face_ids.iter().copied().collect();
    let mut stmt = tx.prepare(
        "SELECT id FROM face_detections WHERE person_id=?1 ORDER BY quality_score DESC,id",
    )?;
    let ids = stmt
        .query_map([person_id], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    if selected.is_empty()
        || !selected.iter().all(|id| ids.contains(id))
        || selected.len() == ids.len()
    {
        return Err(crate::error::AppError::Project(
            "请选择此人物分组中的部分人脸".into(),
        ));
    }
    let retained = ids.into_iter().find(|id| !selected.contains(id));
    let retained_key = match retained {
        Some(id) => face_embedding_key(&tx, id)?,
        None => None,
    };
    let new_cluster_id = create_cluster(&tx)?;
    for face_id in face_ids {
        if let (Some(key), Some(other)) = (face_embedding_key(&tx, *face_id)?, retained_key) {
            crate::db::constraint_dao::set_constraint_by_face_keys(&tx, key, other, "cannot_link")?;
        }
        assign_face_to_person(&tx, *face_id, Some(new_cluster_id))?;
    }
    set_cluster_confidence(&tx, new_cluster_id, "high")?;
    update_cluster_face_counts(&tx)?;
    tx.commit()?;
    Ok(new_cluster_id)
}
