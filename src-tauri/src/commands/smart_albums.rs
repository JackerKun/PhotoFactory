// src-tauri/src/commands/smart_albums.rs
use tauri::State;

use crate::commands::project::{get_conn, AppState};
use crate::db::smart_album_dao;
use crate::error::AppResult;

/// Get all smart albums with photo counts.
#[tauri::command]
pub async fn cmd_get_smart_albums(
    state: State<'_, AppState>,
) -> AppResult<Vec<smart_album_dao::SmartAlbum>> {
    let conn = get_conn(state)?;
    smart_album_dao::get_all_smart_albums(&conn)
}

/// Get photos in a smart album with pagination.
#[tauri::command]
pub async fn cmd_get_smart_album_photos(
    album_id: i64,
    cursor: Option<i64>,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> AppResult<Vec<(i64, i64)>> {
    let conn = get_conn(state)?;
    smart_album_dao::get_album_photos(&conn, album_id, cursor, limit.unwrap_or(100))
}

/// Regenerate all smart albums. Returns the number of albums created.
#[tauri::command]
pub async fn cmd_regenerate_smart_albums(state: State<'_, AppState>) -> AppResult<i64> {
    let conn = get_conn(state)?;
    smart_album_dao::regenerate_smart_albums(&conn)
}

#[tauri::command]
pub async fn cmd_create_manual_album(name: String, state: State<'_, AppState>) -> AppResult<i64> {
    let conn = get_conn(state)?;
    smart_album_dao::create_manual_album(&conn, &name)
}

#[tauri::command]
pub async fn cmd_rename_album(
    album_id: i64,
    name: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let conn = get_conn(state)?;
    smart_album_dao::rename_album(&conn, album_id, &name)
}

#[tauri::command]
pub async fn cmd_delete_album(album_id: i64, state: State<'_, AppState>) -> AppResult<()> {
    let conn = get_conn(state)?;
    smart_album_dao::delete_album(&conn, album_id)
}

#[tauri::command]
pub async fn cmd_add_photos_to_album(
    album_id: i64,
    photo_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> AppResult<i64> {
    let conn = get_conn(state)?;
    smart_album_dao::add_photos_to_album(&conn, album_id, &photo_ids)
}

#[tauri::command]
pub async fn cmd_remove_photos_from_album(
    album_id: i64,
    photo_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> AppResult<i64> {
    let conn = get_conn(state)?;
    smart_album_dao::remove_photos_from_album(&conn, album_id, &photo_ids)
}

#[tauri::command]
pub async fn cmd_set_album_cover(
    album_id: i64,
    photo_id: i64,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let conn = get_conn(state)?;
    smart_album_dao::set_album_cover(&conn, album_id, photo_id)
}
