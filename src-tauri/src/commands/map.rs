// src-tauri/src/commands/map.rs
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tauri::State;

use crate::commands::project::{get_conn, AppState};
use crate::db::photo_dao;
use crate::error::{AppError, AppResult};
use crate::models::{Photo, Project};
use crate::offline_maps::{self, OfflineMap};

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

#[derive(Serialize)]
pub struct TrackPhoto {
    id: i64,
    filename: String,
    taken_at: i64,
    latitude: f64,
    longitude: f64,
}

#[derive(Deserialize, Serialize)]
pub struct TrackSettings {
    bounds: [f64; 4],
    start_date: String,
    end_date: String,
    joined_gaps: Vec<String>,
}

#[derive(Serialize)]
pub struct SavedTrack {
    id: i64,
    name: String,
    settings: TrackSettings,
}

fn valid_track_bounds([west, south, east, north]: [f64; 4]) -> bool {
    -180.0 <= west
        && west < east
        && east <= 180.0
        && -90.0 <= south
        && south < north
        && north <= 90.0
}

#[tauri::command]
pub async fn cmd_get_track_photos(
    bounds: [f64; 4],
    start_at: Option<i64>,
    end_before: Option<i64>,
    state: State<'_, AppState>,
) -> AppResult<Vec<TrackPhoto>> {
    use crate::commands::project::{current_project, read_project_db};
    if !valid_track_bounds(bounds)
        || start_at
            .zip(end_before)
            .is_some_and(|(start, end)| start >= end)
    {
        return Err(AppError::Project("轨迹的选区或日期范围无效".into()));
    }
    read_project_db(current_project(&state)?, move |conn| {
        query_track_photos(conn, bounds, start_at, end_before)
    })
    .await
}

fn query_track_photos(
    conn: &rusqlite::Connection,
    bounds: [f64; 4],
    start_at: Option<i64>,
    end_before: Option<i64>,
) -> AppResult<Vec<TrackPhoto>> {
    let [west, south, east, north] = bounds;
    let mut stmt = conn.prepare(
        "SELECT p.id, p.filename, p.taken_at, p.latitude, p.longitude
         FROM photos p
         WHERE p.deleted=0 AND p.latitude BETWEEN ?1 AND ?2 AND p.longitude BETWEEN ?3 AND ?4
           AND p.taken_at IS NOT NULL AND p.taken_at >= ?5 AND p.taken_at < ?6
           AND NOT EXISTS (SELECT 1 FROM photo_trash t WHERE t.photo_id=p.id)
           AND NOT EXISTS (SELECT 1 FROM photo_intelligence i WHERE i.photo_id=p.id AND i.is_private=1)
         ORDER BY p.taken_at, p.id LIMIT 5001",
    )?;
    let rows = stmt
        .query_map(
            rusqlite::params![
                south,
                north,
                west,
                east,
                start_at.unwrap_or(i64::MIN),
                end_before.unwrap_or(i64::MAX)
            ],
            |row| {
                Ok(TrackPhoto {
                    id: row.get(0)?,
                    filename: row.get(1)?,
                    taken_at: row.get(2)?,
                    latitude: row.get(3)?,
                    longitude: row.get(4)?,
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    if rows.len() > 5000 {
        return Err(AppError::Project(
            "选区内超过 5000 张照片，请缩小区域或日期范围".into(),
        ));
    }
    Ok(rows)
}

#[tauri::command]
pub async fn cmd_list_photo_tracks(state: State<'_, AppState>) -> AppResult<Vec<SavedTrack>> {
    use crate::commands::project::{current_project, read_project_db};
    read_project_db(current_project(&state)?, |conn| {
        let mut stmt =
            conn.prepare("SELECT id,name,settings FROM photo_tracks ORDER BY id DESC")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        rows.map(|row| {
            let (id, name, settings) = row?;
            Ok(SavedTrack {
                id,
                name,
                settings: serde_json::from_str(&settings)?,
            })
        })
        .collect()
    })
    .await
}

#[tauri::command]
pub async fn cmd_save_photo_track(
    id: Option<i64>,
    name: String,
    settings: TrackSettings,
    state: State<'_, AppState>,
) -> AppResult<SavedTrack> {
    let name = name.trim().to_owned();
    if name.is_empty()
        || name.chars().count() > 100
        || !valid_track_bounds(settings.bounds)
        || settings.joined_gaps.len() > 5000
        || settings.joined_gaps.iter().any(|gap| gap.len() > 41)
        || [&settings.start_date, &settings.end_date]
            .into_iter()
            .any(|date| {
                !date.is_empty()
                    && (date.len() != 10
                        || chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err())
            })
        || (!settings.end_date.is_empty() && settings.start_date > settings.end_date)
    {
        return Err(AppError::Project("轨迹名称或设置无效".into()));
    }
    let conn = get_conn(state)?;
    let json = serde_json::to_string(&settings)?;
    let id = if let Some(id) = id {
        if conn.execute(
            "UPDATE photo_tracks SET name=?1,settings=?2 WHERE id=?3",
            rusqlite::params![name, json, id],
        )? == 0
        {
            return Err(AppError::Project("找不到要更新的轨迹".into()));
        }
        id
    } else {
        conn.execute(
            "INSERT INTO photo_tracks(name,settings) VALUES(?1,?2)",
            rusqlite::params![name, json],
        )?;
        conn.last_insert_rowid()
    };
    Ok(SavedTrack { id, name, settings })
}

#[tauri::command]
pub async fn cmd_delete_photo_track(id: i64, state: State<'_, AppState>) -> AppResult<()> {
    get_conn(state)?.execute("DELETE FROM photo_tracks WHERE id=?1", [id])?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_get_photo_directories(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    use crate::commands::project::{current_project, read_project_db};
    let project = current_project(&state)?;
    let root = std::path::PathBuf::from(&project.root_path);
    read_project_db(project, move |conn| {
        let mut stmt = conn.prepare("SELECT path FROM photos WHERE deleted = 0")?;
        let paths = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut directories = std::collections::BTreeSet::new();
        for path in paths {
            if let Some(relative) = std::path::Path::new(&path?)
                .parent()
                .and_then(|parent| parent.strip_prefix(&root).ok())
            {
                directories.insert(relative.to_string_lossy().into_owned());
            }
        }
        Ok(directories.into_iter().collect())
    })
    .await
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

fn active_project(state: &AppState) -> AppResult<Project> {
    state
        .project
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| AppError::Project("No project open".into()))
}

async fn run_disk<T: Send + 'static>(
    task: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|err| AppError::Internal(err.to_string()))?
}

#[tauri::command]
pub async fn cmd_list_offline_maps(state: State<'_, AppState>) -> AppResult<Vec<OfflineMap>> {
    let dir = active_project(&state)?.offline_maps_path();
    run_disk(move || offline_maps::list_packages(&dir)).await
}

#[tauri::command]
pub async fn cmd_import_offline_map(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> AppResult<Vec<OfflineMap>> {
    let dir = active_project(&state)?.offline_maps_path();
    let paths = paths
        .into_iter()
        .map(std::path::PathBuf::from)
        .collect::<Vec<_>>();
    run_disk(move || offline_maps::import_packages(&paths, &dir)).await
}

#[tauri::command]
pub async fn cmd_export_offline_map(
    path: String,
    layer: String,
    state: State<'_, AppState>,
) -> AppResult<offline_maps::ExportedMap> {
    let project = active_project(&state)?;
    run_disk(move || {
        offline_maps::export_selection(
            &project.offline_maps_path(),
            &project.tiles_path(),
            std::path::Path::new(&path),
            &project.name,
            &layer,
        )
    })
    .await
}

#[derive(Serialize)]
pub struct MapTileResult {
    url: String,
    source: &'static str,
}

#[tauri::command]
pub async fn cmd_get_map_tile_status(
    z: u32,
    x: u32,
    y: u32,
    layer: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<MapTileResult> {
    load_map_tile(
        &active_project(&state)?,
        z,
        x,
        y,
        layer.as_deref().unwrap_or("standard"),
    )
    .await
}

/// Try imported tiles, then the local cache, then download a missing tile.
#[tauri::command]
pub async fn cmd_get_map_tile(
    z: u32,
    x: u32,
    y: u32,
    layer: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<Option<String>> {
    get_map_tile(
        &active_project(&state)?,
        z,
        x,
        y,
        layer.as_deref().unwrap_or("standard"),
    )
    .await
}

async fn get_map_tile(
    project: &Project,
    z: u32,
    x: u32,
    y: u32,
    layer: &str,
) -> AppResult<Option<String>> {
    Ok(Some(load_map_tile(project, z, x, y, layer).await?.url))
}

async fn load_map_tile(
    project: &Project,
    z: u32,
    x: u32,
    y: u32,
    layer: &str,
) -> AppResult<MapTileResult> {
    validate_tile_coordinates(z, x, y)?;
    let (relative_path, url) = tile_source(layer, z, x, y)?;
    let offline_dir = project.offline_maps_path();
    let tile_layer = layer.to_owned();
    let tiles =
        match run_disk(move || offline_maps::tile_options(&offline_dir, &tile_layer, z, x, y)).await {
            Ok(tiles) => tiles,
            Err(error) => {
                eprintln!("Could not read imported map tiles: {error}");
                offline_maps::TileOptions::default()
            }
        };
    if let Some(detail) = tiles.detail {
        return Ok(MapTileResult {
            url: detail,
            source: "package",
        });
    }

    let tiles_dir = project.tiles_path();
    let tile_path = tiles_dir.join(relative_path);

    // Check cache first
    if tile_path.is_file() {
        return Ok(MapTileResult {
            url: tile_path.to_string_lossy().to_string(),
            source: "cache",
        });
    }

    let mut request = TILE_CLIENT.get(&url);
    if tiles.overview.is_some() {
        request = request.timeout(Duration::from_secs(4));
    }
    let download = async {
        let bytes = request.send().await?.error_for_status()?.bytes().await?;
        if bytes.is_empty() || bytes.len() > MAX_TILE_BYTES {
            return Err(AppError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Map tile response has an invalid size",
            )));
        }
        Ok(bytes)
    };
    let bytes = match download.await {
        Ok(bytes) => bytes,
        Err(error) => match tiles.overview {
            Some(url) => {
                return Ok(MapTileResult {
                    url,
                    source: "package",
                })
            }
            None => return Err(error),
        },
    };

    // Save to cache
    if let Some(parent) = tile_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| AppError::Io(e))?;
    }
    use std::io::Write;
    let mut temp = tempfile::NamedTempFile::new_in(tile_path.parent().unwrap())?;
    temp.write_all(&bytes)?;
    temp.persist(&tile_path).map_err(|error| error.error)?;

    // Cache accounting is deliberately amortized: walking the cache for every tile
    // would cost more than the network request it is intended to optimize.
    if TILE_WRITES.fetch_add(1, Ordering::Relaxed) % 128 == 127 {
        trim_tile_cache(&tiles_dir);
    }

    Ok(MapTileResult {
        url: tile_path.to_string_lossy().to_string(),
        source: "network",
    })
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
    let project = active_project(&state)?;
    if project.tiles_path().join(relative_path).is_file() {
        return Ok(true);
    }
    let dir = project.offline_maps_path();
    let layer = layer.unwrap_or_else(|| "standard".into());
    run_disk(move || {
        let tiles = offline_maps::tile_options(&dir, &layer, z, x, y)?;
        Ok(tiles.detail.is_some() || tiles.overview.is_some())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn track_query_filters_area_and_dates_and_excludes_hidden_photos() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema::CREATE_TABLES)
            .unwrap();
        for (id, time, longitude) in [
            (1, Some(150), Some(121.5)),
            (2, Some(100), Some(121.5)),
            (3, Some(200), Some(121.5)),
            (4, Some(125), Some(122.5)),
            (5, None, Some(121.5)),
            (6, Some(125), Some(121.5)),
            (7, Some(125), Some(121.5)),
            (8, Some(125), None),
        ] {
            conn.execute(
                "INSERT INTO photos(id,path,filename,file_size,file_mtime,imported_at,taken_at,latitude,longitude)
                 VALUES(?1,?2,'track.jpg',1,1,1,?3,31.5,?4)",
                rusqlite::params![id, format!("/{id}.jpg"), time, longitude],
            ).unwrap();
        }
        conn.execute_batch(
            "INSERT INTO photo_intelligence(photo_id,is_private) VALUES(6,1);
             INSERT INTO photo_trash(photo_id,trashed_at) VALUES(7,1);",
        )
        .unwrap();
        let result =
            query_track_photos(&conn, [121.0, 31.0, 122.0, 32.0], Some(100), Some(200)).unwrap();
        assert_eq!(
            result.iter().map(|photo| photo.id).collect::<Vec<_>>(),
            [2, 1]
        );
    }

    #[tokio::test]
    async fn map_lookup_prioritizes_packages_then_cache() {
        let temp = tempfile::tempdir().unwrap();
        let project = Project::new("Test".into(), temp.path().to_string_lossy().into_owned());
        let source = temp.path().join("city.mbtiles");
        offline_maps::write_fixture(&source, "png");
        offline_maps::import_package(&source, &project.offline_maps_path()).unwrap();
        let overview = temp.path().join("overview.mbtiles");
        offline_maps::write_fixture(&overview, "png");
        rusqlite::Connection::open(&overview)
            .unwrap()
            .execute_batch(
                "UPDATE metadata SET value='NASA Earthdata / GIBS — Blue Marble' WHERE name='attribution';
                 INSERT INTO tiles SELECT zoom_level,tile_column,4,tile_data FROM tiles;",
            )
            .unwrap();
        offline_maps::import_package(&overview, &project.offline_maps_path()).unwrap();
        let cache = project.tiles_path().join("satellite/3/6");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("2.jpg"), b"old cached tile").unwrap();
        std::fs::write(cache.join("3.jpg"), b"old cached tile").unwrap();
        let local = get_map_tile(&project, 3, 6, 2, "satellite")
            .await
            .unwrap()
            .unwrap();
        assert!(local.starts_with("data:image/png;base64,"));
        assert_eq!(
            load_map_tile(&project, 3, 6, 2, "satellite")
                .await
                .unwrap()
                .source,
            "package"
        );
        assert_eq!(
            load_map_tile(&project, 3, 6, 3, "satellite")
                .await
                .unwrap()
                .source,
            "cache"
        );
        let cached = get_map_tile(&project, 3, 6, 3, "satellite")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(std::path::Path::new(&cached), cache.join("3.jpg"));
    }

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
