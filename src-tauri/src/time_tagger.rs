// src-tauri/src/time_tagger.rs
//
// Time-based tagging module.
// Generates tags from photo timestamps: year, season, and holidays.

use chrono::{DateTime, Datelike, NaiveDate, Utc};
use rusqlite::Connection;
use std::collections::HashMap;

use crate::db::classification_dao::insert_classification_with_type;
use crate::error::{AppError, AppResult};
use crate::models::AiClassification;

/// Run time-based tagging on photos that have a timestamp but no time_period tag.
///
/// Queries photos where COALESCE(taken_at, file_mtime) IS NOT NULL and
/// tag_type != 'time_period', generates time tags (year+season, holiday),
/// and inserts them into ai_classifications.
///
/// Returns the number of photos successfully tagged.
pub fn run_time_tagging(conn: &Connection, batch_size: usize) -> AppResult<usize> {
    let query = "
        SELECT id, COALESCE(taken_at, file_mtime) AS ts FROM photos
        WHERE COALESCE(taken_at, file_mtime) IS NOT NULL
          AND deleted = 0
          AND id NOT IN (
            SELECT photo_id FROM ai_classifications WHERE tag_type = 'time_period'
          )
        LIMIT ?
    ";

    let mut stmt = conn
        .prepare(query)
        .map_err(|e| AppError::Internal(format!("Failed to prepare photo query: {}", e)))?;

    let rows: Vec<(i64, i64)> = stmt
        .query_map([batch_size as i64], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| AppError::Internal(format!("Failed to query photos: {}", e)))?
        .filter_map(|r| r.ok())
        .collect();

    let mut tagged = 0;

    for (photo_id, timestamp) in rows {
        let time_tags = generate_time_tags(timestamp);
        if time_tags.is_empty() {
            continue;
        }

        // Insert the primary time tag (first one = year+season)
        if let Some((label, _confidence)) = time_tags.first() {
            let classification = AiClassification {
                id: None,
                photo_id,
                category: "time".into(),
                label: label.clone(),
                confidence: 1.0,
            };
            if insert_classification_with_type(conn, &classification, "time_period").is_ok() {
                tagged += 1;
            }
        }

        // Insert holiday tag if applicable
        for (label, _confidence) in time_tags.iter().skip(1) {
            let classification = AiClassification {
                id: None,
                photo_id,
                category: "time".into(),
                label: label.clone(),
                confidence: 1.0,
            };
            let _ = insert_classification_with_type(conn, &classification, "time_period");
        }
    }

    Ok(tagged)
}

/// Generate time-based tags from a Unix timestamp.
///
/// Returns a Vec of (label, confidence) tuples.
/// - First element is always "YYYY年Season" (e.g., "2024年夏")
/// - Subsequent elements (if any) are holiday names
pub fn generate_time_tags(timestamp: i64) -> Vec<(String, f64)> {
    let dt: DateTime<Utc> = DateTime::from_timestamp(timestamp, 0)
        .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap());

    let year = dt.year();
    let month = dt.month();
    let day = dt.day();

    let season = month_to_season(month);
    let year_season = format!("{}年{}", year, season);

    let mut tags = vec![(year_season, 1.0)];

    if let Some(holiday) = check_holiday(month, day) {
        tags.push((holiday.to_string(), 1.0));
    }

    tags
}

/// Convert a month number (1-12) to a Chinese season character.
///
/// - March(3) to May(5): 春 (spring)
/// - June(6) to August(8): 夏 (summer)
/// - September(9) to November(11): 秋 (autumn)
/// - December(12) to February(2): 冬 (winter)
fn month_to_season(month: u32) -> &'static str {
    match month {
        3..=5 => "春",
        6..=8 => "夏",
        9..=11 => "秋",
        12 | 1 | 2 => "冬",
        _ => "春",
    }
}

/// Check if a given month-day corresponds to a known holiday.
///
/// Checks fixed Chinese/international holidays by MM-DD.
/// Returns the Chinese holiday name, or None if no match.
pub fn check_holiday(month: u32, day: u32) -> Option<&'static str> {
    match (month, day) {
        // 元旦 - New Year's Day
        (1, 1) => Some("元旦"),
        // 情人节 - Valentine's Day
        (2, 14) => Some("情人节"),
        // 妇女节 - Women's Day
        (3, 8) => Some("妇女节"),
        // 清明 - Qingming Festival (approximate fixed date)
        (4, 5) => Some("清明"),
        // 五一 - Labor Day (range May 1-3)
        (5, 1..=3) => Some("五一"),
        // 儿童节 - Children's Day
        (6, 1) => Some("儿童节"),
        // 端午 - Dragon Boat Festival (approximate range June 10-14)
        (6, 10..=14) => Some("端午"),
        // 建军节 - Army Day
        (8, 1) => Some("建军节"),
        // 教师节 - Teachers' Day
        (9, 10) => Some("教师节"),
        // 国庆 - National Day (range Sep 28 - Oct 7)
        (9, 28..=30) => Some("国庆"),
        (10, 1..=7) => Some("国庆"),
        // 万圣节 - Halloween
        (10, 31) => Some("万圣节"),
        // 圣诞 - Christmas
        (12, 25) => Some("圣诞"),
        _ => None,
    }
}

/// Calculate the absolute number of days between two date strings (format: "%Y-%m-%d").
///
/// Returns 999 if either date fails to parse.
pub fn days_between(date1: &str, date2: &str) -> i64 {
    let d1 = NaiveDate::parse_from_str(date1, "%Y-%m-%d").ok();
    let d2 = NaiveDate::parse_from_str(date2, "%Y-%m-%d").ok();

    match (d1, d2) {
        (Some(a), Some(b)) => (a - b).num_days().abs(),
        _ => 999,
    }
}

/// Run event tagging on photos that have geo_location tags.
///
/// Groups photos by geo_location and finds consecutive date clusters
/// (gap <= 2 days). Creates event tags for clusters with 2+ days
/// and 20+ total photos.
///
/// Event name format: "{location}之旅 {year}"
/// e.g., "中国·北京之旅 2024"
///
/// Returns the number of events created.
pub fn run_event_tagging(conn: &Connection) -> AppResult<usize> {
    // Query photos with geo_location tags and their dates
    let query = "
        SELECT DISTINCT p.id, ac.label,
               date(COALESCE(p.taken_at, p.file_mtime), 'unixepoch') AS photo_date
        FROM photos p
        JOIN ai_classifications ac ON p.id = ac.photo_id
        WHERE ac.tag_type = 'geo_location'
          AND p.deleted = 0
          AND COALESCE(p.taken_at, p.file_mtime) IS NOT NULL
        ORDER BY ac.label, photo_date
    ";

    let mut stmt = conn
        .prepare(query)
        .map_err(|e| AppError::Internal(format!("Failed to prepare event tagging query: {}", e)))?;

    // Collect: location -> [(photo_id, date_string)]
    let mut location_photos: HashMap<String, Vec<(i64, String)>> = HashMap::new();

    let rows: Vec<(i64, String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| {
            AppError::Internal(format!("Failed to query photos for event tagging: {}", e))
        })?
        .filter_map(|r| r.ok())
        .collect();

    for (photo_id, label, photo_date) in rows {
        location_photos
            .entry(label)
            .or_default()
            .push((photo_id, photo_date));
    }

    let mut events_created = 0;

    for (location, mut photos) in location_photos {
        // Sort by date
        photos.sort_by(|a, b| a.1.cmp(&b.1));

        // Get distinct dates
        let distinct_dates: Vec<String> = {
            let mut seen = Vec::new();
            for (_, date) in &photos {
                if seen.is_empty() || seen.last() != Some(date) {
                    seen.push(date.clone());
                }
            }
            seen
        };

        // Find consecutive date clusters (gap <= 2 days)
        let clusters = find_consecutive_clusters(&distinct_dates);

        for (cluster_start, cluster_end) in clusters {
            let days_in_cluster = days_between(&cluster_start, &cluster_end) + 1;
            if days_in_cluster < 2 {
                continue; // Need 2+ days
            }

            // Count total photos in this date range
            let photo_count: i64 = photos
                .iter()
                .filter(|(_, d)| d >= &cluster_start && d <= &cluster_end)
                .count() as i64;

            if photo_count < 20 {
                continue; // Need 20+ photos
            }

            // Create event name: "{location}之旅 {year}"
            // Use the year from the cluster start date
            let event_name = format_event_name(&location, &cluster_start);

            // Insert event tag for all photos in the date range using BETWEEN
            let insert_sql = "
                INSERT OR REPLACE INTO ai_classifications
                    (photo_id, category, label, confidence, tag_type)
                SELECT p.id, 'event', ?1, 1.0, 'event'
                FROM photos p
                JOIN ai_classifications ac ON p.id = ac.photo_id
                WHERE ac.tag_type = 'geo_location'
                  AND ac.label = ?2
                  AND p.deleted = 0
                  AND COALESCE(p.taken_at, p.file_mtime) IS NOT NULL
                  AND date(COALESCE(p.taken_at, p.file_mtime), 'unixepoch') BETWEEN ?3 AND ?4
            ";

            match conn.execute(
                insert_sql,
                rusqlite::params![&event_name, &location, &cluster_start, &cluster_end],
            ) {
                Ok(count) if count > 0 => {
                    events_created += 1;
                }
                Ok(_) => {}
                Err(e) => {
                    eprintln!(
                        "Event tagging: failed to insert event '{}': {}",
                        event_name, e
                    );
                }
            }
        }
    }

    Ok(events_created)
}

/// Find clusters of consecutive dates where the gap between adjacent dates is <= 2 days.
///
/// Returns a Vec of (start_date, end_date) tuples for each cluster.
fn find_consecutive_clusters(dates: &[String]) -> Vec<(String, String)> {
    if dates.is_empty() {
        return vec![];
    }

    let mut clusters = Vec::new();
    let mut cluster_start = dates[0].clone();
    let mut prev_date = dates[0].clone();

    for date in dates.iter().skip(1) {
        let gap = days_between(&prev_date, date);
        if gap <= 2 {
            // Extend current cluster
            prev_date = date.clone();
        } else {
            // Close current cluster and start a new one
            clusters.push((cluster_start, prev_date));
            cluster_start = date.clone();
            prev_date = date.clone();
        }
    }

    // Don't forget the last cluster
    clusters.push((cluster_start, prev_date));

    clusters
}

/// Format an event name from location and start date.
///
/// Format: "{location}之旅 {year}"
fn format_event_name(location: &str, start_date: &str) -> String {
    // Extract year from the start date
    let year = if let Ok(d) = NaiveDate::parse_from_str(start_date, "%Y-%m-%d") {
        d.year()
    } else {
        2024 // fallback
    };
    format!("{}之旅 {}", location, year)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    // --- month_to_season tests ---

    #[test]
    fn test_spring_months() {
        assert_eq!(month_to_season(3), "春");
        assert_eq!(month_to_season(4), "春");
        assert_eq!(month_to_season(5), "春");
    }

    #[test]
    fn test_summer_months() {
        assert_eq!(month_to_season(6), "夏");
        assert_eq!(month_to_season(7), "夏");
        assert_eq!(month_to_season(8), "夏");
    }

    #[test]
    fn test_autumn_months() {
        assert_eq!(month_to_season(9), "秋");
        assert_eq!(month_to_season(10), "秋");
        assert_eq!(month_to_season(11), "秋");
    }

    #[test]
    fn test_winter_months() {
        assert_eq!(month_to_season(12), "冬");
        assert_eq!(month_to_season(1), "冬");
        assert_eq!(month_to_season(2), "冬");
    }

    // --- generate_time_tags tests ---

    #[test]
    fn test_generate_time_tags_summer() {
        // 2024-07-15 12:00:00 UTC
        let ts = Utc
            .with_ymd_and_hms(2024, 7, 15, 12, 0, 0)
            .unwrap()
            .timestamp();
        let tags = generate_time_tags(ts);
        assert_eq!(tags[0].0, "2024年夏");
        assert_eq!(tags[0].1, 1.0);
        assert_eq!(tags.len(), 1); // No holiday in mid-July
    }

    #[test]
    fn test_generate_time_tags_spring() {
        // 2024-04-10
        let ts = Utc
            .with_ymd_and_hms(2024, 4, 10, 8, 0, 0)
            .unwrap()
            .timestamp();
        let tags = generate_time_tags(ts);
        assert_eq!(tags[0].0, "2024年春");
        assert_eq!(tags.len(), 1);
    }

    #[test]
    fn test_generate_time_tags_winter() {
        // 2024-01-05
        let ts = Utc
            .with_ymd_and_hms(2024, 1, 5, 10, 0, 0)
            .unwrap()
            .timestamp();
        let tags = generate_time_tags(ts);
        assert_eq!(tags[0].0, "2024年冬");
    }

    #[test]
    fn test_generate_time_tags_autumn() {
        // 2024-10-01 (National Day + autumn)
        let ts = Utc
            .with_ymd_and_hms(2024, 10, 1, 10, 0, 0)
            .unwrap()
            .timestamp();
        let tags = generate_time_tags(ts);
        assert_eq!(tags[0].0, "2024年秋");
        assert_eq!(tags[1].0, "国庆");
        assert_eq!(tags.len(), 2);
    }

    #[test]
    fn test_generate_time_tags_christmas() {
        // 2023-12-25
        let ts = Utc
            .with_ymd_and_hms(2023, 12, 25, 18, 0, 0)
            .unwrap()
            .timestamp();
        let tags = generate_time_tags(ts);
        assert_eq!(tags[0].0, "2023年冬");
        assert_eq!(tags[1].0, "圣诞");
        assert_eq!(tags.len(), 2);
    }

    #[test]
    fn test_generate_time_tags_new_year() {
        // 2024-01-01
        let ts = Utc
            .with_ymd_and_hms(2024, 1, 1, 0, 0, 0)
            .unwrap()
            .timestamp();
        let tags = generate_time_tags(ts);
        assert_eq!(tags[0].0, "2024年冬");
        assert_eq!(tags[1].0, "元旦");
        assert_eq!(tags.len(), 2);
    }

    // --- check_holiday tests ---

    #[test]
    fn test_check_holiday_fixed_dates() {
        assert_eq!(check_holiday(1, 1), Some("元旦"));
        assert_eq!(check_holiday(2, 14), Some("情人节"));
        assert_eq!(check_holiday(3, 8), Some("妇女节"));
        assert_eq!(check_holiday(4, 5), Some("清明"));
        assert_eq!(check_holiday(6, 1), Some("儿童节"));
        assert_eq!(check_holiday(8, 1), Some("建军节"));
        assert_eq!(check_holiday(9, 10), Some("教师节"));
        assert_eq!(check_holiday(10, 31), Some("万圣节"));
        assert_eq!(check_holiday(12, 25), Some("圣诞"));
    }

    #[test]
    fn test_check_holiday_labor_day_range() {
        assert_eq!(check_holiday(5, 1), Some("五一"));
        assert_eq!(check_holiday(5, 2), Some("五一"));
        assert_eq!(check_holiday(5, 3), Some("五一"));
        assert_eq!(check_holiday(5, 4), None);
    }

    #[test]
    fn test_check_holiday_dragon_boat_range() {
        assert_eq!(check_holiday(6, 9), None);
        assert_eq!(check_holiday(6, 10), Some("端午"));
        assert_eq!(check_holiday(6, 12), Some("端午"));
        assert_eq!(check_holiday(6, 14), Some("端午"));
        assert_eq!(check_holiday(6, 15), None);
    }

    #[test]
    fn test_check_holiday_national_day_range() {
        assert_eq!(check_holiday(9, 27), None);
        assert_eq!(check_holiday(9, 28), Some("国庆"));
        assert_eq!(check_holiday(9, 30), Some("国庆"));
        assert_eq!(check_holiday(10, 1), Some("国庆"));
        assert_eq!(check_holiday(10, 7), Some("国庆"));
        assert_eq!(check_holiday(10, 8), None);
    }

    #[test]
    fn test_check_holiday_no_match() {
        assert_eq!(check_holiday(3, 15), None);
        assert_eq!(check_holiday(7, 20), None);
        assert_eq!(check_holiday(11, 11), None);
    }

    // --- Database integration tests ---

    fn new_in_memory_db_with_time_data() -> Connection {
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
    fn test_run_time_tagging_query_selects_correct_photos() {
        let conn = new_in_memory_db_with_time_data();

        // Photo 1: has taken_at, no tag
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at)
             VALUES (1, '/p1.jpg', 'p1.jpg', 1000, 0, 1719748800, 0)",
            [],
        )
        .unwrap();

        // Photo 2: no taken_at, has file_mtime, no tag
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at)
             VALUES (2, '/p2.jpg', 'p2.jpg', 1000, 1719748800, NULL, 0)",
            [],
        )
        .unwrap();

        // Photo 3: already has time_period tag
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at)
             VALUES (3, '/p3.jpg', 'p3.jpg', 1000, 1719748800, 1719748800, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ai_classifications (photo_id, category, label, confidence, tag_type)
             VALUES (3, 'time', '2024年夏', 1.0, 'time_period')",
            [],
        )
        .unwrap();

        // Photo 4: no timestamp at all
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at)
             VALUES (4, '/p4.jpg', 'p4.jpg', 1000, NULL, NULL, 0)",
            [],
        )
        .unwrap();

        // Photo 5: deleted
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, deleted, imported_at)
             VALUES (5, '/p5.jpg', 'p5.jpg', 1000, 1719748800, 1719748800, 1, 0)",
            [],
        ).unwrap();

        // Verify query logic
        let query = "
            SELECT id, COALESCE(taken_at, file_mtime) AS ts FROM photos
            WHERE COALESCE(taken_at, file_mtime) IS NOT NULL
              AND deleted = 0
              AND id NOT IN (
                SELECT photo_id FROM ai_classifications WHERE tag_type = 'time_period'
              )
            LIMIT 100
        ";
        let mut stmt = conn.prepare(query).unwrap();
        let rows: Vec<(i64, i64)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        // Should return photos 1 and 2, but not 3 (tagged), 4 (no timestamp), or 5 (deleted)
        assert_eq!(rows.len(), 2);
        let ids: Vec<i64> = rows.iter().map(|(id, _)| *id).collect();
        assert!(ids.contains(&1));
        assert!(ids.contains(&2));
        assert!(!ids.contains(&3));
        assert!(!ids.contains(&4));
        assert!(!ids.contains(&5));
    }

    #[test]
    fn test_run_time_tagging_full_flow() {
        let conn = new_in_memory_db_with_time_data();

        // Insert a photo taken on National Day 2024
        // 2024-10-01 10:00:00 UTC = timestamp
        let ts = Utc
            .with_ymd_and_hms(2024, 10, 1, 10, 0, 0)
            .unwrap()
            .timestamp();
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at)
             VALUES (1, '/p1.jpg', 'p1.jpg', 1000, 0, ?, 0)",
            [ts],
        )
        .unwrap();

        let tagged = run_time_tagging(&conn, 100).unwrap();
        assert_eq!(tagged, 1);

        // Verify the classifications were inserted
        let mut stmt = conn
            .prepare("SELECT label FROM ai_classifications WHERE photo_id = 1 ORDER BY label")
            .unwrap();
        let labels: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        assert_eq!(labels.len(), 2);
        assert!(labels.contains(&"2024年秋".to_string()));
        assert!(labels.contains(&"国庆".to_string()));
    }

    // --- days_between tests ---

    #[test]
    fn test_days_between_same_day() {
        assert_eq!(days_between("2024-07-15", "2024-07-15"), 0);
    }

    #[test]
    fn test_days_between_one_day_apart() {
        assert_eq!(days_between("2024-07-15", "2024-07-16"), 1);
        assert_eq!(days_between("2024-07-16", "2024-07-15"), 1);
    }

    #[test]
    fn test_days_between_across_month() {
        // Jan 31 -> Feb 1 = 1 day
        assert_eq!(days_between("2024-01-31", "2024-02-01"), 1);
    }

    #[test]
    fn test_days_between_across_year() {
        // Dec 31, 2024 -> Jan 1, 2025 = 1 day
        assert_eq!(days_between("2024-12-31", "2025-01-01"), 1);
    }

    #[test]
    fn test_days_between_week_apart() {
        assert_eq!(days_between("2024-07-01", "2024-07-08"), 7);
    }

    #[test]
    fn test_days_between_two_days() {
        assert_eq!(days_between("2024-07-01", "2024-07-03"), 2);
    }

    #[test]
    fn test_days_between_invalid_dates() {
        assert_eq!(days_between("not-a-date", "2024-07-15"), 999);
        assert_eq!(days_between("2024-07-15", "not-a-date"), 999);
        assert_eq!(days_between("bad", "bad"), 999);
    }

    #[test]
    fn test_days_between_wrong_format() {
        // Valid dates but wrong format
        assert_eq!(days_between("2024/07/15", "2024-07-16"), 999);
        assert_eq!(days_between("07-15-2024", "2024-07-16"), 999);
    }

    // --- find_consecutive_clusters tests ---

    #[test]
    fn test_find_consecutive_clusters_empty() {
        let result = find_consecutive_clusters(&[]);
        assert!(result.is_empty());
    }

    #[test]
    fn test_find_consecutive_clusters_single_date() {
        let result = find_consecutive_clusters(&["2024-07-15".to_string()]);
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0],
            ("2024-07-15".to_string(), "2024-07-15".to_string())
        );
    }

    #[test]
    fn test_find_consecutive_clusters_consecutive_days() {
        let dates = vec![
            "2024-07-15".to_string(),
            "2024-07-16".to_string(),
            "2024-07-17".to_string(),
        ];
        let result = find_consecutive_clusters(&dates);
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0],
            ("2024-07-15".to_string(), "2024-07-17".to_string())
        );
    }

    #[test]
    fn test_find_consecutive_clusters_with_gap_2_days() {
        // Gap of exactly 2 days is allowed
        let dates = vec![
            "2024-07-15".to_string(),
            "2024-07-17".to_string(), // 2 day gap
        ];
        let result = find_consecutive_clusters(&dates);
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0],
            ("2024-07-15".to_string(), "2024-07-17".to_string())
        );
    }

    #[test]
    fn test_find_consecutive_clusters_gap_3_days_splits() {
        // Gap of 3 days should split
        let dates = vec![
            "2024-07-15".to_string(),
            "2024-07-18".to_string(), // 3 day gap -> split
            "2024-07-19".to_string(),
        ];
        let result = find_consecutive_clusters(&dates);
        assert_eq!(result.len(), 2);
        assert_eq!(
            result[0],
            ("2024-07-15".to_string(), "2024-07-15".to_string())
        );
        assert_eq!(
            result[1],
            ("2024-07-18".to_string(), "2024-07-19".to_string())
        );
    }

    #[test]
    fn test_find_consecutive_clusters_multiple_clusters() {
        let dates = vec![
            "2024-07-01".to_string(),
            "2024-07-02".to_string(),
            "2024-07-03".to_string(),
            "2024-07-10".to_string(), // 7 day gap
            "2024-07-11".to_string(),
            "2024-07-12".to_string(),
        ];
        let result = find_consecutive_clusters(&dates);
        assert_eq!(result.len(), 2);
        assert_eq!(
            result[0],
            ("2024-07-01".to_string(), "2024-07-03".to_string())
        );
        assert_eq!(
            result[1],
            ("2024-07-10".to_string(), "2024-07-12".to_string())
        );
    }

    #[test]
    fn test_find_consecutive_clusters_complex() {
        let dates = vec![
            "2024-07-01".to_string(),
            "2024-07-02".to_string(),
            "2024-07-04".to_string(), // 2 day gap, still consecutive
            "2024-07-07".to_string(), // 3 day gap -> split
            "2024-07-08".to_string(),
            "2024-07-15".to_string(), // 7 day gap -> split
        ];
        let result = find_consecutive_clusters(&dates);
        assert_eq!(result.len(), 3);
        assert_eq!(
            result[0],
            ("2024-07-01".to_string(), "2024-07-04".to_string())
        );
        assert_eq!(
            result[1],
            ("2024-07-07".to_string(), "2024-07-08".to_string())
        );
        assert_eq!(
            result[2],
            ("2024-07-15".to_string(), "2024-07-15".to_string())
        );
    }

    // --- format_event_name tests ---

    #[test]
    fn test_format_event_name_basic() {
        let name = format_event_name("中国·北京", "2024-07-15");
        assert_eq!(name, "中国·北京之旅 2024");
    }

    #[test]
    fn test_format_event_name_japan() {
        let name = format_event_name("日本·东京", "2024-03-20");
        assert_eq!(name, "日本·东京之旅 2024");
    }

    #[test]
    fn test_format_event_name_cross_year() {
        let name = format_event_name("澳洲·悉尼", "2024-12-31");
        assert_eq!(name, "澳洲·悉尼之旅 2024");
    }

    #[test]
    fn test_format_event_name_invalid_date() {
        let name = format_event_name("未知地点", "not-a-date");
        assert_eq!(name, "未知地点之旅 2024"); // fallback year
    }

    // --- run_event_tagging DB integration test ---

    #[test]
    fn test_run_event_tagging_creates_event() {
        let conn = new_in_memory_db_with_time_data();

        // Insert 25 photos at "中国·北京" over 3 consecutive days
        // Day 1: 2024-07-15 (10 photos)
        let day1_ts = Utc
            .with_ymd_and_hms(2024, 7, 15, 12, 0, 0)
            .unwrap()
            .timestamp();
        for i in 1..=10 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at)
                 VALUES (?, ?, ?, 1000, 0, ?, 0)",
                rusqlite::params![i, format!("/p{}.jpg", i), format!("p{}.jpg", i), day1_ts],
            ).unwrap();
            conn.execute(
                "INSERT INTO ai_classifications (photo_id, category, label, confidence, tag_type)
                 VALUES (?, 'geo', '中国·北京', 1.0, 'geo_location')",
                [i],
            )
            .unwrap();
        }

        // Day 2: 2024-07-16 (10 photos)
        let day2_ts = Utc
            .with_ymd_and_hms(2024, 7, 16, 12, 0, 0)
            .unwrap()
            .timestamp();
        for i in 11..=20 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at)
                 VALUES (?, ?, ?, 1000, 0, ?, 0)",
                rusqlite::params![i, format!("/p{}.jpg", i), format!("p{}.jpg", i), day2_ts],
            ).unwrap();
            conn.execute(
                "INSERT INTO ai_classifications (photo_id, category, label, confidence, tag_type)
                 VALUES (?, 'geo', '中国·北京', 1.0, 'geo_location')",
                [i],
            )
            .unwrap();
        }

        // Day 3: 2024-07-17 (5 photos)
        let day3_ts = Utc
            .with_ymd_and_hms(2024, 7, 17, 12, 0, 0)
            .unwrap()
            .timestamp();
        for i in 21..=25 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at)
                 VALUES (?, ?, ?, 1000, 0, ?, 0)",
                rusqlite::params![i, format!("/p{}.jpg", i), format!("p{}.jpg", i), day3_ts],
            ).unwrap();
            conn.execute(
                "INSERT INTO ai_classifications (photo_id, category, label, confidence, tag_type)
                 VALUES (?, 'geo', '中国·北京', 1.0, 'geo_location')",
                [i],
            )
            .unwrap();
        }

        let events = run_event_tagging(&conn).unwrap();
        assert_eq!(events, 1);

        // Verify the event classification was inserted
        let mut stmt = conn
            .prepare("SELECT label, tag_type, COUNT(*) FROM ai_classifications WHERE tag_type = 'event' GROUP BY label")
            .unwrap();
        let rows: Vec<(String, String, i64)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "中国·北京之旅 2024");
        assert_eq!(rows[0].1, "event");
        assert_eq!(rows[0].2, 25); // All 25 photos tagged
    }

    #[test]
    fn test_run_event_tagging_too_few_photos() {
        let conn = new_in_memory_db_with_time_data();

        // Only 10 photos over 2 days (below 20 threshold)
        let day1_ts = Utc
            .with_ymd_and_hms(2024, 7, 15, 12, 0, 0)
            .unwrap()
            .timestamp();
        for i in 1..=5 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at)
                 VALUES (?, ?, ?, 1000, 0, ?, 0)",
                rusqlite::params![i, format!("/p{}.jpg", i), format!("p{}.jpg", i), day1_ts],
            ).unwrap();
            conn.execute(
                "INSERT INTO ai_classifications (photo_id, category, label, confidence, tag_type)
                 VALUES (?, 'geo', '日本·东京', 1.0, 'geo_location')",
                [i],
            )
            .unwrap();
        }

        let day2_ts = Utc
            .with_ymd_and_hms(2024, 7, 16, 12, 0, 0)
            .unwrap()
            .timestamp();
        for i in 6..=10 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at)
                 VALUES (?, ?, ?, 1000, 0, ?, 0)",
                rusqlite::params![i, format!("/p{}.jpg", i), format!("p{}.jpg", i), day2_ts],
            ).unwrap();
            conn.execute(
                "INSERT INTO ai_classifications (photo_id, category, label, confidence, tag_type)
                 VALUES (?, 'geo', '日本·东京', 1.0, 'geo_location')",
                [i],
            )
            .unwrap();
        }

        let events = run_event_tagging(&conn).unwrap();
        assert_eq!(events, 0); // Not enough photos
    }

    #[test]
    fn test_run_event_tagging_single_day() {
        let conn = new_in_memory_db_with_time_data();

        // 25 photos but all on same day (below 2+ days threshold)
        let ts = Utc
            .with_ymd_and_hms(2024, 7, 15, 12, 0, 0)
            .unwrap()
            .timestamp();
        for i in 1..=25 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at)
                 VALUES (?, ?, ?, 1000, 0, ?, 0)",
                rusqlite::params![i, format!("/p{}.jpg", i), format!("p{}.jpg", i), ts],
            ).unwrap();
            conn.execute(
                "INSERT INTO ai_classifications (photo_id, category, label, confidence, tag_type)
                 VALUES (?, 'geo', '美国·纽约', 1.0, 'geo_location')",
                [i],
            )
            .unwrap();
        }

        let events = run_event_tagging(&conn).unwrap();
        assert_eq!(events, 0); // Only 1 day, need 2+
    }

    #[test]
    fn test_run_event_tagging_gap_too_large() {
        let conn = new_in_memory_db_with_time_data();

        // 25 photos but spread with 5-day gaps (each cluster has only 1 day)
        let day1_ts = Utc
            .with_ymd_and_hms(2024, 7, 1, 12, 0, 0)
            .unwrap()
            .timestamp();
        for i in 1..=10 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at)
                 VALUES (?, ?, ?, 1000, 0, ?, 0)",
                rusqlite::params![i, format!("/p{}.jpg", i), format!("p{}.jpg", i), day1_ts],
            ).unwrap();
            conn.execute(
                "INSERT INTO ai_classifications (photo_id, category, label, confidence, tag_type)
                 VALUES (?, 'geo', '法国·巴黎', 1.0, 'geo_location')",
                [i],
            )
            .unwrap();
        }

        let day2_ts = Utc
            .with_ymd_and_hms(2024, 7, 6, 12, 0, 0)
            .unwrap()
            .timestamp(); // 5 day gap
        for i in 11..=20 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at)
                 VALUES (?, ?, ?, 1000, 0, ?, 0)",
                rusqlite::params![i, format!("/p{}.jpg", i), format!("p{}.jpg", i), day2_ts],
            ).unwrap();
            conn.execute(
                "INSERT INTO ai_classifications (photo_id, category, label, confidence, tag_type)
                 VALUES (?, 'geo', '法国·巴黎', 1.0, 'geo_location')",
                [i],
            )
            .unwrap();
        }

        let day3_ts = Utc
            .with_ymd_and_hms(2024, 7, 11, 12, 0, 0)
            .unwrap()
            .timestamp(); // another 5 day gap
        for i in 21..=25 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at)
                 VALUES (?, ?, ?, 1000, 0, ?, 0)",
                rusqlite::params![i, format!("/p{}.jpg", i), format!("p{}.jpg", i), day3_ts],
            ).unwrap();
            conn.execute(
                "INSERT INTO ai_classifications (photo_id, category, label, confidence, tag_type)
                 VALUES (?, 'geo', '法国·巴黎', 1.0, 'geo_location')",
                [i],
            )
            .unwrap();
        }

        let events = run_event_tagging(&conn).unwrap();
        assert_eq!(events, 0); // Each cluster is only 1 day
    }

    #[test]
    fn test_run_event_tagging_multiple_events() {
        let conn = new_in_memory_db_with_time_data();

        // Location 1: "中国·北京" - 25 photos over 2 consecutive days
        let day1_ts = Utc
            .with_ymd_and_hms(2024, 7, 15, 12, 0, 0)
            .unwrap()
            .timestamp();
        for i in 1..=15 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at)
                 VALUES (?, ?, ?, 1000, 0, ?, 0)",
                rusqlite::params![i, format!("/p{}.jpg", i), format!("p{}.jpg", i), day1_ts],
            ).unwrap();
            conn.execute(
                "INSERT INTO ai_classifications (photo_id, category, label, confidence, tag_type)
                 VALUES (?, 'geo', '中国·北京', 1.0, 'geo_location')",
                [i],
            )
            .unwrap();
        }

        let day2_ts = Utc
            .with_ymd_and_hms(2024, 7, 16, 12, 0, 0)
            .unwrap()
            .timestamp();
        for i in 16..=25 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at)
                 VALUES (?, ?, ?, 1000, 0, ?, 0)",
                rusqlite::params![i, format!("/p{}.jpg", i), format!("p{}.jpg", i), day2_ts],
            ).unwrap();
            conn.execute(
                "INSERT INTO ai_classifications (photo_id, category, label, confidence, tag_type)
                 VALUES (?, 'geo', '中国·北京', 1.0, 'geo_location')",
                [i],
            )
            .unwrap();
        }

        // Location 2: "日本·东京" - 22 photos over 3 consecutive days
        let day3_ts = Utc
            .with_ymd_and_hms(2024, 8, 1, 12, 0, 0)
            .unwrap()
            .timestamp();
        for i in 26..=35 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at)
                 VALUES (?, ?, ?, 1000, 0, ?, 0)",
                rusqlite::params![i, format!("/p{}.jpg", i), format!("p{}.jpg", i), day3_ts],
            ).unwrap();
            conn.execute(
                "INSERT INTO ai_classifications (photo_id, category, label, confidence, tag_type)
                 VALUES (?, 'geo', '日本·东京', 1.0, 'geo_location')",
                [i],
            )
            .unwrap();
        }

        let day4_ts = Utc
            .with_ymd_and_hms(2024, 8, 2, 12, 0, 0)
            .unwrap()
            .timestamp();
        for i in 36..=42 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at)
                 VALUES (?, ?, ?, 1000, 0, ?, 0)",
                rusqlite::params![i, format!("/p{}.jpg", i), format!("p{}.jpg", i), day4_ts],
            ).unwrap();
            conn.execute(
                "INSERT INTO ai_classifications (photo_id, category, label, confidence, tag_type)
                 VALUES (?, 'geo', '日本·东京', 1.0, 'geo_location')",
                [i],
            )
            .unwrap();
        }

        let day5_ts = Utc
            .with_ymd_and_hms(2024, 8, 3, 12, 0, 0)
            .unwrap()
            .timestamp();
        for i in 43..=47 {
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at)
                 VALUES (?, ?, ?, 1000, 0, ?, 0)",
                rusqlite::params![i, format!("/p{}.jpg", i), format!("p{}.jpg", i), day5_ts],
            ).unwrap();
            conn.execute(
                "INSERT INTO ai_classifications (photo_id, category, label, confidence, tag_type)
                 VALUES (?, 'geo', '日本·东京', 1.0, 'geo_location')",
                [i],
            )
            .unwrap();
        }

        let events = run_event_tagging(&conn).unwrap();
        assert_eq!(events, 2);

        // Verify both events were created
        let mut stmt = conn
            .prepare("SELECT DISTINCT label FROM ai_classifications WHERE tag_type = 'event' ORDER BY label")
            .unwrap();
        let labels: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        assert_eq!(labels.len(), 2);
        assert_eq!(labels[0], "中国·北京之旅 2024");
        assert_eq!(labels[1], "日本·东京之旅 2024");
    }
}
