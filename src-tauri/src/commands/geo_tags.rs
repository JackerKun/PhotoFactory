// src-tauri/src/commands/geo_tags.rs
//
// Tauri command for running GPS reverse-geocoding on photos.

use tauri::State;

use crate::commands::project::{get_conn, AppState};
use crate::error::{AppError, AppResult};
use crate::geo_tagger::GeoTagger;

/// Run GPS reverse-geocoding on photos that have GPS coordinates but no
/// geo_location tag yet.
///
/// Returns the number of photos successfully tagged.
#[tauri::command]
pub async fn cmd_run_geo_tagging(
    batch_size: Option<usize>,
    state: State<'_, AppState>,
) -> AppResult<usize> {
    let conn = get_conn(state.clone())?;
    let limit = batch_size.unwrap_or(100);

    // Run the blocking HTTP calls in a spawn_blocking task
    let result = tokio::task::spawn_blocking(move || {
        let tagger = GeoTagger::new();
        tagger.tag_photos(&conn, limit)
    })
    .await
    .map_err(|e| AppError::Internal(format!("Geo tagging task panicked: {}", e)))??;

    Ok(result)
}
