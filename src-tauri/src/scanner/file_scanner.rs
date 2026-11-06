use std::fs;
use std::path::Path;
use std::time::SystemTime;
use walkdir::WalkDir;

use crate::models::SUPPORTED_EXTENSIONS;

#[derive(Debug, Clone)]
pub struct FileInfo {
    pub path: String,
    pub filename: String,
    pub file_size: i64,
    pub file_mtime: i64,
}

pub fn scan_directory(root: &Path) -> Vec<FileInfo> {
    WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| !is_hidden(e))
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| is_supported_image(e.path()))
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = fs::metadata(path).ok()?;
            let mtime = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            Some(FileInfo {
                path: path.to_string_lossy().to_string(),
                filename: path.file_name()?.to_string_lossy().to_string(),
                file_size: metadata.len() as i64,
                file_mtime: mtime,
            })
        })
        .collect()
}

/// Scan directory filtering by a list of extensions (case-insensitive).
pub fn scan_directory_with_extensions(root: &Path, extensions: &[String]) -> Vec<FileInfo> {
    let ext_set: std::collections::HashSet<String> =
        extensions.iter().map(|e| e.to_lowercase()).collect();

    WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| !is_hidden(e))
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| is_matching_extension(e.path(), &ext_set))
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = fs::metadata(path).ok()?;
            let mtime = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            Some(FileInfo {
                path: path.to_string_lossy().to_string(),
                filename: path.file_name()?.to_string_lossy().to_string(),
                file_size: metadata.len() as i64,
                file_mtime: mtime,
            })
        })
        .collect()
}

fn is_matching_extension(path: &Path, extensions: &std::collections::HashSet<String>) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| extensions.contains(&e.to_lowercase()))
        .unwrap_or(false)
}

fn is_hidden(entry: &walkdir::DirEntry) -> bool {
    entry
        .file_name()
        .to_str()
        .map(|s| s.starts_with('.') || s == ".pf")
        .unwrap_or(false)
}

fn is_supported_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| SUPPORTED_EXTENSIONS.contains(&e.to_lowercase().trim_start_matches('.')))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_is_supported_image() {
        assert!(is_supported_image(Path::new("photo.jpg")));
        assert!(is_supported_image(Path::new("photo.JPEG")));
        assert!(is_supported_image(Path::new("photo.png")));
        assert!(is_supported_image(Path::new("photo.HEIC")));
        assert!(!is_supported_image(Path::new("video.mp4")));
        assert!(!is_supported_image(Path::new("readme.txt")));
    }

    #[test]
    fn test_scan_directory_finds_images() {
        let dir = std::env::temp_dir().join("pf_scan_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // Create a fake jpg file
        fs::write(dir.join("test.jpg"), "fake").unwrap();
        fs::write(dir.join("test.txt"), "fake").unwrap();
        fs::create_dir_all(dir.join(".hidden")).unwrap();
        fs::write(dir.join(".hidden/secret.jpg"), "fake").unwrap();

        let results = scan_directory(&dir);
        assert_eq!(results.len(), 1);
        assert!(results[0].filename == "test.jpg");
        assert!(results[0].file_size > 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_scan_directory_with_extensions() {
        let dir = std::env::temp_dir().join("pf_ext_filter_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("photo1.JPG"), "fake").unwrap();
        fs::write(dir.join("photo2.jpeg"), "fake").unwrap();
        fs::write(dir.join("photo3.PNG"), "fake").unwrap();
        fs::write(dir.join("photo4.HEIC"), "fake").unwrap();
        fs::write(dir.join("photo5.cr2"), "fake").unwrap();
        fs::write(dir.join("photo6.txt"), "fake").unwrap();

        // Only common formats
        let exts = vec!["jpg".into(), "jpeg".into(), "png".into()];
        let results = scan_directory_with_extensions(&dir, &exts);
        assert_eq!(results.len(), 3);

        // Include HEIC
        let exts = vec!["jpg".into(), "jpeg".into(), "png".into(), "heic".into()];
        let results = scan_directory_with_extensions(&dir, &exts);
        assert_eq!(results.len(), 4);

        // Empty — nothing matches
        let results = scan_directory_with_extensions(&dir, &[]);
        assert_eq!(results.len(), 0);

        let _ = fs::remove_dir_all(&dir);
    }
}
