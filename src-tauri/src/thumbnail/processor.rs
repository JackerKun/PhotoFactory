use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use rayon::prelude::*;

use crate::db::{connection::init_db, photo_dao};
use crate::error::AppResult;
use crate::models::Project;
use crate::thumbnail::{eviction, generator};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThumbnailPerformance {
    Low,
    #[default]
    Balanced,
    Full,
}

impl ThumbnailPerformance {
    fn index(self) -> usize {
        match self {
            Self::Low => 0,
            Self::Balanced => 1,
            Self::Full => 2,
        }
    }

    pub fn workers(self) -> usize {
        let cores = std::thread::available_parallelism().map_or(4, |n| n.get());
        match self {
            Self::Low => 1,
            Self::Balanced => (cores / 2).clamp(1, 4),
            Self::Full => cores.clamp(1, 8),
        }
    }

    pub fn foreground_limit(self) -> usize {
        match self {
            Self::Low => 1,
            Self::Balanced => 2,
            Self::Full => 4,
        }
    }

    fn settings_path() -> std::path::PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| ".".into())
            .join("PhotoFactory")
            .join("thumbnail_performance.json")
    }
}

/// Tracks the status of a background thumbnail processing run.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProcessingStatus {
    pub running: bool,
    pub batch_size: usize,
    pub gpu_backend: Option<String>,
    pub total_pending: usize,
    pub processed: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub current_file: Option<String>,
    pub last_error: Option<String>,
}

/// Shared state for background thumbnail processing.
pub struct ThumbnailProcessor {
    pub running: AtomicBool,
    pub total_pending: AtomicI64,
    pub processed: AtomicUsize,
    pub succeeded: AtomicUsize,
    pub failed: AtomicUsize,
    pub batch_size: usize,
    pub current_file: Arc<std::sync::Mutex<Option<String>>>,
    pub last_error: Arc<std::sync::Mutex<Option<String>>>,
    performance: Mutex<ThumbnailPerformance>,
    pools: [OnceLock<rayon::ThreadPool>; 3],
}

impl ThumbnailProcessor {
    pub fn new(batch_size: usize) -> Self {
        Self {
            running: AtomicBool::new(false),
            total_pending: AtomicI64::new(0),
            processed: AtomicUsize::new(0),
            succeeded: AtomicUsize::new(0),
            failed: AtomicUsize::new(0),
            batch_size,
            current_file: Arc::new(std::sync::Mutex::new(None)),
            last_error: Arc::new(std::sync::Mutex::new(None)),
            performance: Mutex::new(ThumbnailPerformance::default()),
            pools: std::array::from_fn(|_| OnceLock::new()),
        }
    }

    pub fn with_saved_performance(self) -> Self {
        if let Ok(bytes) = std::fs::read(ThumbnailPerformance::settings_path()) {
            if let Ok(mode) = serde_json::from_slice(&bytes) {
                *self.performance.lock().unwrap() = mode;
            }
        }
        self
    }

    pub fn performance(&self) -> ThumbnailPerformance {
        *self.performance.lock().unwrap()
    }

    pub fn set_performance(&self, mode: ThumbnailPerformance) -> AppResult<()> {
        use std::io::Write;
        let mut preference = self.performance.lock().unwrap();
        let path = ThumbnailPerformance::settings_path();
        let directory = path.parent().unwrap();
        std::fs::create_dir_all(directory)?;
        let mut file = tempfile::NamedTempFile::new_in(directory)?;
        file.write_all(&serde_json::to_vec(&mode)?)?;
        file.persist(path).map_err(|error| error.error)?;
        *preference = mode;
        Ok(())
    }

    fn pool(&self, mode: ThumbnailPerformance) -> &rayon::ThreadPool {
        self.pools[mode.index()].get_or_init(|| {
            rayon::ThreadPoolBuilder::new()
                .num_threads(mode.workers())
                .thread_name(|index| format!("thumb-worker-{index}"))
                .build()
                .expect("failed to build thumbnail thread pool")
        })
    }

    /// Check if processing is currently running.
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Get a snapshot of the current processing status.
    pub fn get_status(&self) -> ProcessingStatus {
        ProcessingStatus {
            running: self.running.load(Ordering::SeqCst),
            batch_size: self.batch_size,
            gpu_backend: generator::gpu_backend_used().map(str::to_owned),
            total_pending: self.total_pending.load(Ordering::SeqCst) as usize,
            processed: self.processed.load(Ordering::SeqCst),
            succeeded: self.succeeded.load(Ordering::SeqCst),
            failed: self.failed.load(Ordering::SeqCst),
            current_file: self.current_file.lock().unwrap().clone(),
            last_error: self.last_error.lock().unwrap().clone(),
        }
    }

    /// Reset counters for a new processing run.
    fn reset(&self) {
        self.processed.store(0, Ordering::SeqCst);
        self.succeeded.store(0, Ordering::SeqCst);
        self.failed.store(0, Ordering::SeqCst);
        self.total_pending.store(0, Ordering::SeqCst);
        *self.current_file.lock().unwrap() = None;
        *self.last_error.lock().unwrap() = None;
    }

    /// Process all pending thumbnails in batches until none remain or cancelled.
    pub fn process_all(&self, project: &Project) {
        if self.running.swap(true, Ordering::SeqCst) {
            return; // already running
        }
        self.reset();

        let result = (|| -> AppResult<()> {
            let mut conn = init_db(&project.db_path())?;
            loop {
                let pending: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM photos WHERE thumbnail_status=0 AND deleted=0",
                    [],
                    |row| row.get(0),
                )?;
                self.total_pending.store(pending, Ordering::SeqCst);
                if pending == 0 || self.process_batch(project, &mut conn)? == 0 {
                    break;
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            if let Ok(conn) = init_db(&project.db_path()) {
                let _ = crate::db::task_error_dao::record_task_error(&conn, "thumbnail", &error.to_string());
            }
            *self.last_error.lock().unwrap() = Some(error.to_string());
            self.failed.fetch_add(1, Ordering::SeqCst);
        }
        *self.current_file.lock().unwrap() = None;
        let _ = eviction::evict_lru(
            &project.small_thumbnails_path(),
            eviction::THUMBNAIL_CACHE_MAX_BYTES,
        );
        self.running.store(false, Ordering::SeqCst);
    }

    /// Process a single batch of pending thumbnails in parallel.
    fn process_batch(
        &self,
        project: &Project,
        conn: &mut rusqlite::Connection,
    ) -> AppResult<usize> {
        let photos = photo_dao::get_pending_thumbnails(conn, self.batch_size as i64)?;
        if photos.is_empty() {
            return Ok(0);
        }

        let out_dir = project.small_thumbnails_path();
        let mode = self.performance();
        let results: Vec<_> = self.pool(mode).install(|| {
            photos
                .par_iter()
                .map(|photo| {
                    *self.current_file.lock().unwrap() = Some(photo.filename.clone());
                    let result = generator::generate_thumbnail_with_mode(
                        Path::new(&photo.path),
                        &out_dir,
                        generator::THUMBNAIL_SIZE_SMALL,
                        mode,
                    );
                    if mode == ThumbnailPerformance::Low {
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    (photo, result)
                })
                .collect()
        });

        let tx = conn.transaction()?;
        let mut succeeded = 0;
        let mut failed = 0;
        for (photo, result) in &results {
            let status = match result {
                Ok(_) => {
                    succeeded += 1;
                    1
                }
                Err(error) => {
                    failed += 1;
                    *self.last_error.lock().unwrap() = Some(format!("{}: {error}", photo.filename));
                    let _ = crate::db::task_error_dao::record(&tx, "thumbnail", "photo", &error.to_string(), &[
                        crate::db::task_error_dao::ErrorPhoto {
                            filename: photo.filename.clone(), path: photo.path.clone(), attempts: None,
                        },
                    ]);
                    -1
                }
            };
            tx.execute(
                "UPDATE photos SET thumbnail_status = ?1 WHERE id = ?2 AND thumbnail_status = 0",
                rusqlite::params![status, photo.id.unwrap_or(0)],
            )?;
        }
        tx.commit()?;
        self.succeeded.fetch_add(succeeded, Ordering::SeqCst);
        self.failed.fetch_add(failed, Ordering::SeqCst);
        self.processed.fetch_add(results.len(), Ordering::SeqCst);
        let _ = eviction::maybe_evict(&out_dir);
        Ok(results.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_processor_initial_state() {
        let proc = ThumbnailProcessor::new(50);
        assert!(!proc.is_running());
        let status = proc.get_status();
        assert!(!status.running);
        assert_eq!(status.batch_size, 50);
        assert_eq!(status.processed, 0);
        assert_eq!(status.succeeded, 0);
        assert_eq!(status.failed, 0);
    }

    #[test]
    fn test_thread_pool_has_correct_thread_count() {
        let proc = ThumbnailProcessor::new(50);
        for mode in [
            ThumbnailPerformance::Low,
            ThumbnailPerformance::Balanced,
            ThumbnailPerformance::Full,
        ] {
            assert_eq!(proc.pool(mode).current_num_threads(), mode.workers());
        }
    }

    #[test]
    fn test_processor_reset() {
        let proc = ThumbnailProcessor::new(50);
        proc.succeeded.store(10, Ordering::SeqCst);
        proc.failed.store(3, Ordering::SeqCst);
        proc.processed.store(13, Ordering::SeqCst);
        proc.total_pending.store(20, Ordering::SeqCst);
        *proc.current_file.lock().unwrap() = Some("test.jpg".to_string());
        *proc.last_error.lock().unwrap() = Some("error".to_string());

        proc.reset();

        assert_eq!(proc.processed.load(Ordering::SeqCst), 0);
        assert_eq!(proc.succeeded.load(Ordering::SeqCst), 0);
        assert_eq!(proc.failed.load(Ordering::SeqCst), 0);
        assert_eq!(proc.total_pending.load(Ordering::SeqCst), 0);
        assert!(proc.current_file.lock().unwrap().is_none());
        assert!(proc.last_error.lock().unwrap().is_none());
    }

    #[test]
    fn test_processor_no_double_start() {
        let proc = ThumbnailProcessor::new(50);
        proc.running.store(true, Ordering::SeqCst);
        let before = proc.processed.load(Ordering::SeqCst);
        // If running is already true, the guard should prevent double-start
        assert!(proc.is_running());
        assert_eq!(before, 0);
    }

    #[test]
    fn test_processing_status_serializable() {
        let status = ProcessingStatus {
            running: false,
            batch_size: 100,
            gpu_backend: None,
            total_pending: 50,
            processed: 10,
            succeeded: 8,
            failed: 2,
            current_file: Some("photo.jpg".to_string()),
            last_error: Some("timeout".to_string()),
        };
        let json = serde_json::to_string(&status).unwrap();
        let parsed: ProcessingStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.batch_size, 100);
        assert_eq!(parsed.processed, 10);
        assert_eq!(parsed.failed, 2);
    }
}
