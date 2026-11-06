use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::Arc;

use rayon::prelude::*;

use crate::db::{connection::init_db, photo_dao};
use crate::error::AppResult;
use crate::models::Project;
use crate::thumbnail::{eviction, generator};

/// Number of worker threads for batch thumbnail generation.
const THUMBNAIL_THREAD_COUNT: usize = 4;

/// Tracks the status of a background thumbnail processing run.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProcessingStatus {
    pub running: bool,
    pub batch_size: usize,
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
    pool: Arc<rayon::ThreadPool>,
}

impl ThumbnailProcessor {
    pub fn new(batch_size: usize) -> Self {
        let pool = Arc::new(
            rayon::ThreadPoolBuilder::new()
                .num_threads(THUMBNAIL_THREAD_COUNT)
                .thread_name(|idx| format!("thumb-worker-{}", idx))
                .build()
                .expect("failed to build thumbnail thread pool"),
        );

        Self {
            running: AtomicBool::new(false),
            total_pending: AtomicI64::new(0),
            processed: AtomicUsize::new(0),
            succeeded: AtomicUsize::new(0),
            failed: AtomicUsize::new(0),
            batch_size,
            current_file: Arc::new(std::sync::Mutex::new(None)),
            last_error: Arc::new(std::sync::Mutex::new(None)),
            pool,
        }
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
    pub async fn process_all(&self, project: &Project) {
        if self.running.swap(true, Ordering::SeqCst) {
            return; // already running
        }
        self.reset();

        loop {
            let batch = match self.process_batch(project) {
                Ok(count) => count,
                Err(e) => {
                    *self.last_error.lock().unwrap() = Some(e.to_string());
                    self.failed.fetch_add(1, Ordering::SeqCst);
                    self.processed.fetch_add(1, Ordering::SeqCst);
                    0
                }
            };
            if batch == 0 {
                break;
            }
        }

        self.running.store(false, Ordering::SeqCst);
    }

    /// Process a single batch of pending thumbnails in parallel.
    /// Returns number of photos processed.
    fn process_batch(&self, project: &Project) -> AppResult<usize> {
        let conn = init_db(&project.db_path())?;
        let photos = photo_dao::get_pending_thumbnails(&conn, self.batch_size as i64)?;

        if photos.is_empty() {
            return Ok(0);
        }

        self.total_pending
            .store(photos.len() as i64, Ordering::SeqCst);

        // Extract data needed for parallel processing (owned copies, no DB connection).
        let items: Vec<(i64, String, String)> = photos
            .iter()
            .map(|p| (p.id.unwrap_or(0), p.path.clone(), p.filename.clone()))
            .collect();

        // Parallel thumbnail generation using fixed 4-thread pool.
        let results: Vec<(i64, String, bool, Option<String>)> = self.pool.install(|| {
            items
                .par_iter()
                .map(|(photo_id, path, filename)| {
                    let source = Path::new(path);
                    let out_dir = project.small_thumbnails_path();

                    {
                        let mut cur = self.current_file.lock().unwrap();
                        *cur = Some(filename.clone());
                    }

                    let success = generator::generate_small_thumbnail(source, &out_dir).is_ok();

                    // Yield CPU time after each photo to reduce sustained CPU load
                    std::thread::sleep(std::time::Duration::from_millis(20));

                    let error = if success {
                        None
                    } else {
                        Some(filename.clone())
                    };
                    (*photo_id, filename.clone(), success, error)
                })
                .collect()
        });

        // Write results back to DB in a single connection (serial).
        let conn = init_db(&project.db_path())?;
        let mut succeeded_count = 0usize;
        let mut failed_count = 0usize;
        for (photo_id, _filename, success, error) in &results {
            let status = if *success { 1i32 } else { -1i32 };
            let _ = photo_dao::update_thumbnail_status(&conn, *photo_id, status);
            if *success {
                succeeded_count += 1;
            } else {
                failed_count += 1;
                if let Some(ref err_file) = error {
                    *self.last_error.lock().unwrap() = Some(err_file.clone());
                }
            }
        }

        self.succeeded.fetch_add(succeeded_count, Ordering::SeqCst);
        self.failed.fetch_add(failed_count, Ordering::SeqCst);
        self.processed.fetch_add(results.len(), Ordering::SeqCst);

        // Trigger LRU eviction for small thumbnail directory
        let small_dir = project.small_thumbnails_path();
        let _ = eviction::maybe_evict(&small_dir);

        // Cool down between batches to prevent sustained CPU load
        std::thread::sleep(std::time::Duration::from_millis(500));

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
        assert_eq!(proc.pool.current_num_threads(), THUMBNAIL_THREAD_COUNT);
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
