// src-tauri/src/commands/photos.rs
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::State;

use crate::commands::project::{current_project, get_conn, read_project_db, AppState};
use crate::db::{classification_dao, custom_attr_dao, photo_dao};
use crate::error::{AppError, AppResult};
use crate::models::{
    AiClassification, CustomAttribute, Photo, PhotoCursor, PhotoFilter, PhotoFilterOptions,
    PhotoPage, PhotoTimelineBucket,
};
use crate::thumbnail::processor::{ProcessingStatus, ThumbnailPerformance};
use crate::thumbnail::{eviction, generator};
use base64::Engine;
use serde::Deserialize;
use tempfile::Builder;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoGpsUpdate {
    photo_id: i64,
    latitude: Option<f64>,
    longitude: Option<f64>,
}

/// Global counter tracking concurrent on-demand thumbnail generations.
/// Used to throttle parallel spawn_blocking calls during fast scrolling.
static ACTIVE_THUMBNAIL_TASKS: AtomicUsize = AtomicUsize::new(0);
static THUMBNAIL_SLOT: tokio::sync::Notify = tokio::sync::Notify::const_new();

struct ActiveThumbnailGuard;

impl Drop for ActiveThumbnailGuard {
    fn drop(&mut self) {
        ACTIVE_THUMBNAIL_TASKS.fetch_sub(1, Ordering::SeqCst);
        THUMBNAIL_SLOT.notify_waiters();
    }
}

#[tauri::command]
pub async fn cmd_get_photos(
    cursor: Option<PhotoCursor>,
    limit: i64,
    filter: PhotoFilter,
    state: State<'_, AppState>,
) -> AppResult<PhotoPage> {
    read_project_db(current_project(&state)?, move |conn| {
        photo_dao::get_photos_page(conn, cursor.as_ref(), limit.clamp(1, 500), &filter)
    })
    .await
}

#[tauri::command]
pub async fn cmd_get_photo_timeline(
    filter: PhotoFilter,
    state: State<'_, AppState>,
) -> AppResult<Vec<PhotoTimelineBucket>> {
    read_project_db(current_project(&state)?, move |conn| {
        photo_dao::get_photo_timeline(conn, &filter)
    })
    .await
}

#[tauri::command]
pub async fn cmd_get_photo_filter_options(
    filter: PhotoFilter,
    state: State<'_, AppState>,
) -> AppResult<PhotoFilterOptions> {
    read_project_db(current_project(&state)?, move |conn| {
        photo_dao::get_photo_filter_options(conn, &filter)
    })
    .await
}

#[tauri::command]
pub async fn cmd_update_photos_rating(
    photo_ids: Vec<i64>,
    rating: i32,
    state: State<'_, AppState>,
) -> AppResult<usize> {
    if photo_ids.len() > 5000 {
        return Err(AppError::Project(
            "A rating batch is limited to 5000 photos".to_string(),
        ));
    }
    let mut conn = get_conn(state)?;
    photo_dao::update_photos_rating(&mut conn, &photo_ids, rating)
}

#[tauri::command]
pub async fn cmd_get_photo(photo_id: i64, state: State<'_, AppState>) -> AppResult<Photo> {
    read_project_db(current_project(&state)?, move |conn| {
        photo_dao::get_photo_by_id(conn, photo_id)?
            .ok_or_else(|| AppError::NotFound(format!("Photo {photo_id} not found")))
    })
    .await
}

#[tauri::command]
pub async fn cmd_get_lightbox_photos(
    photo_id: i64,
    state: State<'_, AppState>,
) -> AppResult<Vec<Photo>> {
    let conn = get_conn(state.clone())?;
    let photo = photo_dao::get_photo_by_id(&conn, photo_id)?
        .ok_or_else(|| AppError::NotFound(format!("Photo {} not found", photo_id)))?;
    photo_dao::get_photos_in_same_directory(&conn, &photo.path)
}

#[tauri::command]
pub async fn cmd_get_photo_classifications(
    photo_id: i64,
    state: State<'_, AppState>,
) -> AppResult<Vec<AiClassification>> {
    let conn = get_conn(state.clone())?;
    classification_dao::get_classifications_for_photo(&conn, photo_id)
}

#[tauri::command]
pub async fn cmd_get_photo_attributes(
    photo_id: i64,
    state: State<'_, AppState>,
) -> AppResult<Vec<CustomAttribute>> {
    let conn = get_conn(state.clone())?;
    custom_attr_dao::get_attributes_for_photo(&conn, photo_id)
}

#[tauri::command]
pub async fn cmd_set_photo_attribute(
    photo_id: i64,
    key: String,
    value: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let conn = get_conn(state.clone())?;
    custom_attr_dao::upsert_attribute(
        &conn,
        &CustomAttribute {
            id: None,
            photo_id,
            key,
            value,
        },
    )
}

#[tauri::command]
pub async fn cmd_get_thumbnail_path(
    photo_id: i64,
    size: String,
    state: State<'_, AppState>,
) -> AppResult<String> {
    // Need project for paths — get it first, then drop the lock before opening another connection
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".into()))?
            .clone()
    };
    let processor = state.thumbnail_processor.clone();
    let (photo, ignored) = read_project_db(project.clone(), move |conn| {
        let photo = photo_dao::get_photo_by_id(conn, photo_id)?
            .ok_or_else(|| AppError::NotFound(format!("Photo {photo_id} not found")))?;
        let ignored = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM photo_task_ignores WHERE photo_id=?1 AND stage='thumbnail')",
            [photo_id],
            |row| row.get::<_, bool>(0),
        )?;
        Ok((photo, ignored))
    })
    .await?;

    let out_dir = match size.as_str() {
        "large" => project.large_thumbnails_path(),
        "medium" => project.medium_thumbnails_path(),
        _ => project.small_thumbnails_path(),
    };
    // Check both sharded and legacy flat paths
    if let Some(thumb_path) = generator::find_thumbnail_path(&photo.path, &out_dir) {
        let _ = eviction::touch_thumbnail(&thumb_path);
        return Ok(thumb_path.to_string_lossy().to_string());
    }
    if ignored {
        return Ok(photo.path);
    }

    // Thumbnail file not found on disk — regenerate on demand regardless of
    // file size or DB status. This handles the case where the user deleted
    // cache files that the database still thinks exist.
    // Wait for a slot instead of failing visible thumbnails during fast scrolling.
    let (active_guard, mode) = loop {
        let mode = processor.performance();
        let notified = THUMBNAIL_SLOT.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if ACTIVE_THUMBNAIL_TASKS
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |active| {
                (active < mode.foreground_limit()).then_some(active + 1)
            })
            .is_ok()
        {
            break (ActiveThumbnailGuard, mode);
        }
        notified.await;
    };

    // Generate on demand — spawn_blocking to avoid blocking the async runtime
    let source = Path::new(&photo.path).to_path_buf();
    let pixels = match size.as_str() {
        "large" => 1024,
        "medium" => 512,
        _ => 256,
    };
    tokio::task::spawn_blocking(move || -> AppResult<String> {
        let _active_guard = active_guard;
        let result = generator::generate_thumbnail_with_mode(&source, &out_dir, pixels, mode)?;
        if pixels == 256 && result.exists() {
            // A valid cached image is usable even if a writer temporarily owns the database.
            let update = rusqlite::Connection::open_with_flags(
                project.db_path(),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
            )
            .and_then(|conn| {
                conn.busy_timeout(std::time::Duration::from_millis(100))?;
                conn.execute(
                    "UPDATE photos SET thumbnail_status = 1 WHERE id = ? AND thumbnail_status <> 1",
                    [photo_id],
                )
            });
            if let Err(error) = update {
                eprintln!("Could not record thumbnail status for photo {photo_id}: {error}");
            }
        }
        let _ = eviction::maybe_evict(&out_dir);
        Ok(result.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| AppError::Internal(format!("缩略图任务中断：{error}")))?
}

#[tauri::command]
pub async fn cmd_start_thumbnail_batch(state: State<'_, AppState>) -> AppResult<String> {
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".to_string()))?
            .clone()
    };

    let processor = state.thumbnail_processor.clone();
    if processor.is_running() {
        return Ok("Already processing thumbnails".to_string());
    }

    // Spawn the background task so the command returns immediately.
    tauri::async_runtime::spawn_blocking(move || processor.process_all(&project));

    Ok("Thumbnail batch processing started".to_string())
}

#[tauri::command]
pub async fn cmd_get_photo_data_url(photo_path: String) -> AppResult<String> {
    let path = std::path::Path::new(&photo_path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpeg")
        .to_lowercase();

    // For RAW files, use sips to convert to JPEG
    let (bytes, mime) = if crate::thumbnail::generator::is_raw_format(path) {
        let tmp = Builder::new().suffix(".jpg").tempfile()?;
        let tmp_path = tmp.path();
        let output = std::process::Command::new("sips")
            .args([
                "-s",
                "format",
                "jpeg",
                "-s",
                "formatOptions",
                "90",
                &photo_path,
                "-o",
                tmp_path.to_str().unwrap(),
            ])
            .output()
            .map_err(|e| AppError::Io(e))?;
        if !output.status.success() {
            return Err(AppError::AiWorker(format!(
                "sips conversion failed: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }
        let bytes = tokio::fs::read(tmp_path).await?;
        drop(tmp); // cleanup temp
        (bytes, "image/jpeg")
    } else {
        let bytes = tokio::fs::read(&photo_path).await?;
        let mime = match ext.as_str() {
            "png" => "image/png",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => "image/jpeg",
        };
        (bytes, mime)
    };

    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, encoded))
}

#[tauri::command]
pub async fn cmd_get_thumbnail_processing_status(
    state: State<'_, AppState>,
) -> AppResult<ProcessingStatus> {
    let mut status = state.thumbnail_processor.get_status();
    let Ok(project) = current_project(&state) else {
        return Ok(status);
    };
    read_project_db(project, move |conn| {
        let (failed, last_failure_active) = conn.query_row(
            "SELECT COUNT(*), COUNT(*) FILTER (WHERE id=?1) > 0
             FROM photos WHERE thumbnail_status=-1 AND deleted=0 AND NOT EXISTS (
                 SELECT 1 FROM photo_task_ignores i WHERE i.photo_id=photos.id AND i.stage='thumbnail'
             )",
            [status.last_error_photo_id],
            |row| Ok((row.get::<_, usize>(0)?, row.get::<_, bool>(1)?)),
        )?;
        let task_error = status.last_error.is_some() && status.last_error_photo_id.is_none();
        status.failed = failed + usize::from(task_error);
        if status.last_error_photo_id.is_some() && !last_failure_active {
            status.last_error = None;
        }
        Ok(status)
    }).await
}

#[tauri::command]
pub fn cmd_get_thumbnail_performance(state: State<'_, AppState>) -> ThumbnailPerformance {
    state.thumbnail_processor.performance()
}

#[tauri::command]
pub fn cmd_set_thumbnail_performance(
    mode: ThumbnailPerformance,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.thumbnail_processor.set_performance(mode)?;
    THUMBNAIL_SLOT.notify_waiters();
    Ok(())
}

/// Scan all photos for missing thumbnails and regenerate them.
/// Checks both sharded and legacy thumbnail paths. Existing thumbnails are skipped.
#[tauri::command]
pub async fn cmd_rebuild_thumbnail_cache(state: State<'_, AppState>) -> AppResult<String> {
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".into()))?
            .clone()
    };
    let processor = state.thumbnail_processor.clone();
    if processor.is_running() {
        return Ok("Already processing thumbnails".to_string());
    }

    let project_clone = project.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = match crate::db::connection::init_db(&project_clone.db_path()) {
            Ok(c) => c,
            Err(_) => return,
        };
        let photos = match photo_dao::get_thumbnail_rebuild_candidates(&conn) {
            Ok(p) => p,
            Err(_) => return,
        };
        let out_dir = project_clone.small_thumbnails_path();
        let threshold = project_clone.thumbnail_threshold_mb * 1024 * 1024;
        let mut pending = 0;
        for (id, path, file_size, previously_failed) in &photos {
            let exists = crate::thumbnail::generator::find_thumbnail_path(path, &out_dir).is_some();
            let status = if exists {
                1
            } else if *previously_failed || *file_size > threshold {
                0
            } else {
                1
            };
            if status == 0 {
                pending += 1;
            }
            let _ = photo_dao::update_thumbnail_status(&conn, *id, status);
        }
        eprintln!(
            "Thumbnail rebuild: {} of {} photos need regeneration",
            pending,
            photos.len()
        );
        // Start batch processing for the newly marked pending photos
        processor.process_all(&project_clone);
    });

    Ok("Thumbnail cache rebuild started".to_string())
}

#[tauri::command]
pub async fn cmd_toggle_photo_favorite(
    photo_id: i64,
    state: State<'_, AppState>,
) -> AppResult<bool> {
    let conn = get_conn(state)?;
    conn.execute(
        "UPDATE photos SET is_favorite = NOT is_favorite WHERE id = ?",
        rusqlite::params![photo_id],
    )?;
    let is_now_favorite: i32 = conn.query_row(
        "SELECT is_favorite FROM photos WHERE id = ?",
        rusqlite::params![photo_id],
        |r| r.get(0),
    )?;
    Ok(is_now_favorite != 0)
}

#[tauri::command]
pub async fn cmd_update_photo_gps(
    photo_id: i64,
    latitude: Option<f64>,
    longitude: Option<f64>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let conn = get_conn(state.clone())?;

    // Get the photo's file path before updating DB
    let file_path: String = conn
        .query_row("SELECT path FROM photos WHERE id = ?", [photo_id], |r| {
            r.get(0)
        })
        .map_err(|_| crate::error::AppError::NotFound(format!("Photo {} not found", photo_id)))?;

    // The project database is PhotoFactory's source of truth. A packaged app
    // cannot assume the optional system `exiftool` executable is installed, so
    // metadata synchronization must never prevent the user from saving a pin.
    conn.execute(
        "UPDATE photos SET latitude = ?, longitude = ? WHERE id = ?",
        rusqlite::params![latitude, longitude, photo_id],
    )?;

    if let Err(error) = crate::scanner::exif_writer::write_gps_exif(&file_path, latitude, longitude)
    {
        eprintln!(
            "GPS saved to project database; EXIF synchronization skipped: {}",
            error
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_update_photos_gps(
    photo_ids: Vec<i64>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    state: State<'_, AppState>,
) -> AppResult<usize> {
    if photo_ids.is_empty() {
        return Ok(0);
    }
    if photo_ids.len() > 5000 {
        return Err(AppError::Project(
            "A GPS batch is limited to 5000 photos".to_string(),
        ));
    }
    if latitude.is_some() != longitude.is_some() {
        return Err(AppError::Project(
            "Latitude and longitude must be set or cleared together".to_string(),
        ));
    }

    let mut conn = get_conn(state)?;
    let tx = conn.transaction()?;
    let mut paths = Vec::with_capacity(photo_ids.len());
    {
        let mut path_stmt = tx.prepare("SELECT path FROM photos WHERE id = ?1 AND deleted = 0")?;
        let mut update_stmt = tx.prepare(
            "UPDATE photos SET latitude = ?1, longitude = ?2 WHERE id = ?3 AND deleted = 0",
        )?;
        for photo_id in &photo_ids {
            let path: String = path_stmt
                .query_row([photo_id], |row| row.get(0))
                .map_err(|_| AppError::NotFound(format!("Photo {} not found", photo_id)))?;
            update_stmt.execute(rusqlite::params![latitude, longitude, photo_id])?;
            paths.push(path);
        }
    }
    tx.commit()?;

    // Database updates are atomic and immediately visible. EXIF synchronization
    // is best effort and runs on one background thread so a large selection does
    // not freeze the editor or create hundreds of worker threads.
    std::thread::spawn(move || {
        for path in paths {
            if let Err(error) =
                crate::scanner::exif_writer::write_gps_exif(&path, latitude, longitude)
            {
                eprintln!(
                    "Batch GPS saved to project database; EXIF synchronization skipped for {}: {}",
                    path, error
                );
            }
        }
    });

    Ok(photo_ids.len())
}

/// Save independent coordinates for several photos in one transaction. This is
/// used by the per-photo draft workflow in the full-screen GPS editor.
#[tauri::command]
pub async fn cmd_update_photos_gps_individual(
    updates: Vec<PhotoGpsUpdate>,
    state: State<'_, AppState>,
) -> AppResult<usize> {
    if updates.is_empty() {
        return Ok(0);
    }
    if updates.len() > 5000 {
        return Err(AppError::Project(
            "A GPS batch is limited to 5000 photos".to_string(),
        ));
    }
    if updates
        .iter()
        .any(|item| item.latitude.is_some() != item.longitude.is_some())
    {
        return Err(AppError::Project(
            "Latitude and longitude must be set or cleared together".to_string(),
        ));
    }

    let mut conn = get_conn(state)?;
    let tx = conn.transaction()?;
    let mut exif_updates = Vec::with_capacity(updates.len());
    {
        let mut path_stmt = tx.prepare("SELECT path FROM photos WHERE id = ?1 AND deleted = 0")?;
        let mut update_stmt = tx.prepare(
            "UPDATE photos SET latitude = ?1, longitude = ?2 WHERE id = ?3 AND deleted = 0",
        )?;
        for item in &updates {
            let path: String = path_stmt
                .query_row([item.photo_id], |row| row.get(0))
                .map_err(|_| AppError::NotFound(format!("Photo {} not found", item.photo_id)))?;
            update_stmt.execute(rusqlite::params![
                item.latitude,
                item.longitude,
                item.photo_id
            ])?;
            exif_updates.push((path, item.latitude, item.longitude));
        }
    }
    tx.commit()?;

    std::thread::spawn(move || {
        for (path, latitude, longitude) in exif_updates {
            if let Err(error) =
                crate::scanner::exif_writer::write_gps_exif(&path, latitude, longitude)
            {
                eprintln!(
                    "GPS draft saved to project database; EXIF synchronization skipped for {}: {}",
                    path, error
                );
            }
        }
    });

    Ok(updates.len())
}
