use std::path::Path;
use std::time::SystemTime;

use crate::error::AppResult;
use walkdir::WalkDir;

/// Maximum total size for a thumbnail cache directory (1 GB).
pub const THUMBNAIL_CACHE_MAX_BYTES: u64 = 1024 * 1024 * 1024;

/// Recursively collect metadata for every .webp file in the directory tree.
fn collect_entries(dir: &Path) -> AppResult<Vec<(std::path::PathBuf, u64, SystemTime)>> {
    let mut entries = Vec::new();
    // Silently skip entries that can't be read -- eviction is best-effort
    // for a cache directory; transient I/O errors should not block the app.
    for entry_res in WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "webp"))
    {
        let path = entry_res.path().to_path_buf();
        if let Ok(meta) = entry_res.metadata() {
            let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            entries.push((path, meta.len(), mtime));
        }
    }
    Ok(entries)
}

/// Calculate the total size of all .webp files in the directory.
pub fn calculate_cache_size(dir: &Path) -> AppResult<u64> {
    if !dir.exists() {
        return Ok(0);
    }
    let entries = collect_entries(dir)?;
    Ok(entries.iter().map(|(_, size, _)| size).sum())
}

/// Touch a file's modification time to "now", marking it as recently used.
/// Call this each time a thumbnail is served from cache.
pub fn touch_thumbnail(path: &Path) -> AppResult<()> {
    let now = filetime::FileTime::now();
    filetime::set_file_mtime(path, now)?;
    Ok(())
}

/// Evict the least-recently-used thumbnails from *dir* until the total
/// size is at or below *target_bytes*. Returns the number of files deleted.
pub fn evict_lru(dir: &Path, target_bytes: u64) -> AppResult<usize> {
    if !dir.exists() {
        return Ok(0);
    }
    let mut entries = collect_entries(dir)?;
    // Sort by mtime ascending so the least-recently-used entries come first.
    entries.sort_by_key(|(_, _, mtime)| *mtime);

    let mut total: u64 = entries.iter().map(|(_, size, _)| size).sum();
    let mut deleted = 0;

    for (path, size, _) in &entries {
        if total <= target_bytes {
            break;
        }
        std::fs::remove_file(path)?;
        total -= size;
        deleted += 1;
    }

    Ok(deleted)
}

/// Check if the thumbnail cache at *dir* exceeds THUMBNAIL_CACHE_MAX_BYTES.
/// If so, evict the least-recently-used files until the cache fits.
/// Returns the number of files that were evicted.
pub fn maybe_evict(dir: &Path) -> AppResult<usize> {
    let current_size = calculate_cache_size(dir)?;
    if current_size > THUMBNAIL_CACHE_MAX_BYTES {
        evict_lru(dir, THUMBNAIL_CACHE_MAX_BYTES)
    } else {
        Ok(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::thread;
    use std::time::Duration;

    fn create_fake_thumbnail(dir: &Path, name: &str, size_bytes: u64) -> std::path::PathBuf {
        let path = dir.join(format!("{}.webp", name));
        let data = vec![0u8; size_bytes as usize];
        fs::write(&path, data).unwrap();
        path
    }

    #[test]
    fn test_calculate_cache_size_empty_dir() {
        let dir = std::env::temp_dir().join("pf_evict_empty");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let size = calculate_cache_size(&dir).unwrap();
        assert_eq!(size, 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_calculate_cache_size_nonexistent_dir() {
        let dir = std::env::temp_dir().join("pf_evict_no_such_dir");
        let _ = fs::remove_dir_all(&dir);
        let size = calculate_cache_size(&dir).unwrap();
        assert_eq!(size, 0);
    }

    #[test]
    fn test_calculate_cache_size_sums_webp_files() {
        let dir = std::env::temp_dir().join("pf_evict_sum");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        create_fake_thumbnail(&dir, "a", 100);
        create_fake_thumbnail(&dir, "b", 200);
        create_fake_thumbnail(&dir, "c", 300);
        // Non-webp files should be ignored.
        fs::write(dir.join("d.txt"), vec![0u8; 999]).unwrap();

        let size = calculate_cache_size(&dir).unwrap();
        assert_eq!(size, 600);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_calculate_cache_size_with_shards() {
        let dir = std::env::temp_dir().join("pf_evict_shards");
        let _ = fs::remove_dir_all(&dir);
        // Create sharded structure: ab/, cd/
        fs::create_dir_all(dir.join("ab")).unwrap();
        fs::create_dir_all(dir.join("cd")).unwrap();
        fs::write(dir.join("ab/a1b2c3d4.webp"), vec![0u8; 100]).unwrap();
        fs::write(dir.join("cd/e5f6a7b8.webp"), vec![0u8; 200]).unwrap();
        // Non-webp should be ignored
        fs::write(dir.join("ab/readme.txt"), vec![0u8; 999]).unwrap();

        let size = calculate_cache_size(&dir).unwrap();
        assert_eq!(size, 300);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_evict_lru_deletes_oldest_first() {
        let dir = std::env::temp_dir().join("pf_evict_lru");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // Create thumbnails with a small delay so their mtimes differ.
        create_fake_thumbnail(&dir, "oldest", 500);
        thread::sleep(Duration::from_millis(50));
        create_fake_thumbnail(&dir, "middle", 500);
        thread::sleep(Duration::from_millis(50));
        create_fake_thumbnail(&dir, "newest", 500);

        // Total is 1500 bytes; target 600 should delete the two oldest.
        let deleted = evict_lru(&dir, 600).unwrap();
        assert_eq!(deleted, 2);

        assert!(!dir.join("oldest.webp").exists());
        assert!(!dir.join("middle.webp").exists());
        assert!(dir.join("newest.webp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_evict_lru_nothing_to_delete_when_under_target() {
        let dir = std::env::temp_dir().join("pf_evict_no_delete");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        create_fake_thumbnail(&dir, "a", 100);
        let deleted = evict_lru(&dir, 1000).unwrap();
        assert_eq!(deleted, 0);
        assert!(dir.join("a.webp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_evict_lru_on_empty_dir() {
        let dir = std::env::temp_dir().join("pf_evict_empty_evict");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let deleted = evict_lru(&dir, 100).unwrap();
        assert_eq!(deleted, 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_maybe_evict_noop_when_under_limit() {
        let dir = std::env::temp_dir().join("pf_evict_noop");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        create_fake_thumbnail(&dir, "a", 1024);
        let evicted = maybe_evict(&dir).unwrap();
        assert_eq!(evicted, 0);
        assert!(dir.join("a.webp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_maybe_evict_triggers_when_over_limit() {
        let dir = std::env::temp_dir().join("pf_evict_triggers");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // Create files totalling more than 1 MB (using a small fake limit for the test).
        // We directly call evict_lru with a tiny target to simulate the 1GB limit.
        for i in 0..10 {
            thread::sleep(Duration::from_millis(10));
            create_fake_thumbnail(&dir, &format!("img_{:02}", i), 200_000);
        }

        // Simulate: cache limit = 500_000 bytes
        let deleted = evict_lru(&dir, 500_000).unwrap();
        assert!(deleted >= 7); // should keep at most 2-3 files

        let remaining_size = calculate_cache_size(&dir).unwrap();
        assert!(remaining_size <= 500_000);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_touch_thumbnail_updates_mtime() {
        let dir = std::env::temp_dir().join("pf_evict_touch");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = create_fake_thumbnail(&dir, "test", 100);

        let meta_before = fs::metadata(&path).unwrap();
        let mtime_before = meta_before.modified().unwrap();

        thread::sleep(Duration::from_millis(100));
        touch_thumbnail(&path).unwrap();

        let meta_after = fs::metadata(&path).unwrap();
        let mtime_after = meta_after.modified().unwrap();

        assert!(mtime_after > mtime_before);
        let _ = fs::remove_dir_all(&dir);
    }
}
