// src-tauri/src/commands/project.rs
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

use crate::db::connection::init_db;
use crate::db::photo_dao;
use crate::error::{AppError, AppResult};
use crate::models::{Project, ScanResult};
use crate::thumbnail::processor::ThumbnailProcessor;
use crate::{create_project, load_project, save_project_json};

fn last_project_path_file() -> std::path::PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("PhotoFactory")
        .join("last_project_path.txt")
}

pub struct AppState {
    pub project: Mutex<Option<Project>>,
    pub thumbnail_processor: Arc<ThumbnailProcessor>,
}

pub fn get_conn(state: State<'_, AppState>) -> AppResult<Connection> {
    let guard = state.project.lock().unwrap();
    let project = guard
        .as_ref()
        .ok_or_else(|| crate::error::AppError::NotFound("No database connection".to_string()))?;
    init_db(&project.db_path())
}

fn add_to_recent(root_path: &str) {
    let _ = std::fs::create_dir_all(recent_projects_file().parent().unwrap());
    let mut recent: Vec<String> = match std::fs::read_to_string(recent_projects_file()) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    recent.retain(|p| p != root_path);
    recent.insert(0, root_path.to_string());
    recent.truncate(10);
    if let Ok(json) = serde_json::to_string_pretty(&recent) {
        std::fs::write(recent_projects_file(), json).ok();
    }
}

#[tauri::command]
pub async fn cmd_create_project(
    root_path: String,
    name: String,
    state: State<'_, AppState>,
) -> AppResult<Project> {
    let project = create_project(&root_path, &name)?;
    *state.project.lock().unwrap() = Some(project.clone());
    std::fs::write(last_project_path_file(), &root_path).ok();
    add_to_recent(&root_path);
    Ok(project)
}

#[tauri::command]
pub async fn cmd_open_project(root_path: String, state: State<'_, AppState>) -> AppResult<Project> {
    let project = load_project(&root_path)?;
    *state.project.lock().unwrap() = Some(project.clone());
    std::fs::write(last_project_path_file(), &root_path).ok();
    add_to_recent(&root_path);
    Ok(project)
}

#[tauri::command]
pub async fn cmd_scan_project(state: State<'_, AppState>) -> AppResult<usize> {
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| crate::error::AppError::Project("No project open".to_string()))?
            .clone()
    };

    let count = tokio::task::spawn_blocking(move || {
        let conn = init_db(&project.db_path())?;
        scan_and_import_with_conn(&project, &conn)
    })
    .await
    .map_err(|e| crate::error::AppError::Project(e.to_string()))??;

    let mut guard = state.project.lock().unwrap();
    if let Some(p) = guard.as_mut() {
        let conn = init_db(&p.db_path())?;
        p.total_photos = photo_dao::get_photo_count(&conn)? as i64;
        p.last_scan = Some(chrono::Utc::now().to_rfc3339());
        save_project_json(p)?;
    }
    Ok(count)
}

fn scan_and_import_with_conn(project: &Project, conn: &Connection) -> AppResult<usize> {
    let result = incremental_scan_with_conn(project, conn)?;
    Ok(result.added + result.updated + result.restored)
}

#[tauri::command]
pub async fn cmd_get_project(state: State<'_, AppState>) -> AppResult<Option<Project>> {
    Ok(state.project.lock().unwrap().clone())
}

#[tauri::command]
pub async fn cmd_incremental_scan(state: State<'_, AppState>) -> AppResult<ScanResult> {
    let conn = get_conn(state.clone())?;
    let guard = state.project.lock().unwrap();
    let project = guard
        .as_ref()
        .ok_or_else(|| crate::error::AppError::Project("No project open".into()))?
        .clone();
    drop(guard);
    let result = incremental_scan_with_conn(&project, &conn)?;
    let mut guard = state.project.lock().unwrap();
    if let Some(p) = guard.as_mut() {
        p.total_photos = photo_dao::get_photo_count(&conn)? as i64;
        p.last_scan = Some(chrono::Utc::now().to_rfc3339());
        save_project_json(p)?;
    }
    Ok(result)
}

pub fn incremental_scan_with_conn(project: &Project, conn: &Connection) -> AppResult<ScanResult> {
    use crate::db::photo_dao;
    use crate::scanner::exif_reader;
    use crate::scanner::file_scanner;
    use std::path::Path;

    let extensions = &project.enabled_extensions;
    let files =
        file_scanner::scan_directory_with_extensions(Path::new(&project.root_path), extensions);
    let known_paths: Vec<String> = files.iter().map(|file| file.path.clone()).collect();
    let mut stmt = conn.prepare("SELECT id, path, file_size, file_mtime, deleted FROM photos")?;
    let existing: HashMap<String, (i64, i64, i64, bool)> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                (
                    row.get(0)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get::<_, i32>(4)? != 0,
                ),
            ))
        })?
        .collect::<Result<_, _>>()?;
    drop(stmt);

    let mut result = ScanResult::default();
    let mut invalidated_face_thumbnails = false;

    for file in &files {
        match existing.get(&file.path) {
            Some(&(id, old_size, old_mtime, was_deleted))
                if old_size == file.file_size && old_mtime == file.file_mtime =>
            {
                if was_deleted {
                    conn.execute("UPDATE photos SET deleted = 0 WHERE id = ?1", [id])?;
                    result.restored += 1;
                } else {
                    result.unchanged += 1;
                }
            }
            Some(&(id, _, _, _)) => {
                let exif = exif_reader::read_exif(Path::new(&file.path)).unwrap_or_default();
                for embedding_path in photo_dao::reset_photo_analysis(conn, id)? {
                    let _ = std::fs::remove_file(embedding_path);
                }
                conn.execute(
                    "UPDATE photos SET filename = ?1, file_size = ?2, file_mtime = ?3,
                        width = ?4, height = ?5, format = ?6, taken_at = ?7,
                        camera_make = ?8, camera_model = ?9, exposure_time = ?10,
                        f_number = ?11, iso = ?12, latitude = ?13, longitude = ?14,
                        orientation = ?15, thumbnail_status = 0, ai_status = 0,
                        face_status = 0, classification_status = 0, deleted = 0
                     WHERE id = ?16",
                    rusqlite::params![
                        file.filename,
                        file.file_size,
                        file.file_mtime,
                        exif.width,
                        exif.height,
                        Path::new(&file.path)
                            .extension()
                            .and_then(|value| value.to_str())
                            .map(str::to_lowercase),
                        exif.taken_at,
                        exif.camera_make,
                        exif.camera_model,
                        exif.exposure_time,
                        exif.f_number,
                        exif.iso,
                        exif.latitude,
                        exif.longitude,
                        exif.orientation,
                        id,
                    ],
                )?;
                for directory in [
                    project.small_thumbnails_path(),
                    project.medium_thumbnails_path(),
                    project.large_thumbnails_path(),
                ] {
                    if let Some(path) =
                        crate::thumbnail::generator::find_thumbnail_path(&file.path, &directory)
                    {
                        let _ = std::fs::remove_file(path);
                    }
                }
                invalidated_face_thumbnails = true;
                result.updated += 1;
            }
            None => {
                let exif = exif_reader::read_exif(Path::new(&file.path)).unwrap_or_default();
                photo_dao::insert_photo(conn, file, &exif)?;
                result.added += 1;
            }
        }
    }

    result.deleted = photo_dao::mark_deleted_photos(conn, &known_paths)?;
    if invalidated_face_thumbnails {
        let directory = project
            .faces_cache_path()
            .parent()
            .unwrap()
            .join("face_thumbnails");
        let _ = std::fs::remove_dir_all(directory);
    }

    let mut project = project.clone();
    project.last_scan = Some(chrono::Utc::now().to_rfc3339());
    project.total_photos = photo_dao::get_photo_count(conn)?;
    save_project_json(&project)?;

    Ok(result)
}

fn recent_projects_file() -> std::path::PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("PhotoFactory")
        .join("recent_projects.json")
}

/// Save a project path to the recent projects history (max 10, LRU).
#[tauri::command]
pub async fn cmd_add_recent_project(root_path: String) -> AppResult<()> {
    let path = recent_projects_file();
    let mut recent: Vec<String> = match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    // Remove existing entry to move it to the front
    recent.retain(|p| p != &root_path);
    recent.insert(0, root_path);

    // Keep only top 10
    recent.truncate(10);

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    if let Ok(json) = serde_json::to_string_pretty(&recent) {
        std::fs::write(&path, json).ok();
    }
    Ok(())
}

/// Get the recent projects history.
#[tauri::command]
pub async fn cmd_get_recent_projects() -> AppResult<Vec<String>> {
    let path = recent_projects_file();
    match std::fs::read_to_string(&path) {
        Ok(s) => match serde_json::from_str(&s) {
            Ok(recent) => Ok(recent),
            Err(_) => Ok(Vec::new()),
        },
        Err(_) => Ok(Vec::new()),
    }
}

/// Remove a specific project from recent history.
#[tauri::command]
pub async fn cmd_remove_recent_project(root_path: String) -> AppResult<()> {
    let path = recent_projects_file();
    let mut recent: Vec<String> = match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    recent.retain(|p| p != &root_path);

    if let Ok(json) = serde_json::to_string_pretty(&recent) {
        std::fs::write(&path, json).ok();
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_save_last_project_path(root_path: String) -> AppResult<()> {
    std::fs::write(last_project_path_file(), &root_path)?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_get_last_project_path() -> AppResult<Option<String>> {
    match std::fs::read_to_string(last_project_path_file()) {
        Ok(path) => Ok(Some(path.trim().to_string())),
        Err(_) => Ok(None),
    }
}

/// Clear the current project from memory state.
#[tauri::command]
pub async fn cmd_close_project(state: State<'_, AppState>) -> AppResult<()> {
    *state.project.lock().unwrap() = None;
    // A deliberate close should not silently reopen the same project next launch.
    match std::fs::remove_file(last_project_path_file()) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

/// Update the enabled extensions for the current project and persist to project.json.
#[tauri::command]
pub async fn cmd_update_extensions(
    extensions: Vec<String>,
    state: State<'_, AppState>,
) -> AppResult<Project> {
    let conn = get_conn(state.clone())?;
    let mut guard = state.project.lock().unwrap();
    let project = guard
        .as_mut()
        .ok_or_else(|| crate::error::AppError::Project("No project open".into()))?;

    project.enabled_extensions = extensions;
    project.total_photos = photo_dao::get_photo_count(&conn)?;
    crate::save_project_json(project)?;

    Ok(project.clone())
}

#[tauri::command]
pub async fn cmd_trigger_auto_ai(
    state: State<'_, AppState>,
    worker_state: State<'_, crate::commands::ai::AiWorkerState>,
    app_handle: tauri::AppHandle,
) -> AppResult<String> {
    {
        let conn = get_conn(state.clone())?;
        let control = crate::db::ai_task_dao::pipeline_control_status(&conn)?;
        if control == "paused" {
            return Ok("AI pipeline is paused; resume it from the progress controls".into());
        }
    }
    let (pending, unassigned_faces) = {
        let guard = state.project.lock().unwrap();
        if let Some(p) = guard.as_ref() {
            let conn = init_db(&p.db_path()).ok();
            if let Some(c) = conn {
                (
                    crate::db::photo_dao::get_pending_ai_count(&c).unwrap_or(0),
                    crate::db::face_dao::get_unassigned_face_count(&c).unwrap_or(0),
                )
            } else {
                (0, 0)
            }
        } else {
            (0, 0)
        }
    };

    if pending == 0 && unassigned_faces == 0 {
        let conn = get_conn(state.clone())?;
        crate::db::ai_task_dao::set_pipeline_state(&conn, "done", "done", 0, 0, 0, None)?;
        return Ok("No pending AI work".into());
    }

    crate::db::ai_task_dao::set_pipeline_control(&get_conn(state.clone())?, "running")?;

    if worker_state
        .pipeline_running
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return Ok("AI pipeline is already running in the background".into());
    }

    // Clone app_handle for the spawned task
    let handle = app_handle.clone();

    // Spawn AI pipeline in background
    tokio::spawn(async move {
        let app_state = handle.try_state::<AppState>().unwrap();
        let worker = handle
            .try_state::<crate::commands::ai::AiWorkerState>()
            .unwrap();
        let handle2 = handle.clone();
        let _ = crate::commands::ai::run_auto_ai_pipeline_inner(app_state, worker.clone(), handle2)
            .await;
        worker
            .pipeline_running
            .store(false, std::sync::atomic::Ordering::SeqCst);
    });

    Ok(format!(
        "AI pipeline started for {} pending photos and {} ungrouped faces",
        pending, unassigned_faces
    ))
}

#[tauri::command]
pub async fn cmd_control_ai_pipeline(
    action: String,
    state: State<'_, AppState>,
    worker_state: State<'_, crate::commands::ai::AiWorkerState>,
    app_handle: tauri::AppHandle,
) -> AppResult<String> {
    let conn = get_conn(state.clone())?;
    match action.as_str() {
        "pause" => {
            crate::db::ai_task_dao::set_pipeline_control(&conn, "paused")?;
            Ok("AI pipeline paused after the current photo batch".into())
        }
        "cancel" => {
            crate::db::ai_task_dao::set_pipeline_control(&conn, "canceled")?;
            Ok("AI pipeline canceled; completed photos remain saved".into())
        }
        "retry" => {
            crate::db::ai_task_dao::retry_failed(&conn)?;
            crate::db::ai_task_dao::set_pipeline_control(&conn, "running")?;
            drop(conn);
            cmd_trigger_auto_ai(state, worker_state, app_handle).await
        }
        "resume" => {
            crate::db::ai_task_dao::set_pipeline_control(&conn, "running")?;
            drop(conn);
            cmd_trigger_auto_ai(state, worker_state, app_handle).await
        }
        _ => Err(AppError::Project("Unsupported AI pipeline action".into())),
    }
}

/// Explicit user action from the Tags page: rerun content classification for
/// every active photo. Face detection remains cached and is not repeated.
#[tauri::command]
pub async fn cmd_recalculate_ai_tags(
    state: State<'_, AppState>,
    worker_state: State<'_, crate::commands::ai::AiWorkerState>,
    app_handle: tauri::AppHandle,
) -> AppResult<String> {
    {
        let conn = get_conn(state.clone())?;
        conn.execute(
            "UPDATE photos SET classification_status = 0 WHERE deleted = 0",
            [],
        )?;
    }
    cmd_trigger_auto_ai(state, worker_state, app_handle).await
}

pub fn try_load_last_project() -> Option<Project> {
    let path = std::fs::read_to_string(last_project_path_file()).ok()?;
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    load_project(path).ok()
}

#[cfg(test)]
mod incremental_scan_tests {
    use super::*;

    #[test]
    fn unchanged_photos_keep_analysis_and_changed_photos_are_requeued() {
        let directory = tempfile::Builder::new()
            .prefix("photofactory-scan-")
            .tempdir_in(std::env::temp_dir())
            .unwrap();
        std::fs::create_dir_all(directory.path().join(".pf")).unwrap();
        let photo_path = directory.path().join("新增照片.jpg");
        std::fs::write(&photo_path, b"first").unwrap();

        let project = Project::new("test".into(), directory.path().to_string_lossy().into());
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema::CREATE_TABLES)
            .unwrap();

        let first = incremental_scan_with_conn(&project, &conn).unwrap();
        assert_eq!(first.added, 1);
        let photo_id: i64 = conn
            .query_row("SELECT id FROM photos", [], |row| row.get(0))
            .unwrap();
        conn.execute(
            "UPDATE photos SET face_status = 1, classification_status = 1 WHERE id = ?1",
            [photo_id],
        )
        .unwrap();

        let second = incremental_scan_with_conn(&project, &conn).unwrap();
        assert_eq!(second.unchanged, 1);
        assert_eq!(second.added, 0);
        let statuses: (i32, i32) = conn
            .query_row(
                "SELECT face_status, classification_status FROM photos WHERE id = ?1",
                [photo_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(statuses, (1, 1));

        std::fs::write(&photo_path, b"source really changed").unwrap();
        let third = incremental_scan_with_conn(&project, &conn).unwrap();
        assert_eq!(third.updated, 1);
        let statuses: (i32, i32) = conn
            .query_row(
                "SELECT face_status, classification_status FROM photos WHERE id = ?1",
                [photo_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(statuses, (0, 0));
    }
}
