// src-tauri/src/commands/smart_albums.rs
use tauri::State;

use crate::commands::project::{current_project, get_conn, read_project_db, AppState};
use crate::db::{memory_dao, smart_album_dao};
use crate::error::{AppError, AppResult};

#[tauri::command]
pub async fn cmd_get_photo_memories(
    state: State<'_, AppState>,
) -> AppResult<Vec<memory_dao::PhotoMemory>> {
    let project = current_project(&state)?;
    tokio::task::spawn_blocking(move || {
        use crate::db::connection::{init_db, open_read_db};
        let path = project.db_path();
        let conn = if path.is_file() {
            open_read_db(&path)?
        } else {
            init_db(&path)?
        };
        let ready = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = 'saved_photo_memories')",
            [],
            |row| row.get::<_, bool>(0),
        )?;
        let conn = if ready { conn } else { init_db(&path)? };
        let snapshot = conn.unchecked_transaction()?;
        let memories = memory_dao::get_memories(&snapshot, chrono::Local::now().date_naive())?;
        snapshot.commit()?;
        Ok(memories)
    })
    .await
    .map_err(|error| AppError::Internal(format!("回忆整理中断：{error}")))?
}

#[tauri::command]
pub async fn cmd_set_photo_memory_preferences(
    project_root: String,
    memory_id: i64,
    favorite: bool,
    tags: Vec<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let project = current_project(&state)?;
    if project.root_path != project_root {
        return Err(AppError::Project("照片库已切换。".into()));
    }
    tokio::task::spawn_blocking(move || {
        let mut conn = rusqlite::Connection::open_with_flags(
            project.db_path(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
        )?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        memory_dao::save_memory_preferences(
            &tx,
            chrono::Local::now().date_naive(),
            memory_id,
            favorite,
            tags,
        )?;
        tx.commit()?;
        Ok(())
    })
    .await
    .map_err(|error| AppError::Internal(format!("保存回忆中断：{error}")))?
}

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
    let project = current_project(&state)?;
    tokio::task::spawn_blocking(move || {
        let conn = crate::db::connection::init_db(&project.db_path())?;
        smart_album_dao::regenerate_smart_albums(&conn)
    })
    .await
    .map_err(|error| crate::error::AppError::Internal(format!("自动相册生成中断：{error}")))?
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

#[derive(serde::Serialize)]
pub struct GroupPhotoItem {
    photo: crate::models::Photo,
    people_count: i64,
    unconfirmed_count: i64,
}

#[tauri::command]
pub async fn cmd_get_named_photo_groups(
    size: i64,
    mut person_ids: Vec<i64>,
    exact: bool,
    offset: i64,
    state: State<'_, AppState>,
) -> AppResult<Vec<smart_album_dao::NamedPhotoGroup>> {
    let project = current_project(&state)?;
    person_ids.sort_unstable();
    person_ids.dedup();
    read_project_db(project, move |conn| {
        smart_album_dao::get_named_photo_groups(
            conn,
            &person_ids,
            size.clamp(0, 4),
            exact && !person_ids.is_empty(),
            offset,
            24,
        )
    })
    .await
}

#[tauri::command]
pub async fn cmd_get_group_photos(
    size: Option<i64>,
    mut person_ids: Vec<i64>,
    exact: bool,
    cursor: Option<i64>,
    named_only: Option<bool>,
    state: State<'_, AppState>,
) -> AppResult<Vec<GroupPhotoItem>> {
    let project = current_project(&state)?;
    person_ids.sort_unstable();
    person_ids.dedup();
    read_project_db(project, move |conn| {
        let snapshot = conn.unchecked_transaction()?;
        let rows = smart_album_dao::get_group_photos(
            &snapshot,
            &person_ids,
            size.unwrap_or(0).clamp(0, 4),
            exact && !person_ids.is_empty(),
            cursor,
            60,
            named_only.unwrap_or(false),
        )?;
        let mut items = Vec::with_capacity(rows.len());
        for row in rows {
            if let Some(photo) = crate::db::photo_dao::get_photo_by_id(&snapshot, row.photo_id)? {
                items.push(GroupPhotoItem {
                    photo,
                    people_count: row.people_count,
                    unconfirmed_count: row.unconfirmed_count,
                });
            }
        }
        snapshot.commit()?;
        Ok(items)
    })
    .await
}

#[tauri::command]
pub fn cmd_create_person_combination(
    name: String,
    person_ids: Vec<i64>,
    exact: bool,
    state: State<'_, AppState>,
) -> AppResult<i64> {
    let conn = get_conn(state)?;
    smart_album_dao::create_person_combination(&conn, &name, person_ids, exact)
}
