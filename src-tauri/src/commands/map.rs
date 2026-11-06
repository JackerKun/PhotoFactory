// src-tauri/src/commands/map.rs
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tauri::State;

use crate::commands::project::{get_conn, AppState};
use crate::db::photo_dao;
use crate::error::{AppError, AppResult};
use crate::models::Photo;

const MAX_TILE_CACHE_BYTES: u64 = 512 * 1024 * 1024;
const TILE_CACHE_TRIM_TO_BYTES: u64 = 448 * 1024 * 1024;
const MAX_TILE_BYTES: usize = 2 * 1024 * 1024;
static TILE_WRITES: AtomicUsize = AtomicUsize::new(0);

static TILE_CLIENT: once_cell::sync::Lazy<reqwest::Client> = once_cell::sync::Lazy::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .user_agent("PhotoFactory/0.1.0 (desktop photo manager)")
        .build()
        .expect("failed to create map tile HTTP client")
});

#[derive(Clone, Debug, Serialize)]
pub struct MapSearchResult {
    lat: f64,
    lng: f64,
    display_name: String,
}

#[derive(Debug, Deserialize)]
struct NominatimResult {
    lat: String,
    lon: String,
    display_name: String,
}

/// Search through the Rust HTTP client so desktop CSP rules cannot block the
/// geocoder. Keeping this off the webview also gives it the same timeouts and
/// user-agent policy as map tiles.
#[tauri::command]
pub async fn cmd_search_map_location(query: String) -> AppResult<Vec<MapSearchResult>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    if query.chars().count() > 200 {
        return Err(AppError::Project(
            "Map search is limited to 200 characters".into(),
        ));
    }

    let results: Vec<NominatimResult> = TILE_CLIENT
        .get("https://nominatim.openstreetmap.org/search")
        .header(reqwest::header::ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.6")
        .query(&[("format", "jsonv2"), ("q", query), ("limit", "8")])
        .send()
        .await
        .map_err(|e| {
            AppError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?
        .error_for_status()
        .map_err(|e| {
            AppError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?
        .json()
        .await
        .map_err(|e| {
            AppError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                e.to_string(),
            ))
        })?;

    Ok(results
        .into_iter()
        .filter_map(|result| {
            Some(MapSearchResult {
                lat: result.lat.parse().ok()?,
                lng: result.lon.parse().ok()?,
                display_name: result.display_name,
            })
        })
        .collect())
}

fn validate_tile_coordinates(z: u32, x: u32, y: u32) -> AppResult<()> {
    if z > 19 {
        return Err(AppError::Project(
            "Map zoom must be between 0 and 19".into(),
        ));
    }
    let edge = 1u32 << z;
    if x >= edge || y >= edge {
        return Err(AppError::Project("Invalid map tile coordinates".into()));
    }
    Ok(())
}

fn trim_tile_cache(cache_dir: &std::path::Path) {
    let mut entries = Vec::new();
    let mut total = 0u64;
    for entry in walkdir::WalkDir::new(cache_dir)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        if let Ok(metadata) = entry.metadata() {
            let len = metadata.len();
            total = total.saturating_add(len);
            let modified = metadata
                .modified()
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            entries.push((modified, len, entry.into_path()));
        }
    }
    if total <= MAX_TILE_CACHE_BYTES {
        return;
    }
    entries.sort_unstable_by_key(|entry| entry.0);
    for (_, len, path) in entries {
        if total <= TILE_CACHE_TRIM_TO_BYTES {
            break;
        }
        if std::fs::remove_file(path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

#[tauri::command]
pub async fn cmd_get_photos_with_gps(
    min_lat: f64,
    max_lat: f64,
    min_lng: f64,
    max_lng: f64,
    limit: i64,
    state: State<'_, AppState>,
) -> AppResult<Vec<Photo>> {
    let conn = get_conn(state)?;
    photo_dao::get_photos_in_bbox(&conn, min_lat, max_lat, min_lng, max_lng, limit.min(5000))
}

#[tauri::command]
pub async fn cmd_get_photo_directories(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".into()))?
            .clone()
    };
    let conn = get_conn(state)?;

    let root = &project.root_path;
    let mut stmt =
        conn.prepare("SELECT DISTINCT path FROM photos WHERE deleted = 0 ORDER BY path")?;
    let paths: Vec<String> = stmt
        .query_map([], |r| r.get(0))?
        .filter_map(|r| r.ok())
        .collect();

    let mut dirs: Vec<String> = paths
        .iter()
        .filter_map(|p| std::path::Path::new(p).parent())
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    dirs.sort();
    dirs.dedup();

    let root_path = std::path::Path::new(root);
    let relative: Vec<String> = dirs
        .iter()
        .filter_map(|d| std::path::Path::new(d).strip_prefix(root_path).ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    Ok(relative)
}

fn tile_source(layer: &str, z: u32, x: u32, y: u32) -> AppResult<(String, String)> {
    match layer {
        "standard" => Ok((
            format!("{}/{}/{}.png", z, x, y),
            format!("https://tile.openstreetmap.org/{}/{}/{}.png", z, x, y),
        )),
        "satellite" => Ok((
            format!("satellite/{}/{}/{}.jpg", z, x, y),
            format!("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{}/{}/{}", z, y, x),
        )),
        _ => Err(AppError::Project("Unsupported map layer".into())),
    }
}

/// Get a map tile from cache, or download and cache it from the selected source.
/// Returns the local file path for convertFileSrc, or the network URL if download fails.
#[tauri::command]
pub async fn cmd_get_map_tile(
    z: u32,
    x: u32,
    y: u32,
    layer: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<String> {
    validate_tile_coordinates(z, x, y)?;
    let layer = layer.as_deref().unwrap_or("standard");
    let (relative_path, url) = tile_source(layer, z, x, y)?;
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".into()))?
            .clone()
    };

    let tiles_dir = project.tiles_path();
    let tile_path = tiles_dir.join(relative_path);

    // Check cache first
    if tile_path.exists() {
        return Ok(tile_path.to_string_lossy().to_string());
    }

    let resp = TILE_CLIENT
        .get(&url)
        .send()
        .await
        .map_err(|e| {
            AppError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?
        .error_for_status()
        .map_err(|e| {
            AppError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;

    let bytes = resp.bytes().await.map_err(|e| {
        AppError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        ))
    })?;
    if bytes.is_empty() || bytes.len() > MAX_TILE_BYTES {
        return Err(AppError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Map tile response has an invalid size",
        )));
    }

    // Save to cache
    if let Some(parent) = tile_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| AppError::Io(e))?;
    }
    let temp_path = tile_path.with_extension("png.part");
    std::fs::write(&temp_path, &bytes).map_err(AppError::Io)?;
    std::fs::rename(&temp_path, &tile_path).map_err(AppError::Io)?;

    // Cache accounting is deliberately amortized: walking the cache for every tile
    // would cost more than the network request it is intended to optimize.
    if TILE_WRITES.fetch_add(1, Ordering::Relaxed) % 128 == 127 {
        trim_tile_cache(&tiles_dir);
    }

    Ok(tile_path.to_string_lossy().to_string())
}

/// Check if a tile exists in the local cache (no download).
#[tauri::command]
pub async fn cmd_has_map_tile(
    z: u32,
    x: u32,
    y: u32,
    layer: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<bool> {
    validate_tile_coordinates(z, x, y)?;
    let (relative_path, _) = tile_source(layer.as_deref().unwrap_or("standard"), z, x, y)?;
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".into()))?
            .clone()
    };

    let tile_path = project.tiles_path().join(relative_path);
    Ok(tile_path.exists())
}

#[cfg(test)]
mod tests {
    use super::tile_source;

    #[test]
    fn resolves_standard_and_satellite_tile_sources_independently() {
        let (standard_path, standard_url) = tile_source("standard", 6, 51, 23).unwrap();
        assert_eq!(standard_path, "6/51/23.png");
        assert_eq!(standard_url, "https://tile.openstreetmap.org/6/51/23.png");

        let (satellite_path, satellite_url) = tile_source("satellite", 6, 51, 23).unwrap();
        assert_eq!(satellite_path, "satellite/6/51/23.jpg");
        assert_eq!(satellite_url, "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/6/23/51");
    }

    #[test]
    fn rejects_unknown_tile_sources() {
        assert!(tile_source("terrain", 1, 0, 0).is_err());
    }
}
