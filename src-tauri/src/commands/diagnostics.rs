// src-tauri/src/commands/diagnostics.rs
use tauri::State;

use crate::commands::project::AppState;
use crate::db::diagnostics;
use crate::db::diagnostics::{DiagnosticsReport, IndexRebuildResult, IntegrityCheckResult};
use crate::error::{AppError, AppResult};

/// Run full diagnostics on the current project database.
#[tauri::command]
pub fn cmd_run_diagnostics(state: State<'_, AppState>) -> AppResult<DiagnosticsReport> {
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".into()))?
            .clone()
    };

    diagnostics::run_diagnostics(&project.db_path())
}

/// Run a database integrity check on the current project.
#[tauri::command]
pub fn cmd_check_integrity(state: State<'_, AppState>) -> AppResult<IntegrityCheckResult> {
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".into()))?
            .clone()
    };

    diagnostics::check_integrity(&project.db_path())
}

/// Rebuild all database indexes and vacuum the database.
#[tauri::command]
pub fn cmd_rebuild_indexes(state: State<'_, AppState>) -> AppResult<IndexRebuildResult> {
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".into()))?
            .clone()
    };

    diagnostics::rebuild_indexes(&project.db_path())
}

/// Clean up orphaned records referencing deleted or missing photos.
#[tauri::command]
pub fn cmd_cleanup_orphans(state: State<'_, AppState>) -> AppResult<(usize, usize, usize)> {
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".into()))?
            .clone()
    };

    diagnostics::cleanup_orphans(&project.db_path())
}
