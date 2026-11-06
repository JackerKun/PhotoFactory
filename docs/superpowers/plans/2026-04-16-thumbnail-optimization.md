# 缩略图存储结构优化与 CPU 节流实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将缩略图从单一扁平目录改为 hash 分片结构 + 限制后台批量生成时的 CPU 占用不超过 80%

**Architecture:** generator.rs 的 `thumbnail_path_for` 改为 hash 前 2 字符作为子目录；eviction.rs 递归扫描所有子目录；processor.rs 使用固定 4 线程的 rayon 线程池 + 每张照片 sleep 20ms + 批次间 sleep 500ms；photos.rs 和 tags.rs 查找时兼容旧扁平路径

**Tech Stack:** Rust (rusqlite, rayon, image crate), Tauri v2, SHA256 hash

---

### Task 1: Hash 分片路径计算 — generator.rs

**Files:**
- Modify: `src-tauri/src/thumbnail/generator.rs`
- Test: `src-tauri/src/thumbnail/generator.rs` (inline tests)

`thumbnail_path_for` 从返回 `out_dir/hash.webp` 改为返回 `out_dir/ab/hash.webp`（ab 为 hash 前 2 字符）。`generate_thumbnail` 在写入前需创建子目录。

- [ ] **Step 1: Write failing test for sharded path**

```rust
#[test]
fn test_thumbnail_path_for_sharded() {
    let out_dir = Path::new("/tmp/pf/thumbnails/small");
    let path = thumbnail_path_for("/Users/test/photo.jpg", out_dir);
    // hash is first 16 chars of SHA256, first 2 chars become subdir
    let hash = path_hash("/Users/test/photo.jpg");
    let expected = out_dir.join(&hash[..2]).join(&hash);
    assert_eq!(path, expected.with_extension("webp"));
    // Verify it has 2 path components after the base dir
    let relative = path.strip_prefix(out_dir).unwrap();
    assert_eq!(relative.components().count(), 2);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test test_thumbnail_path_for_sharded --no-fail-fast`
Expected: FAIL — current `thumbnail_path_for` returns flat path

- [ ] **Step 3: Implement sharded path in `thumbnail_path_for`**

Replace the current function:

```rust
pub fn thumbnail_path_for(photo_path: &str, output_dir: &Path) -> PathBuf {
    let hash = path_hash(photo_path);
    // Sharded directory: use first 2 chars of hash as subdirectory
    output_dir.join(&hash[..2]).join(format!("{}.webp", hash))
}
```

- [ ] **Step 4: Create subdirectory in `generate_thumbnail`**

In `generate_thumbnail`, before saving, ensure the subdirectory exists:

```rust
pub fn generate_thumbnail(
    source_path: &Path,
    output_dir: &Path,
    size: u32,
) -> AppResult<PathBuf> {
    let hash = path_hash(&source_path.to_string_lossy());
    let shard_dir = output_dir.join(&hash[..2]);
    std::fs::create_dir_all(&shard_dir)?;

    // ... existing code: open image, resize ...
    let thumb = img.thumbnail(size, size);
    let out_path = shard_dir.join(format!("{}.webp", hash));
    thumb.save_with_format(&out_path, image::ImageFormat::WebP)
        .map_err(|e| AppError::Image(e))?;
    Ok(out_path)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd src-tauri && cargo test thumbnail::generator --no-fail-fast`
Expected: PASS — all tests including new one

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/thumbnail/generator.rs
git commit -m "feat: hash-sharded thumbnail directory structure"
```

---

### Task 2: 递归扫描 LRU 驱逐 — eviction.rs

**Files:**
- Modify: `src-tauri/src/thumbnail/eviction.rs`
- Test: `src-tauri/src/thumbnail/eviction.rs` (inline tests)

当前 `collect_entries` 只扫描单一级别的 `read_dir`。需改为递归遍历所有子目录（`walkdir` 已作为依赖）。

- [ ] **Step 1: Write failing test for recursive scanning**

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test test_calculate_cache_size_with_shards --no-fail-fast`
Expected: FAIL — `collect_entries` only reads top-level directory

- [ ] **Step 3: Replace `collect_entries` with recursive walkdir**

Add `use walkdir::WalkDir;` at the top, then replace `collect_entries`:

```rust
/// Recursively collect metadata for every .webp file in the directory tree.
fn collect_entries(dir: &Path) -> AppResult<Vec<(std::path::PathBuf, u64, SystemTime)>> {
    let mut entries = Vec::new();
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test thumbnail::eviction --no-fail-fast`
Expected: PASS — all eviction tests including new one

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/thumbnail/eviction.rs
git commit -m "feat: recursive LRU eviction for sharded thumbnail directories"
```

---

### Task 3: 兼容旧缩略图路径 — photos.rs

**Files:**
- Modify: `src-tauri/src/commands/photos.rs:66-121`

当前 `cmd_get_thumbnail_path` 只检查新路径 `thumbnail_path_for`。需改为：
1. 先检查新分片路径
2. 再检查旧扁平路径（兼容存量缩略图）

- [ ] **Step 1: Write failing test for legacy path fallback**

Add a test in `generator.rs` for a new helper function `find_thumbnail_path`:

```rust
#[test]
fn test_find_thumbnail_path_finds_new_sharded() {
    let dir = std::env::temp_dir().join("pf_find_thumb");
    let _ = fs::remove_dir_all(&dir);
    let src = dir.join("photo.jpg");
    // Create the photo first (needed for thumbnail generation)
    fs::create_dir_all(&dir).unwrap();
    let img = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(500, 500, image::Rgb([255, 0, 0])));
    img.save_with_format(&src, image::ImageFormat::Png).unwrap();

    let thumb = generate_small_thumbnail(&src, &dir).unwrap();
    let found = find_thumbnail_path(&src.to_string_lossy(), &dir).unwrap();
    assert_eq!(found, thumb);
    assert_eq!(found.extension().unwrap(), "webp");

    let _ = fs::remove_dir_all(&dir);
}
```

- [ ] **Step 2: Add `find_thumbnail_path` helper in generator.rs**

```rust
/// Find a thumbnail for a photo, checking sharded path first, then legacy flat path.
pub fn find_thumbnail_path(photo_path: &str, output_dir: &Path) -> Option<PathBuf> {
    let hash = path_hash(photo_path);
    // New sharded path
    let sharded = output_dir.join(&hash[..2]).join(format!("{}.webp", hash));
    if sharded.exists() {
        return Some(sharded);
    }
    // Legacy flat path
    let flat = output_dir.join(format!("{}.webp", hash));
    if flat.exists() {
        return Some(flat);
    }
    None
}
```

- [ ] **Step 3: Update `cmd_get_thumbnail_path` to use `find_thumbnail_path`**

Replace the existing lookup logic (lines 81-86):

```rust
// Replace lines 81-86:
let thumb_path = match generator::find_thumbnail_path(&photo.path, &out_dir) {
    Some(path) => path,
    None => {
        // No existing thumbnail — will generate on demand below
        return handle_on_demand_generation(...);
    }
};
```

The full updated function:

```rust
#[tauri::command]
pub async fn cmd_get_thumbnail_path(photo_id: i64, size: String, state: State<'_, AppState>) -> AppResult<String> {
    let project = {
        let guard = state.project.lock().unwrap();
        guard.as_ref().ok_or_else(|| AppError::Project("No project open".into()))?.clone()
    };
    let conn = get_conn(state)?;
    let photo = photo_dao::get_photo_by_id(&conn, photo_id)?
        .ok_or_else(|| AppError::NotFound(format!("Photo {} not found", photo_id)))?;

    let out_dir = match size.as_str() {
        "large" => project.large_thumbnails_path(),
        "medium" => project.medium_thumbnails_path(),
        _ => project.small_thumbnails_path(),
    };

    // Check both sharded and legacy flat paths
    if let Some(thumb_path) = generator::find_thumbnail_path(&photo.path, &out_dir) {
        let _ = eviction::touch_thumbnail(&thumb_path);
        return Ok(thumb_path.to_string_lossy().to_string());
    }

    if photo.file_size <= project.thumbnail_threshold_mb * 1024 * 1024 {
        return Ok(photo.path.clone());
    }

    // Throttle and generate on demand (unchanged)
    let active = ACTIVE_THUMBNAIL_TASKS.fetch_add(1, Ordering::SeqCst);
    if active >= MAX_CONCURRENT_THUMBNAILS {
        ACTIVE_THUMBNAIL_TASKS.fetch_sub(1, Ordering::SeqCst);
        return Ok(photo.path.clone());
    }

    let source = Path::new(&photo.path).to_path_buf();
    let out_dir_clone = out_dir.clone();
    let out_dir_for_eviction = out_dir.clone();
    let size_clone = size.clone();
    let result = tokio::task::spawn_blocking(move || {
        if size_clone == "large" {
            generator::generate_large_thumbnail(&source, &out_dir_clone)
        } else if size_clone == "medium" {
            generator::generate_medium_thumbnail(&source, &out_dir_clone)
        } else {
            generator::generate_small_thumbnail(&source, &out_dir_clone)
        }
    }).await.map_err(|e| AppError::AiWorker(format!("spawn_blocking failed: {}", e)))??;
    ACTIVE_THUMBNAIL_TASKS.fetch_sub(1, Ordering::SeqCst);
    let _ = result;
    photo_dao::update_thumbnail_status(&conn, photo_id, 1)?;
    let _ = eviction::maybe_evict(&out_dir_for_eviction);

    // After generation, compute the new sharded path
    Ok(generator::thumbnail_path_for(&photo.path, &out_dir).to_string_lossy().to_string())
}
```

- [ ] **Step 4: Run cargo check to verify compilation**

Run: `cd src-tauri && cargo check`
Expected: success, no errors

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/thumbnail/generator.rs src-tauri/src/commands/photos.rs
git commit -m "feat: legacy thumbnail path compatibility for sharded directories"
```

---

### Task 4: 兼容旧缩略图路径 — tags.rs

**Files:**
- Modify: `src-tauri/src/commands/tags.rs:26-49`

`cmd_get_label_preview` 同样需要兼容旧路径。

- [ ] **Step 1: Update `cmd_get_label_preview` to use `find_thumbnail_path`**

Replace lines 39-48:

```rust
let out_dir = project.small_thumbnails_path();

// Check both sharded and legacy flat paths
if let Some(thumb_path) = generator::find_thumbnail_path(&photo.path, &out_dir) {
    return Ok(thumb_path.to_string_lossy().to_string());
}

// Generate on demand (writes to new sharded path)
generator::generate_small_thumbnail(Path::new(&photo.path), &out_dir)?;
Ok(generator::thumbnail_path_for(&photo.path, &out_dir).to_string_lossy().to_string())
```

- [ ] **Step 2: Run cargo check**

Run: `cd src-tauri && cargo check`
Expected: success

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/tags.rs
git commit -m "feat: legacy thumbnail path compatibility in label preview"
```

---

### Task 5: CPU 节流 — 固定 4 线程 + sleep

**Files:**
- Modify: `src-tauri/src/thumbnail/processor.rs`

当前使用 `par_iter()` 默认线程池（等于 CPU 核心数）。改为：
1. 在 `ThumbnailProcessor` 上创建固定 4 线程的 rayon 线程池
2. 每张照片生成后 sleep 20ms
3. 每批次完成后 sleep 500ms

- [ ] **Step 1: Write test for thread pool configuration**

```rust
#[test]
fn test_thread_pool_has_correct_thread_count() {
    let proc = ThumbnailProcessor::new(50);
    // The thread pool is created in new(), verify it has 4 threads
    // by checking that process_batch uses the configured pool
    assert_eq!(proc.pool.current_num_threads(), 4);
}
```

- [ ] **Step 2: Add `pool` field to `ThumbnailProcessor`**

Add `use rayon::ThreadPool;` and modify the struct:

```rust
pub struct ThumbnailProcessor {
    pub running: AtomicBool,
    pub total_pending: AtomicI64,
    pub processed: AtomicUsize,
    pub succeeded: AtomicUsize,
    pub failed: AtomicUsize,
    pub batch_size: usize,
    pub current_file: Arc<std::sync::Mutex<Option<String>>>,
    pub last_error: Arc<std::sync::Mutex<Option<String>>>,
    pub pool: Arc<rayon::ThreadPool>,
}
```

- [ ] **Step 3: Create thread pool in `new()`**

Replace the `new` method:

```rust
pub fn new(batch_size: usize) -> Self {
    let pool = Arc::new(
        rayon::ThreadPoolBuilder::new()
            .num_threads(4)
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
```

- [ ] **Step 4: Use the pool in `process_batch`**

Replace the `par_iter` call in `process_batch`:

```rust
let results: Vec<(i64, String, bool, Option<String>)> = self.pool.install(|| {
    items.par_iter().map(|(photo_id, path, filename)| {
        let source = Path::new(path);
        let out_dir = project.small_thumbnails_path();

        {
            let mut cur = self.current_file.lock().unwrap();
            *cur = Some(filename.clone());
        }

        let success = generator::generate_small_thumbnail(source, &out_dir).is_ok();

        // Yield CPU time after each photo to keep overall usage below 80%
        std::thread::sleep(std::time::Duration::from_millis(20));

        let error = if success { None } else { Some(filename.clone()) };
        (*photo_id, filename.clone(), success, error)
    }).collect()
});
```

- [ ] **Step 5: Add batch-level cooling sleep**

At the end of `process_batch`, before the final `Ok(results.len())`:

```rust
// Trigger LRU eviction
let small_dir = project.small_thumbnails_path();
let _ = eviction::maybe_evict(&small_dir);

// Cool down between batches to prevent sustained CPU load
std::thread::sleep(std::time::Duration::from_millis(500));

Ok(results.len())
```

- [ ] **Step 6: Run all processor tests**

Run: `cd src-tauri && cargo test thumbnail::processor --no-fail-fast`
Expected: PASS — all existing tests still pass (the `test_thread_pool_has_correct_thread_count` test will pass because the pool has 4 threads)

Note: If the `test_thread_pool_has_correct_thread_count` test name conflicts or the `pool` accessor needs to be public, adjust accordingly. The key assertion is `proc.pool.current_num_threads() == 4`.

- [ ] **Step 7: Run full test suite**

Run: `cd src-tauri && cargo test --no-fail-fast 2>&1 | tail -5`
Expected: all 136+ tests pass

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/thumbnail/processor.rs
git commit -m "feat: throttle CPU with fixed 4-thread pool and sleep intervals"
```

---

### Task 6: 回归测试 + 手动验证

- [ ] **Step 1: Full test suite**

Run: `cd src-tauri && cargo test 2>&1 | tail -10`
Expected: all tests pass, no failures

- [ ] **Step 2: TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Manual verification checklist**

1. Build and launch the app: `cargo tauri dev`
2. Import a new folder with photos
3. Check `.pf/thumbnails/small/` — verify `ab/`, `cd/` etc subdirectories exist
4. Open Activity Monitor, verify CPU stays below 80% during batch processing
5. Navigate to Photos grid — verify thumbnails load correctly (both new sharded and any legacy flat ones)
6. Navigate to Tags — verify label preview thumbnails load correctly
