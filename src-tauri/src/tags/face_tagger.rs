use rusqlite::Connection;

use crate::db::classification_dao::insert_classification_with_type;
use crate::error::{AppError, AppResult};
use crate::models::AiClassification;

/// Run face-count based tagging on photos that have face detections but no face_count tag.
///
/// Rules:
/// - 1 face -> "单人"
/// - 2 faces -> "双人"
/// - >=3 faces -> "合影"
pub fn run_face_tagging(conn: &Connection, batch_size: usize) -> AppResult<usize> {
    let query = "
        SELECT fd.photo_id, COUNT(*) as face_count
        FROM face_detections fd
        JOIN photos p ON p.id = fd.photo_id
        WHERE p.deleted = 0
          AND fd.photo_id NOT IN (
              SELECT photo_id FROM ai_classifications WHERE tag_type = 'rule_face_count'
          )
        GROUP BY fd.photo_id
        LIMIT ?
    ";

    let mut stmt = conn
        .prepare(query)
        .map_err(|e| AppError::Internal(format!("Failed to prepare face count query: {}", e)))?;

    let rows: Vec<(i64, i64)> = stmt
        .query_map([batch_size as i64], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| AppError::Internal(format!("Failed to query face counts: {}", e)))?
        .filter_map(|r| r.ok())
        .collect();

    let mut tagged = 0;
    for (photo_id, count) in rows {
        let label = match count {
            1 => "单人",
            2 => "双人",
            _ => "合影",
        };

        let classification = AiClassification {
            id: None,
            photo_id,
            category: "rule".into(),
            label: label.to_string(),
            confidence: 1.0,
        };
        if insert_classification_with_type(conn, &classification, "rule_face_count").is_ok() {
            tagged += 1;
        }
    }

    Ok(tagged)
}
