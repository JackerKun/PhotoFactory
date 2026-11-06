use chrono::{DateTime, Datelike, Local, Timelike};
use rusqlite::Connection;

use crate::db::classification_dao::insert_classification_with_type;
use crate::error::{AppError, AppResult};
use crate::models::AiClassification;

/// Time period labels based on hour of day.
fn time_period_label(hour: u32) -> &'static str {
    match hour {
        5..=7 => "清晨",
        8..=10 => "上午",
        11..=13 => "午后",
        14..=16 => "下午",
        17..=18 => "傍晚",
        19..=20 => "黄昏",
        _ => "夜晚",
    }
}

/// Season label based on month.
fn season_label(month: u32) -> &'static str {
    match month {
        3..=5 => "春天",
        6..=8 => "夏天",
        9..=11 => "秋天",
        _ => "冬天",
    }
}

/// Run time period tagging based on hour of day.
pub fn run_time_period_tagging(conn: &Connection, batch_size: usize) -> AppResult<usize> {
    let query = "
        SELECT id, taken_at FROM photos
        WHERE taken_at IS NOT NULL
          AND deleted = 0
          AND id NOT IN (
              SELECT photo_id FROM ai_classifications WHERE tag_type = 'rule_time_period'
          )
        LIMIT ?
    ";

    let mut stmt = conn
        .prepare(query)
        .map_err(|e| AppError::Internal(format!("Failed to prepare query: {}", e)))?;

    let rows: Vec<(i64, i64)> = stmt
        .query_map([batch_size as i64], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| AppError::Internal(format!("Failed to query photos: {}", e)))?
        .filter_map(|r| r.ok())
        .collect();

    let mut tagged = 0;
    for (photo_id, timestamp) in rows {
        let dt = DateTime::from_timestamp(timestamp, 0)
            .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap())
            .with_timezone(&Local);

        let label = time_period_label(dt.hour());
        let classification = AiClassification {
            id: None,
            photo_id,
            category: "rule".into(),
            label: label.to_string(),
            confidence: 1.0,
        };
        if insert_classification_with_type(conn, &classification, "rule_time_period").is_ok() {
            tagged += 1;
        }
    }

    Ok(tagged)
}

/// Run season tagging based on month.
pub fn run_season_tagging(conn: &Connection, batch_size: usize) -> AppResult<usize> {
    let query = "
        SELECT id, taken_at FROM photos
        WHERE taken_at IS NOT NULL
          AND deleted = 0
          AND id NOT IN (
              SELECT photo_id FROM ai_classifications WHERE tag_type = 'rule_season'
          )
        LIMIT ?
    ";

    let mut stmt = conn
        .prepare(query)
        .map_err(|e| AppError::Internal(format!("Failed to prepare query: {}", e)))?;

    let rows: Vec<(i64, i64)> = stmt
        .query_map([batch_size as i64], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| AppError::Internal(format!("Failed to query photos: {}", e)))?
        .filter_map(|r| r.ok())
        .collect();

    let mut tagged = 0;
    for (photo_id, timestamp) in rows {
        let dt = DateTime::from_timestamp(timestamp, 0)
            .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap())
            .with_timezone(&Local);

        let label = season_label(dt.month());
        let classification = AiClassification {
            id: None,
            photo_id,
            category: "rule".into(),
            label: label.to_string(),
            confidence: 1.0,
        };
        if insert_classification_with_type(conn, &classification, "rule_season").is_ok() {
            tagged += 1;
        }
    }

    Ok(tagged)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_time_period_labels() {
        assert_eq!("清晨", time_period_label(6));
        assert_eq!("上午", time_period_label(9));
        assert_eq!("午后", time_period_label(12));
        assert_eq!("下午", time_period_label(15));
        assert_eq!("傍晚", time_period_label(17));
        assert_eq!("黄昏", time_period_label(19));
        assert_eq!("夜晚", time_period_label(23));
        assert_eq!("夜晚", time_period_label(3));
    }

    #[test]
    fn test_season_labels() {
        assert_eq!("春天", season_label(4));
        assert_eq!("夏天", season_label(7));
        assert_eq!("秋天", season_label(10));
        assert_eq!("冬天", season_label(1));
        assert_eq!("冬天", season_label(12));
    }
}
