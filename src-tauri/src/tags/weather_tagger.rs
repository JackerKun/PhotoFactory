use chrono::{DateTime, Local, NaiveDate};
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::db::classification_dao::insert_classification_with_type;
use crate::error::{AppError, AppResult};
use crate::models::AiClassification;

/// WMO Weather code to Chinese label mapping.
fn weather_code_label(code: i64) -> &'static str {
    match code {
        0 => "晴天",
        1 => "晴天",
        2 => "多云",
        3 => "阴天",
        45 => "雾天",
        48 => "雾天",
        51..=57 => "雨天",
        61..=67 => "雨天",
        71..=77 => "雪天",
        80..=82 => "雨天",
        85..=86 => "雪天",
        95..=99 => "雷雨天",
        _ => "阴天",
    }
}

/// Rate limiter for weather API (1 req/s to be polite).
static LAST_REQUEST: Mutex<Option<Instant>> = Mutex::new(None);

/// Cache: "YYYY-MM-DD,lat_rounded,lng_rounded" -> weather label.
static WEATHER_CACHE: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn wait_for_rate_limit() {
    let mut guard = LAST_REQUEST.lock().unwrap();
    if let Some(last) = *guard {
        let elapsed = last.elapsed();
        if elapsed < Duration::from_secs(1) {
            std::thread::sleep(Duration::from_secs(1) - elapsed);
        }
    }
    *guard = Some(Instant::now());
}

/// Fetch weather data from Open-Meteo for a given date and location.
fn fetch_weather(lat: f64, lng: f64, date: NaiveDate) -> Result<String, String> {
    let cache_key = format!("{}_{:.2}_{:.2}", date, lat, lng);
    {
        let cache = WEATHER_CACHE.lock().unwrap();
        if let Some(label) = cache.get(&cache_key) {
            return Ok(label.clone());
        }
    }

    wait_for_rate_limit();

    let url = format!(
        "https://archive-api.open-meteo.com/v1/archive?latitude={}&longitude={}&start_date={}&end_date={}&daily=weather_code",
        lat, lng, date, date
    );

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client.get(&url).send().map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("API returned {}", response.status()));
    }

    let json: serde_json::Value = response.json().map_err(|e| e.to_string())?;

    let code = json["daily"]["weather_code"][0]
        .as_i64()
        .ok_or("Failed to parse weather_code")?;

    let label = weather_code_label(code).to_string();

    {
        let mut cache = WEATHER_CACHE.lock().unwrap();
        cache.insert(cache_key, label.clone());
    }

    Ok(label)
}

/// A photo that needs weather tagging.
pub struct WeatherPhoto {
    pub photo_id: i64,
    pub lat: f64,
    pub lng: f64,
    pub date: NaiveDate,
}

/// Query photos that need weather tagging (sync, uses conn).
pub fn query_weather_photos(conn: &Connection, batch_size: usize) -> AppResult<Vec<WeatherPhoto>> {
    let query = "
        SELECT id, latitude, longitude, taken_at FROM photos
        WHERE latitude IS NOT NULL
          AND longitude IS NOT NULL
          AND taken_at IS NOT NULL
          AND deleted = 0
          AND id NOT IN (
              SELECT photo_id FROM ai_classifications WHERE tag_type = 'rule_weather'
          )
        LIMIT ?
    ";

    let mut stmt = conn
        .prepare(query)
        .map_err(|e| AppError::Internal(format!("Failed to prepare query: {}", e)))?;

    let rows: Vec<(i64, f64, f64, i64)> = stmt
        .query_map([batch_size as i64], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| AppError::Internal(format!("Failed to query photos: {}", e)))?
        .filter_map(|r| r.ok())
        .collect();

    let photos: Vec<WeatherPhoto> = rows
        .into_iter()
        .map(|(photo_id, lat, lng, timestamp)| {
            let dt = DateTime::from_timestamp(timestamp, 0)
                .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap())
                .with_timezone(&Local);
            WeatherPhoto {
                photo_id,
                lat,
                lng,
                date: dt.date_naive(),
            }
        })
        .collect();

    Ok(photos)
}

/// Fetch weather for all photos (async, no database).
/// Returns `(photo_id, weather_label)` for successful fetches.
pub async fn run_weather_tagging(photos: Vec<WeatherPhoto>) -> Vec<(i64, String)> {
    let mut results = Vec::new();
    for photo in photos {
        let lat = photo.lat;
        let lng = photo.lng;
        let date = photo.date;
        let photo_id = photo.photo_id;
        match tokio::task::spawn_blocking(move || fetch_weather(lat, lng, date)).await {
            Ok(Ok(label)) => results.push((photo_id, label)),
            Ok(Err(e)) => {
                eprintln!("Weather tagging failed for photo {}: {}", photo_id, e);
            }
            Err(e) => {
                eprintln!("Weather tagging task failed for photo {}: {}", photo_id, e);
            }
        }
    }
    results
}

/// Save weather classifications to the database (sync, uses conn).
pub fn save_weather_tagging(conn: &Connection, results: &[(i64, String)]) -> usize {
    let mut tagged = 0;
    for (photo_id, label) in results {
        let classification = AiClassification {
            id: None,
            photo_id: *photo_id,
            category: "rule".into(),
            label: label.clone(),
            confidence: 1.0,
        };
        if insert_classification_with_type(conn, &classification, "rule_weather").is_ok() {
            tagged += 1;
        }
    }
    tagged
}
