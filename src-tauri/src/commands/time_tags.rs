// src-tauri/src/commands/time_tags.rs
//
// Tauri commands for time-based and device tagging.

use tauri::State;

use crate::commands::project::{get_conn, AppState};
use crate::device_tagger;
use crate::error::{AppError, AppResult};
use crate::time_tagger;

/// Run time-based tagging on photos that have timestamps but no time_period tag.
///
/// Generates tags like "2024年夏" and holiday names (e.g., "国庆", "圣诞").
///
/// Returns the number of photos successfully tagged.
#[tauri::command]
pub async fn cmd_run_time_tagging(
    batch_size: Option<usize>,
    state: State<'_, AppState>,
) -> AppResult<usize> {
    let conn = get_conn(state.clone())?;
    let limit = batch_size.unwrap_or(500);

    let result = tokio::task::spawn_blocking(move || time_tagger::run_time_tagging(&conn, limit))
        .await
        .map_err(|e| AppError::Internal(format!("Time tagging task panicked: {}", e)))??;

    Ok(result)
}

/// Run device tagging on photos that have camera_make but no device tag.
///
/// Generates device labels like "Apple iPhone 15" or "Canon".
///
/// Returns the number of photos successfully tagged.
#[tauri::command]
pub async fn cmd_run_device_tagging(
    batch_size: Option<usize>,
    state: State<'_, AppState>,
) -> AppResult<usize> {
    let conn = get_conn(state.clone())?;
    let limit = batch_size.unwrap_or(500);

    let result =
        tokio::task::spawn_blocking(move || device_tagger::run_device_tagging(&conn, limit))
            .await
            .map_err(|e| AppError::Internal(format!("Device tagging task panicked: {}", e)))??;

    Ok(result)
}

/// Run event tagging on photos that have geo_location tags.
///
/// Groups photos by location and consecutive date clusters (gap <= 2 days),
/// creating event tags like "东京之旅 2024" for clusters with 2+ days and 20+ photos.
///
/// Returns the number of events created.
#[tauri::command]
pub async fn cmd_run_event_tagging(state: State<'_, AppState>) -> AppResult<usize> {
    let conn = get_conn(state.clone())?;

    let result = tokio::task::spawn_blocking(move || time_tagger::run_event_tagging(&conn))
        .await
        .map_err(|e| AppError::Internal(format!("Event tagging task panicked: {}", e)))??;

    Ok(result)
}
