// src-tauri/src/geo_tagger.rs
//
// GPS reverse-geocoding module using Nominatim API.
// Converts GPS coordinates to human-readable location labels,
// with rate limiting (1 req/s) and in-memory caching.

use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::db::classification_dao::insert_classification_with_type;
use crate::error::{AppError, AppResult};
use crate::models::AiClassification;

/// Nominatim API base URL.
const NOMINATIM_URL: &str = "https://nominatim.openstreetmap.org/reverse";

/// User-Agent required by Nominatim policy.
const USER_AGENT: &str =
    "PhotoFactory/0.2.0 (Photo management app; https://github.com/photofactory)";

/// Global rate limiter: tracks the time of the last request.
static LAST_REQUEST: Mutex<Option<Instant>> = Mutex::new(None);

/// Global in-memory cache for reverse-geocoding results.
/// Key: rounded "lat,lng" string, Value: location label.
static GEO_CACHE: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// GeoTagger handles reverse-geocoding of GPS coordinates via Nominatim.
pub struct GeoTagger {
    client: reqwest::blocking::Client,
}

impl GeoTagger {
    /// Create a new GeoTagger with a blocking HTTP client.
    pub fn new() -> Self {
        Self {
            client: reqwest::blocking::Client::builder()
                .user_agent(USER_AGENT)
                .timeout(Duration::from_secs(10))
                .build()
                .expect("Failed to build HTTP client"),
        }
    }

    /// Ensure at least 1 second has elapsed since the last request.
    /// This enforces Nominatim's rate limit of 1 request per second.
    pub fn wait_for_rate_limit() {
        let mut guard = LAST_REQUEST.lock().unwrap();
        if let Some(last) = *guard {
            let elapsed = last.elapsed();
            if elapsed < Duration::from_secs(1) {
                std::thread::sleep(Duration::from_secs(1) - elapsed);
            }
        }
        *guard = Some(Instant::now());
    }

    /// Create a cache key from coordinates, rounded to 2 decimal places
    /// (~1km precision) to maximize cache reuse.
    pub fn cache_key(lat: f64, lng: f64) -> String {
        format!("{:.2},{:.2}", lat, lng)
    }

    /// Look up a location in the cache.
    fn cache_get(key: &str) -> Option<String> {
        let guard = GEO_CACHE.lock().unwrap();
        guard.get(key).cloned()
    }

    /// Store a result in the cache.
    fn cache_set(key: String, value: String) {
        let mut guard = GEO_CACHE.lock().unwrap();
        guard.insert(key, value);
    }

    /// Reverse-geocode a single coordinate pair.
    ///
    /// Calls Nominatim, parses the response, and returns a location label
    /// in the format "country·city" (middle dot), or just "country",
    /// or "未知地点" if the lookup fails.
    pub fn reverse_geocode(&self, lat: f64, lng: f64) -> AppResult<String> {
        let key = Self::cache_key(lat, lng);

        // Check cache first
        if let Some(label) = Self::cache_get(&key) {
            return Ok(label);
        }

        // Rate limit
        Self::wait_for_rate_limit();

        // Build request
        let url = format!(
            "{}?lat={}&lon={}&format=json&zoom=10&addressdetails=1",
            NOMINATIM_URL, lat, lng
        );

        let resp = self
            .client
            .get(&url)
            .send()
            .map_err(|e| AppError::Internal(format!("Nominatim request failed: {}", e)))?;

        if !resp.status().is_success() {
            return Err(AppError::Internal(format!(
                "Nominatim returned status: {}",
                resp.status()
            )));
        }

        let json: serde_json::Value = resp.json().map_err(|e| {
            AppError::Internal(format!("Failed to parse Nominatim response: {}", e))
        })?;

        let label = parse_nominatim_response(&json);

        // Store in cache
        Self::cache_set(key, label.clone());

        Ok(label)
    }

    /// Tag all photos that have GPS coordinates but no geo_location classification.
    ///
    /// Queries photos with GPS but no geo_location tag, calls reverse_geocode
    /// for each, and inserts the result into ai_classifications with
    /// tag_type='geo_location', category='geo', confidence=1.0.
    ///
    /// Returns the number of photos successfully tagged.
    pub fn tag_photos(&self, conn: &Connection, batch_size: usize) -> AppResult<usize> {
        let query = "
            SELECT id, latitude, longitude FROM photos
            WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND deleted = 0
              AND id NOT IN (
                SELECT photo_id FROM ai_classifications WHERE tag_type = 'geo_location'
              )
            LIMIT ?
        ";

        let mut stmt = conn
            .prepare(query)
            .map_err(|e| AppError::Internal(format!("Failed to prepare photo query: {}", e)))?;

        let rows: Vec<(i64, f64, f64)> = stmt
            .query_map([batch_size as i64], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|e| AppError::Internal(format!("Failed to query photos: {}", e)))?
            .filter_map(|r| r.ok())
            .collect();

        let mut tagged = 0;

        for (photo_id, lat, lng) in rows {
            match self.reverse_geocode(lat, lng) {
                Ok(label) => {
                    let classification = AiClassification {
                        id: None,
                        photo_id,
                        category: "geo".into(),
                        label,
                        confidence: 1.0,
                    };
                    if insert_classification_with_type(conn, &classification, "geo_location")
                        .is_ok()
                    {
                        tagged += 1;
                    }
                }
                Err(e) => {
                    eprintln!(
                        "GeoTagger: failed to geocode photo {} ({}, {}): {}",
                        photo_id, lat, lng, e
                    );
                }
            }
        }

        Ok(tagged)
    }
}

/// Parse a Nominatim JSON response into a human-readable location label.
///
/// Format: "country·city" (middle dot U+00B7), or just "country",
/// or "未知地点" if nothing meaningful can be extracted.
fn parse_nominatim_response(json: &serde_json::Value) -> String {
    let address = json.get("address").and_then(|a| a.as_object());
    let address = match address {
        Some(a) => a,
        None => return "未知地点".to_string(),
    };

    // Try to extract country
    let country = address
        .get("country")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string());

    // Try to extract city-level location in priority order
    let city = address
        .get("city")
        .or_else(|| address.get("town"))
        .or_else(|| address.get("village"))
        .or_else(|| address.get("county"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string());

    match (country, city) {
        (Some(c), Some(ct)) => format!("{}·{}", c, ct),
        (Some(c), None) => c,
        (None, Some(ct)) => ct,
        (None, None) => "未知地点".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_key_rounding() {
        // Same 2-decimal rounding should produce the same key
        assert_eq!(GeoTagger::cache_key(39.9042, 116.4074), "39.90,116.41");
        assert_eq!(GeoTagger::cache_key(39.9049, 116.4074), "39.90,116.41");
        assert_eq!(GeoTagger::cache_key(39.9042, 116.4079), "39.90,116.41");
        // Different rounding
        assert_eq!(GeoTagger::cache_key(39.9042, 116.4150), "39.90,116.42");
    }

    #[test]
    fn test_cache_key_negative() {
        assert_eq!(GeoTagger::cache_key(-33.8688, 151.2093), "-33.87,151.21");
    }

    #[test]
    fn test_parse_nominatim_country_and_city() {
        let json = serde_json::json!({
            "place_id": 123,
            "display_name": "Beijing, China",
            "address": {
                "country": "China",
                "city": "Beijing"
            }
        });
        assert_eq!(parse_nominatim_response(&json), "China·Beijing");
    }

    #[test]
    fn test_parse_nominatim_town_as_city() {
        let json = serde_json::json!({
            "address": {
                "country": "France",
                "town": "Versailles"
            }
        });
        assert_eq!(parse_nominatim_response(&json), "France·Versailles");
    }

    #[test]
    fn test_parse_nominatim_village_as_city() {
        let json = serde_json::json!({
            "address": {
                "country": "Japan",
                "village": "Shirakawa"
            }
        });
        assert_eq!(parse_nominatim_response(&json), "Japan·Shirakawa");
    }

    #[test]
    fn test_parse_nominatim_county_as_city() {
        let json = serde_json::json!({
            "address": {
                "country": "USA",
                "county": "Orange County"
            }
        });
        assert_eq!(parse_nominatim_response(&json), "USA·Orange County");
    }

    #[test]
    fn test_parse_nominatim_country_only() {
        let json = serde_json::json!({
            "address": {
                "country": "Australia"
            }
        });
        assert_eq!(parse_nominatim_response(&json), "Australia");
    }

    #[test]
    fn test_parse_nominatim_city_only_no_country() {
        let json = serde_json::json!({
            "address": {
                "city": "SomeCity"
            }
        });
        assert_eq!(parse_nominatim_response(&json), "SomeCity");
    }

    #[test]
    fn test_parse_nominatim_empty_response() {
        let json = serde_json::json!({});
        assert_eq!(parse_nominatim_response(&json), "未知地点");
    }

    #[test]
    fn test_parse_nominatim_no_address() {
        let json = serde_json::json!({
            "place_id": 123
        });
        assert_eq!(parse_nominatim_response(&json), "未知地点");
    }

    #[test]
    fn test_parse_nominatim_priority_city_over_town() {
        // When both city and town are present, city should win
        let json = serde_json::json!({
            "address": {
                "country": "Germany",
                "city": "Berlin",
                "town": "SomeTown"
            }
        });
        assert_eq!(parse_nominatim_response(&json), "Germany·Berlin");
    }

    #[test]
    fn test_parse_nominatim_priority_town_over_village() {
        let json = serde_json::json!({
            "address": {
                "country": "Italy",
                "town": "Positano",
                "village": "SomeVillage"
            }
        });
        assert_eq!(parse_nominatim_response(&json), "Italy·Positano");
    }

    #[test]
    fn test_parse_nominatim_priority_village_over_county() {
        let json = serde_json::json!({
            "address": {
                "country": "UK",
                "village": "Cotswolds Village",
                "county": "Gloucestershire"
            }
        });
        assert_eq!(parse_nominatim_response(&json), "UK·Cotswolds Village");
    }

    #[test]
    fn test_middle_dot_character() {
        let json = serde_json::json!({
            "address": {
                "country": "China",
                "city": "Shanghai"
            }
        });
        let result = parse_nominatim_response(&json);
        // Verify it uses the middle dot (U+00B7), not a regular period
        assert!(
            result.contains('\u{00B7}'),
            "Expected middle dot, got: {}",
            result
        );
        assert_eq!(result, "China·Shanghai");
    }

    fn new_in_memory_db_with_geo_data() -> Connection {
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
    fn test_tag_photos_query_selects_correct_photos() {
        let conn = new_in_memory_db_with_geo_data();

        // Insert photos: one with GPS, one without, one already tagged
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, latitude, longitude, imported_at)
             VALUES (1, '/p1.jpg', 'p1.jpg', 1000, 0, 39.9042, 116.4074, 0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, latitude, longitude, imported_at)
             VALUES (2, '/p2.jpg', 'p2.jpg', 1000, 0, NULL, NULL, 0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, latitude, longitude, imported_at)
             VALUES (3, '/p3.jpg', 'p3.jpg', 1000, 0, 35.6762, 139.6503, 0)",
            [],
        ).unwrap();
        // Photo 4 has GPS but already geo-tagged
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, latitude, longitude, imported_at)
             VALUES (4, '/p4.jpg', 'p4.jpg', 1000, 0, 48.8566, 2.3522, 0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO ai_classifications (photo_id, category, label, confidence, tag_type)
             VALUES (4, 'geo', 'France·Paris', 1.0, 'geo_location')",
            [],
        )
        .unwrap();

        // Verify the query logic (without network calls)
        let query = "
            SELECT id, latitude, longitude FROM photos
            WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND deleted = 0
              AND id NOT IN (
                SELECT photo_id FROM ai_classifications WHERE tag_type = 'geo_location'
              )
            LIMIT 100
        ";
        let mut stmt = conn.prepare(query).unwrap();
        let rows: Vec<(i64, f64, f64)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        // Should return photos 1 and 3, but not 2 (no GPS) or 4 (already tagged)
        assert_eq!(rows.len(), 2);
        let ids: Vec<i64> = rows.iter().map(|(id, _, _)| *id).collect();
        assert!(ids.contains(&1));
        assert!(ids.contains(&3));
        assert!(!ids.contains(&2));
        assert!(!ids.contains(&4));
    }

    #[test]
    fn test_tag_photos_excludes_deleted() {
        let conn = new_in_memory_db_with_geo_data();

        // Deleted photo with GPS
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, latitude, longitude, deleted, imported_at)
             VALUES (1, '/p1.jpg', 'p1.jpg', 1000, 0, 39.9042, 116.4074, 1, 0)",
            [],
        ).unwrap();

        let query = "
            SELECT id, latitude, longitude FROM photos
            WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND deleted = 0
              AND id NOT IN (
                SELECT photo_id FROM ai_classifications WHERE tag_type = 'geo_location'
              )
            LIMIT 100
        ";
        let mut stmt = conn.prepare(query).unwrap();
        let rows: Vec<(i64, f64, f64)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        assert!(rows.is_empty(), "Deleted photos should not be returned");
    }
}
