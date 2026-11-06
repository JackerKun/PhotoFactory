use tauri::State;

use crate::commands::project::{get_conn, AppState};
use crate::error::AppResult;

/// Run all rule-based tagging on photos.
#[tauri::command]
pub async fn cmd_run_tag_rules(state: State<'_, AppState>) -> AppResult<String> {
    let conn = get_conn(state.clone())?;
    let mut messages = Vec::new();

    // 1. Face count tags
    match crate::tags::face_tagger::run_face_tagging(&conn, 500) {
        Ok(count) => messages.push(format!("Face count tags: {} photos", count)),
        Err(e) => messages.push(format!("Face count tagging failed: {}", e)),
    }

    // 2. Time period tags (will be added in Task 4)
    match crate::tags::time_tagger::run_time_period_tagging(&conn, 500) {
        Ok(count) => messages.push(format!("Time period tags: {} photos", count)),
        Err(e) => messages.push(format!("Time period tagging failed: {}", e)),
    }

    // 3. Season tags (will be added in Task 4)
    match crate::tags::time_tagger::run_season_tagging(&conn, 500) {
        Ok(count) => messages.push(format!("Season tags: {} photos", count)),
        Err(e) => messages.push(format!("Season tagging failed: {}", e)),
    }

    // Drop the connection before the async step (Connection is not Send/Sync)
    drop(conn);

    // 4. Weather tags (three-phase: query -> async HTTP -> save)
    let query_conn = get_conn(state.clone())?;
    let weather_photos = crate::tags::weather_tagger::query_weather_photos(&query_conn, 100);
    drop(query_conn);

    if let Ok(photos) = weather_photos {
        let results = crate::tags::weather_tagger::run_weather_tagging(photos).await;
        let save_conn = get_conn(state.clone())?;
        let count = crate::tags::weather_tagger::save_weather_tagging(&save_conn, &results);
        messages.push(format!("Weather tags: {} photos", count));
        drop(save_conn);
    }

    // Re-acquire connection for remaining sync operations
    let conn = get_conn(state.clone())?;

    // 5. Tone tags (will be added in Task 6)
    match crate::tags::tone_tagger::run_tone_tagging(&conn, 500) {
        Ok(count) => messages.push(format!("Tone tags: {} photos", count)),
        Err(e) => messages.push(format!("Tone tagging failed: {}", e)),
    }

    Ok(messages.join("\n"))
}
