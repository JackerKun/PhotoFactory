pub mod ai_worker;
pub mod commands;
pub mod db;
pub mod device_tagger;
pub mod error;
pub mod geo_tagger;
pub mod models;
pub mod offline_maps;
pub mod process;
pub mod scanner;
pub mod tags;
pub mod thumbnail;
pub mod time_tagger;

pub use commands::project::AppState;

use std::fs;
use std::path::Path;

use crate::error::{AppError, AppResult};
use crate::models::Project;

pub fn create_project(root_path: &str, name: &str) -> AppResult<Project> {
    let project = Project::new(name.to_string(), root_path.to_string());
    let pf = project.pf_path();
    fs::create_dir_all(&pf)?;
    fs::create_dir_all(project.small_thumbnails_path())?;
    fs::create_dir_all(project.large_thumbnails_path())?;
    fs::create_dir_all(project.tiles_path())?;
    fs::create_dir_all(project.faces_cache_path())?;
    fs::create_dir_all(project.tags_cache_path())?;

    save_project_json(&project)?;
    Ok(project)
}

pub fn load_project(root_path: &str) -> AppResult<Project> {
    let project_json = Path::new(root_path).join(".pf/project.json");
    if !project_json.exists() {
        return Err(AppError::Project(format!(
            "No .pf project found at {}",
            root_path
        )));
    }
    let content = fs::read_to_string(&project_json)?;
    let project: Project = serde_json::from_str(&content)?;
    Ok(project)
}

pub fn save_project_json(project: &Project) -> AppResult<()> {
    let content = serde_json::to_string_pretty(project)?;
    fs::write(project.project_json_path(), content)?;
    Ok(())
}

pub fn scan_and_import(project: &Project) -> AppResult<usize> {
    use crate::db::connection::init_db;
    let conn = init_db(&project.db_path())?;
    let result = crate::commands::project::incremental_scan_with_conn(project, &conn)?;
    Ok(result.added + result.updated + result.restored)
}

pub fn incremental_scan(project: &Project) -> AppResult<(usize, usize, usize)> {
    use crate::db::connection::init_db;
    let conn = init_db(&project.db_path())?;
    let result = crate::commands::project::incremental_scan_with_conn(project, &conn)?;
    Ok((
        result.added + result.updated + result.restored,
        result.deleted,
        result.changed(),
    ))
}
