use crate::error::AppResult;

#[tauri::command]
pub async fn cmd_reveal_in_file_manager(path: String) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()?;

    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", path))
        .spawn()?;

    #[cfg(target_os = "linux")]
    {
        use std::path::Path;
        let parent = Path::new(&path).parent().unwrap_or(Path::new(&path));
        std::process::Command::new("xdg-open").arg(parent).spawn()?;
    }

    Ok(())
}
