# PhotoFactory Implementation Plan

**Date:** 2026-04-09
**Status:** Ready for Implementation
**Based on:** [2026-04-09-photofactory-design.md](../specs/2026-04-09-photofactory-design.md)

---

## Overview

This plan breaks the PhotoFactory implementation into **bite-sized, test-driven tasks** (2-5 minutes each), with complete code at every step, exact file paths, and git commits after each task.

### Project Structure (final)

```
PhotoFactory/
├── src-tauri/
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json
│   ├── capabilities/
│   │   └── default.json
│   ├── models/                  # Rust model definitions
│   │   ├── mod.rs
│   │   ├── photo.rs
│   │   ├── project.rs
│   │   └── ai.rs
│   ├── db/
│   │   ├── mod.rs
│   │   ├── schema.rs
│   │   ├── connection.rs
│   │   ├── photo_dao.rs
│   │   ├── classification_dao.rs
│   │   ├── face_dao.rs
│   │   └── custom_attr_dao.rs
│   ├── scanner/
│   │   ├── mod.rs
│   │   ├── file_scanner.rs
│   │   └── exif_reader.rs
│   ├── thumbnail/
│   │   ├── mod.rs
│   │   └── generator.rs
│   ├── ai_worker/
│   │   ├── mod.rs
│   │   ├── client.rs
│   │   └── models.rs
│   ├── commands/
│   │   ├── mod.rs
│   │   ├── project.rs
│   │   ├── photos.rs
│   │   ├── faces.rs
│   │   ├── tags.rs
│   │   └── map.rs
│   └── src/
│       ├── main.rs
│       └── lib.rs
├── ai_worker/
│   ├── requirements.txt
│   ├── server.py
│   ├── face_detector.py
│   ├── scene_classifier.py
│   ├── face_clusterer.py
│   └── models/
│       └── (ONNX files, downloaded at runtime)
├── src/                      # React frontend
│   ├── main.tsx
│   ├── App.tsx
│   ├── index.css
│   ├── api/
│   │   └── tauri.ts
│   ├── components/
│   │   ├── Sidebar.tsx
│   │   ├── PhotoGrid.tsx
│   │   ├── PhotoCard.tsx
│   │   ├── DirectoryTree.tsx
│   │   ├── PhotoDetail.tsx
│   │   ├── MapView.tsx
│   │   ├── FaceView.tsx
│   │   ├── TagView.tsx
│   │   ├── ImportModal.tsx
│   │   └── ThumbnailImage.tsx
│   ├── hooks/
│   │   ├── usePhotos.ts
│   │   └── useVirtualGrid.ts
│   ├── types/
│   │   └── index.ts
│   └── utils/
│       └── format.ts
├── index.html
├── package.json
├── vite.config.ts
├── tailwind.config.js
├── postcss.config.js
└── tsconfig.json
```

### Supported Image Extensions

`.jpg`, `.jpeg`, `.png`, `.webp`, `.tiff`, `.tif`, `.bmp`, `.gif`, `.heic`, `.heif`, `.avif`, `.raw`, `.cr2`, `.nef`, `.arw`, `.dng`

### Conventions

- Rust: 4-space indentation, `Result<T, AppError>` returns, `thiserror` for error types
- Python: 4-space indentation, type hints, `pydantic` for request/response validation
- React: functional components, TypeScript, Tailwind CSS, `React.memo` for list items
- All SQL uses parameterized queries, never string interpolation
- Every task ends with a git commit

---

## Phase 1: Rust Core

### Task 1.1: Initialize Cargo Project and Dependencies

**Create:** `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`

```toml
# src-tauri/Cargo.toml
[package]
name = "photofactory"
version = "0.1.0"
edition = "2021"

[dependencies]
tauri = { version = "2", features = ["shell-open"] }
tauri-plugin-shell = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rusqlite = { version = "0.32", features = ["bundled"] }
kamadak-exif = "0.6"
image = "0.25"
walkdir = "2"
thiserror = "2"
chrono = { version = "0.4", features = ["serde"] }
uuid = { version = "1", features = ["v4"] }
reqwest = { version = "0.12", features = ["json", "stream"] }
tokio = { version = "1", features = ["full"] }
sha2 = "0.10"
hex = "0.4"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[[bin]]
name = "photofactory"
path = "src/main.rs"
```

```rust
// src-tauri/build.rs
fn main() {
    tauri_build::build()
}
```

```json
// src-tauri/tauri.conf.json
{
  "productName": "PhotoFactory",
  "version": "0.1.0",
  "identifier": "com.photofactory.app",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:1420",
    "frontendDist": "../dist"
  },
  "app": {
    "withGlobalTauri": true,
    "security": {
      "csp": "default-src 'self'; img-src 'self' asset: https://asset.localhost file: data:; connect-src 'self' http://localhost:*"
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"]
  }
}
```

```json
// src-tauri/capabilities/default.json
{
  "identifier": "default",
  "description": "Default capability",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "shell:allow-open"
  ]
}
```

**Test:** `cd src-tauri && cargo check`
**Commit:** `cd src-tauri && git add Cargo.toml build.rs tauri.conf.json capabilities/default.json && git commit -m "Phase 1.1: Initialize Cargo project with Tauri 2, rusqlite, image, exif, reqwest dependencies"`

### Task 1.2: Define Error Type

**Create:** `src-tauri/src/error.rs`

```rust
// src-tauri/src/error.rs
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Image error: {0}")]
    Image(#[from] image::ImageError),

    #[error("EXIF error: {0}")]
    Exif(String),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("Project error: {0}")]
    Project(String),

    #[error("AI Worker error: {0}")]
    AiWorker(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Invalid path: {0}")]
    InvalidPath(String),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

pub type AppResult<T> = Result<T, AppError>;
```

**Test:** `cd src-tauri && cargo check`
**Commit:** `git add src/error.rs && git commit -m "Phase 1.2: Define AppError type with thiserror and serialization"`

### Task 1.3: Define Photo Model

**Create:** `src-tauri/src/models/mod.rs`, `src-tauri/src/models/photo.rs`

```rust
// src-tauri/src/models/mod.rs
pub mod photo;
pub mod project;
pub mod ai;

pub use photo::*;
pub use project::*;
pub use ai::*;
```

```rust
// src-tauri/src/models/photo.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Photo {
    pub id: Option<i64>,
    pub path: String,
    pub filename: String,
    pub file_size: i64,
    pub file_mtime: i64,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub format: Option<String>,
    pub taken_at: Option<i64>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub orientation: i32,
    pub thumbnail_status: i32,
    pub ai_status: i32,
    pub deleted: bool,
    pub imported_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhotoCursor {
    pub id: i64,
    pub taken_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhotoPage {
    pub photos: Vec<Photo>,
    pub next_cursor: Option<PhotoCursor>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PhotoFilter {
    pub directory: Option<String>,
    pub tag: Option<String>,
    pub person_id: Option<i64>,
    pub has_gps: Option<bool>,
    pub year: Option<i32>,
    pub month: Option<u32>,
}

pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "tiff", "tif", "bmp",
    "gif", "heic", "heif", "avif", "raw", "cr2", "nef",
    "arw", "dng",
];
```

**Test:** `cd src-tauri && cargo check`
**Commit:** `git add src/models/mod.rs src/models/photo.rs && git commit -m "Phase 1.3: Define Photo model with cursor pagination and filter structs"`

### Task 1.4: Define Project and AI Models

**Create:** `src-tauri/src/models/project.rs`

```rust
// src-tauri/src/models/project.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub name: String,
    pub root_path: String,
    pub created_at: String,
    pub last_scan: Option<String>,
    pub total_photos: i64,
    pub thumbnail_threshold_mb: i64,
    pub ai_models: AiModelConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiModelConfig {
    pub face_detection: String,
    pub face_recognition: String,
    pub scene_classification: String,
}

impl Default for AiModelConfig {
    fn default() -> Self {
        Self {
            face_detection: "retinaface_v1".into(),
            face_recognition: "arcface_v1".into(),
            scene_classification: "resnet50_places365".into(),
        }
    }
}

impl Project {
    pub fn new(name: String, root_path: String) -> Self {
        Self {
            name,
            root_path,
            created_at: chrono::Utc::now().to_rfc3339(),
            last_scan: None,
            total_photos: 0,
            thumbnail_threshold_mb: 10,
            ai_models: AiModelConfig::default(),
        }
    }

    pub fn pf_path(&self) -> std::path::PathBuf {
        std::path::PathBuf::from(&self.root_path).join(".pf")
    }
    pub fn db_path(&self) -> std::path::PathBuf { self.pf_path().join("photos.db") }
    pub fn small_thumbnails_path(&self) -> std::path::PathBuf { self.pf_path().join("thumbnails/small") }
    pub fn large_thumbnails_path(&self) -> std::path::PathBuf { self.pf_path().join("thumbnails/large") }
    pub fn tiles_path(&self) -> std::path::PathBuf { self.pf_path().join("maps/tiles") }
    pub fn faces_cache_path(&self) -> std::path::PathBuf { self.pf_path().join("ai_cache/faces") }
    pub fn tags_cache_path(&self) -> std::path::PathBuf { self.pf_path().join("ai_cache/tags") }
    pub fn project_json_path(&self) -> std::path::PathBuf { self.pf_path().join("project.json") }
}
```

**Create:** `src-tauri/src/models/ai.rs`

```rust
// src-tauri/src/models/ai.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiClassification {
    pub id: Option<i64>,
    pub photo_id: i64,
    pub category: String,
    pub label: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaceDetection {
    pub id: Option<i64>,
    pub photo_id: i64,
    pub bbox_x: i32,
    pub bbox_y: i32,
    pub bbox_w: i32,
    pub bbox_h: i32,
    pub embedding_path: Option<String>,
    pub person_id: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaceCluster {
    pub id: Option<i64>,
    pub name: Option<String>,
    pub face_count: i32,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomAttribute {
    pub id: Option<i64>,
    pub photo_id: i64,
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassifyRequest { pub paths: Vec<String>, pub model: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiTag { pub label: String, pub confidence: f64 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassifyResult { pub path: String, pub tags: Vec<AiTag> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassifyResponse { pub results: Vec<ClassifyResult> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectFacesRequest { pub paths: Vec<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedFace { pub bbox: [i32; 4], pub embedding: Vec<f32> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaceResult { pub path: String, pub faces: Vec<DetectedFace> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectFacesResponse { pub results: Vec<FaceResult> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse { pub status: String }
```

**Test:** `cd src-tauri && cargo check`
**Commit:** `git add src/models/project.rs src/models/ai.rs && git commit -m "Phase 1.4: Define Project, AI, and Worker communication models"`

### Task 1.5: Database Schema

**Create:** `src-tauri/src/db/mod.rs`, `src-tauri/src/db/schema.rs`

```rust
// src-tauri/src/db/mod.rs
pub mod schema;
pub mod connection;
pub mod photo_dao;
pub mod classification_dao;
pub mod face_dao;
pub mod custom_attr_dao;
```

```rust
// src-tauri/src/db/schema.rs
pub const CREATE_TABLES: &str = r#"
CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    filename TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    file_mtime INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    format TEXT,
    taken_at INTEGER,
    camera_make TEXT,
    camera_model TEXT,
    latitude REAL,
    longitude REAL,
    orientation INTEGER DEFAULT 1,
    thumbnail_status INTEGER DEFAULT 0,
    ai_status INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0,
    imported_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_classifications (
    id INTEGER PRIMARY KEY,
    photo_id INTEGER NOT NULL REFERENCES photos(id),
    category TEXT NOT NULL,
    label TEXT NOT NULL,
    confidence REAL NOT NULL,
    UNIQUE(photo_id, label)
);

CREATE TABLE IF NOT EXISTS face_detections (
    id INTEGER PRIMARY KEY,
    photo_id INTEGER NOT NULL REFERENCES photos(id),
    bbox_x INTEGER,
    bbox_y INTEGER,
    bbox_w INTEGER,
    bbox_h INTEGER,
    embedding_path TEXT,
    person_id INTEGER REFERENCES face_clusters(id),
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS face_clusters (
    id INTEGER PRIMARY KEY,
    name TEXT,
    face_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_attributes (
    id INTEGER PRIMARY KEY,
    photo_id INTEGER NOT NULL REFERENCES photos(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    UNIQUE(photo_id, key)
);

CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY,
    event_type TEXT NOT NULL,
    path TEXT NOT NULL,
    timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photos_path ON photos(path);
CREATE INDEX IF NOT EXISTS idx_photos_taken_at ON photos(taken_at);
CREATE INDEX IF NOT EXISTS idx_photos_gps ON photos(latitude, longitude) WHERE latitude IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_classifications_photo ON ai_classifications(photo_id);
CREATE INDEX IF NOT EXISTS idx_ai_classifications_label ON ai_classifications(label);
CREATE INDEX IF NOT EXISTS idx_face_detections_photo ON face_detections(photo_id);
CREATE INDEX IF NOT EXISTS idx_face_detections_person ON face_detections(person_id);
CREATE INDEX IF NOT EXISTS idx_custom_attrs_photo ON custom_attributes(photo_id);
"#;
```

**Test:** `cd src-tauri && cargo check`
**Commit:** `git add src/db/mod.rs src/db/schema.rs && git commit -m "Phase 1.5: Define SQLite database schema with all tables and indexes"`

### Task 1.6: Database Connection

**Create:** `src-tauri/src/db/connection.rs`

```rust
// src-tauri/src/db/connection.rs
use rusqlite::{Connection, Result};
use std::path::Path;

use crate::db::schema::CREATE_TABLES;
use crate::error::AppResult;

pub fn init_db(db_path: &Path) -> AppResult<Connection> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.pragma_update(None, "synchronous", "NORMAL").unwrap();
    conn.pragma_update(None, "cache_size", "-50000").unwrap();
    conn.pragma_update(None, "temp_store", "MEMORY").unwrap();
    conn.execute_batch(CREATE_TABLES)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_init_db_creates_tables() {
        let dir = std::env::temp_dir().join("pf_test_db");
        let _ = fs::remove_dir_all(&dir);
        let db_path = dir.join("test.db");
        let conn = init_db(&db_path).unwrap();
        // Verify tables exist
        let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").unwrap();
        let names: Vec<String> = stmt.query_map([], |row| row.get(0)).unwrap()
            .map(|r| r.unwrap()).collect();
        assert!(names.contains(&"photos".to_string()));
        assert!(names.contains(&"ai_classifications".to_string()));
        assert!(names.contains(&"face_detections".to_string()));
        assert!(names.contains(&"face_clusters".to_string()));
        assert!(names.contains(&"custom_attributes".to_string()));
        assert!(names.contains(&"sync_log".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }
}
```

**Test:** `cd src-tauri && cargo test db::connection::tests -- --nocapture`
**Commit:** `git add src/db/connection.rs && git commit -m "Phase 1.6: Implement database connection with WAL mode and initialization tests"`

### Task 1.7: File Scanner

**Create:** `src-tauri/src/scanner/mod.rs`, `src-tauri/src/scanner/file_scanner.rs`

```rust
// src-tauri/src/scanner/mod.rs
pub mod file_scanner;
pub mod exif_reader;
```

```rust
// src-tauri/src/scanner/file_scanner.rs
use std::path::{Path, PathBuf};
use std::fs;
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

fn is_hidden(entry: &walkdir::DirEntry) -> bool {
    entry.file_name()
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
}
```

**Test:** `cd src-tauri && cargo test scanner::file_scanner::tests -- --nocapture`
**Commit:** `git add src/scanner/mod.rs src/scanner/file_scanner.rs && git commit -m "Phase 1.7: Implement recursive file scanner with hidden dir skip and extension filtering"`

### Task 1.8: EXIF Reader

**Create:** `src-tauri/src/scanner/exif_reader.rs`

```rust
// src-tauri/src/scanner/exif_reader.rs
use std::fs::File;
use std::path::Path;

use crate::error::{AppError, AppResult};

#[derive(Debug, Default, Clone)]
pub struct ExifData {
    pub taken_at: Option<i64>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub orientation: i32,
}

pub fn read_exif(path: &Path) -> AppResult<ExifData> {
    let file = File::open(path).map_err(|e| AppError::Io(e))?;
    let mut bufreader = std::io::BufReader::new(&file);
    let exif_reader = exif::Reader::new();
    let exif = match exif_reader.read_from_container(&mut bufreader) {
        Ok(e) => e,
        Err(_) => return Ok(ExifData::default()),
    };

    let mut data = ExifData {
        orientation: 1,
        ..Default::default()
    };

    // Image dimensions
    if let Some(field) = exif.get_field(exif::Tag::PixelXDimension, exif::In::PRIMARY) {
        data.width = field.value.get_uint(0).map(|v| v as i32);
    }
    if let Some(field) = exif.get_field(exif::Tag::PixelYDimension, exif::In::PRIMARY) {
        data.height = field.value.get_uint(0).map(|v| v as i32);
    }

    // DateTimeOriginal
    if let Some(field) = exif.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY) {
        let date_str = field.display_value().to_string();
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(&date_str, "%Y-%m-%d %H:%M:%S") {
            data.taken_at = Some(dt.and_utc().timestamp());
        }
    }

    // Camera Make/Model
    if let Some(field) = exif.get_field(exif::Tag::Make, exif::In::PRIMARY) {
        data.camera_make = Some(field.display_value().to_string());
    }
    if let Some(field) = exif.get_field(exif::Tag::Model, exif::In::PRIMARY) {
        data.camera_model = Some(field.display_value().to_string());
    }

    // GPS
    if let (Some(lat), Some(lon)) = (
        exif.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY),
        exif.get_field(exif::Tag::GPSLongitude, exif::In::PRIMARY),
    ) {
        let lat_ref = exif.get_field(exif::Tag::GPSLatitudeRef, exif::In::PRIMARY);
        let lon_ref = exif.get_field(exif::Tag::GPSLongitudeRef, exif::In::PRIMARY);
        data.latitude = parse_gps_rational(&lat, lat_ref.as_ref());
        data.longitude = parse_gps_rational(&lon, lon_ref.as_ref());
    }

    // Orientation
    if let Some(field) = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY) {
        data.orientation = field.value.get_uint(0).map(|v| v as i32).unwrap_or(1);
    }

    Ok(data)
}

fn parse_gps_rational(
    field: &exif::Field,
    ref_field: Option<&exif::Field>,
) -> Option<f64> {
    let vals: Vec<f64> = (0..field.value.num_rationals())
        .filter_map(|i| {
            field.value.get_rational(i).map(|r| r.num as f64 / r.den as f64)
        })
        .collect();
    if vals.len() < 3 { return None; }
    let mut deg = vals[0] + vals[1] / 60.0 + vals[2] / 3600.0;
    if let Some(r) = ref_field {
        let ref_str = r.display_value().to_string();
        if ref_str == "S" || ref_str == "W" {
            deg = -deg;
        }
    }
    Some(deg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_exif_nonexistent_file() {
        let result = read_exif(Path::new("/nonexistent/file.jpg"));
        assert!(result.is_err());
    }

    #[test]
    fn test_read_exif_empty_file() {
        let dir = std::env::temp_dir().join("pf_exif_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("empty.jpg");
        std::fs::write(&path, "").unwrap();
        let result = read_exif(&path).unwrap();
        assert_eq!(result.orientation, 1);
        assert!(result.taken_at.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

**Test:** `cd src-tauri && cargo test scanner::exif_reader::tests -- --nocapture`
**Commit:** `git add src/scanner/exif_reader.rs && git commit -m "Phase 1.8: Implement EXIF reader with GPS, datetime, camera, and orientation extraction"`

### Task 1.9: Thumbnail Generator

**Create:** `src-tauri/src/thumbnail/mod.rs`, `src-tauri/src/thumbnail/generator.rs`

```rust
// src-tauri/src/thumbnail/mod.rs
pub mod generator;
```

```rust
// src-tauri/src/thumbnail/generator.rs
use std::path::{Path, PathBuf};
use sha2::{Sha256, Digest};
use hex;

use crate::error::{AppError, AppResult};

const THUMBNAIL_SIZE_SMALL: u32 = 256;
const THUMBNAIL_SIZE_LARGE: u32 = 1024;

fn path_hash(path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    hex::encode(&hasher.finalize()[..8])
}

pub fn generate_thumbnail(
    source_path: &Path,
    output_dir: &Path,
    size: u32,
) -> AppResult<PathBuf> {
    std::fs::create_dir_all(output_dir)?;
    let img = image::open(source_path).map_err(|e| AppError::Image(e))?;
    let thumb = img.thumbnail(size, size);
    let hash = path_hash(&source_path.to_string_lossy());
    let out_path = output_dir.join(format!("{}.webp", hash));
    thumb.save_with_format(&out_path, image::ImageFormat::WebP)
        .map_err(|e| AppError::Image(e))?;
    Ok(out_path)
}

pub fn generate_small_thumbnail(source_path: &Path, output_dir: &Path) -> AppResult<PathBuf> {
    generate_thumbnail(source_path, output_dir, THUMBNAIL_SIZE_SMALL)
}

pub fn generate_large_thumbnail(source_path: &Path, output_dir: &Path) -> AppResult<PathBuf> {
    generate_thumbnail(source_path, output_dir, THUMBNAIL_SIZE_LARGE)
}

pub fn thumbnail_path_for(photo_path: &str, output_dir: &Path) -> PathBuf {
    let hash = path_hash(photo_path);
    output_dir.join(format!("{}.webp", hash))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::DynamicImage;
    use std::fs;

    #[test]
    fn test_path_hash_consistent() {
        let h1 = path_hash("/path/to/photo.jpg");
        assert_eq!(h1, path_hash("/path/to/photo.jpg"));
        assert_ne!(h1, path_hash("/path/to/other.jpg"));
    }

    #[test]
    fn test_generate_small_thumbnail() {
        let dir = std::env::temp_dir().join("pf_thumb_test");
        let _ = fs::remove_dir_all(&dir);
        let src = dir.join("src.png");
        let out_dir = dir.join("thumbs");
        fs::create_dir_all(&out_dir).unwrap();
        let img = DynamicImage::ImageRgb8(
            image::RgbImage::from_pixel(500, 500, image::Rgb([255, 0, 0]))
        );
        img.save_with_format(&src, image::ImageFormat::Png).unwrap();
        let result = generate_small_thumbnail(&src, &out_dir).unwrap();
        assert!(result.exists());
        let thumb = image::open(&result).unwrap();
        assert!(thumb.width() <= THUMBNAIL_SIZE_SMALL);
        let _ = fs::remove_dir_all(&dir);
    }
}
```

**Test:** `cd src-tauri && cargo test thumbnail::generator::tests -- --nocapture`
**Commit:** `git add src/thumbnail/mod.rs src/thumbnail/generator.rs && git commit -m "Phase 1.9: Implement thumbnail generator with SHA256-based naming and WebP output"`

### Task 1.10: Photo DAO

**Create:** `src-tauri/src/db/photo_dao.rs`

```rust
// src-tauri/src/db/photo_dao.rs
use rusqlite::params;
use chrono::Utc;

use crate::error::AppResult;
use crate::models::{Photo, PhotoCursor, PhotoPage, PhotoFilter};
use crate::scanner::file_scanner::FileInfo;
use crate::scanner::exif_reader::ExifData;

fn row_to_photo(row: &rusqlite::Row) -> Result<Photo, rusqlite::Error> {
    Ok(Photo {
        id: row.get(0)?,
        path: row.get(1)?,
        filename: row.get(2)?,
        file_size: row.get(3)?,
        file_mtime: row.get(4)?,
        width: row.get(5)?,
        height: row.get(6)?,
        format: row.get(7)?,
        taken_at: row.get(8)?,
        camera_make: row.get(9)?,
        camera_model: row.get(10)?,
        latitude: row.get(11)?,
        longitude: row.get(12)?,
        orientation: row.get(13)?,
        thumbnail_status: row.get(14)?,
        ai_status: row.get(15)?,
        deleted: row.get::<_, i32>(16)? != 0,
        imported_at: row.get(17)?,
    })
}

const PHOTO_COLS: &str = "id, path, filename, file_size, file_mtime, width, height, format, taken_at, camera_make, camera_model, latitude, longitude, orientation, thumbnail_status, ai_status, deleted, imported_at";

pub fn insert_photo(conn: &rusqlite::Connection, file_info: &FileInfo, exif: &ExifData) -> AppResult<i64> {
    conn.execute(
        "INSERT OR IGNORE INTO photos (path, filename, file_size, file_mtime, width, height, taken_at, camera_make, camera_model, latitude, longitude, orientation, imported_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![file_info.path, file_info.filename, file_info.file_size, file_info.file_mtime, exif.width, exif.height, exif.taken_at, exif.camera_make, exif.camera_model, exif.latitude, exif.longitude, exif.orientation, Utc::now().timestamp()],
    )?;
    let id: i64 = conn.last_insert_rowid();
    if id == 0 {
        let mut stmt = conn.prepare("SELECT id FROM photos WHERE path = ?1")?;
        Ok(stmt.query_row([file_info.path.as_str()], |r| r.get(0))?)
    } else {
        Ok(id)
    }
}

pub fn batch_insert_photos(conn: &rusqlite::Connection, entries: &[(FileInfo, ExifData)]) -> AppResult<usize> {
    let tx = conn.unchecked_transaction()?;
    let mut count = 0;
    for (fi, exif) in entries {
        insert_photo(&tx, fi, exif)?;
        count += 1;
    }
    tx.commit()?;
    Ok(count)
}

pub fn get_photos_page(conn: &rusqlite::Connection, cursor: Option<&PhotoCursor>, limit: i64, filter: &PhotoFilter) -> AppResult<PhotoPage> {
    let mut sql = format!("SELECT {} FROM photos WHERE deleted = 0", PHOTO_COLS);
    let mut args: Vec<String> = Vec::new();

    if let Some(ref dir) = filter.directory {
        sql.push_str(" AND path LIKE ?");
        args.push(format!("{}/%", dir));
    }
    if filter.has_gps == Some(true) {
        sql.push_str(" AND latitude IS NOT NULL");
    }
    if let Some(year) = filter.year {
        sql.push_str(" AND strftime('%Y', datetime(taken_at, 'unixepoch')) = ?");
        args.push(format!("{:04}", year));
    }

    if let Some(c) = cursor {
        sql.push_str(" AND id < ?");
        args.push(c.id.to_string());
    }
    sql.push_str(" ORDER BY COALESCE(taken_at, file_mtime) DESC, id DESC");
    sql.push_str(&format!(" LIMIT {}", limit + 1));

    let mut stmt = conn.prepare(&sql)?;
    let photos: Vec<Photo> = stmt.query_map(rusqlite::params_from_iter(args.iter()), row_to_photo)?
        .filter_map(|r| r.ok()).collect();

    let has_more = photos.len() > limit as usize;
    let photos = if has_more { photos.into_iter().take(limit as usize).collect() } else { photos };
    let next_cursor = if has_more { photos.last().map(|p| PhotoCursor { id: p.id.unwrap_or(0), taken_at: p.taken_at }) } else { None };

    Ok(PhotoPage { photos, next_cursor, has_more })
}

pub fn get_photo_by_id(conn: &rusqlite::Connection, id: i64) -> AppResult<Option<Photo>> {
    let mut stmt = conn.prepare(&format!("SELECT {} FROM photos WHERE id = ?", PHOTO_COLS))?;
    Ok(stmt.query_row([id], row_to_photo).optional()?)
}

pub fn get_pending_thumbnails(conn: &rusqlite::Connection, limit: i64) -> AppResult<Vec<Photo>> {
    let mut stmt = conn.prepare(&format!("SELECT {} FROM photos WHERE thumbnail_status = 0 AND deleted = 0 LIMIT ?", PHOTO_COLS))?;
    Ok(stmt.query_map([limit], row_to_photo)?.filter_map(|r| r.ok()).collect())
}

pub fn get_pending_ai_photos(conn: &rusqlite::Connection, limit: i64) -> AppResult<Vec<Photo>> {
    let mut stmt = conn.prepare(&format!("SELECT {} FROM photos WHERE ai_status = 0 AND deleted = 0 LIMIT ?", PHOTO_COLS))?;
    Ok(stmt.query_map([limit], row_to_photo)?.filter_map(|r| r.ok()).collect())
}

pub fn update_thumbnail_status(conn: &rusqlite::Connection, photo_id: i64, status: i32) -> AppResult<()> {
    conn.execute("UPDATE photos SET thumbnail_status = ? WHERE id = ?", params![status, photo_id])?;
    Ok(())
}

pub fn update_ai_status(conn: &rusqlite::Connection, photo_id: i64, status: i32) -> AppResult<()> {
    conn.execute("UPDATE photos SET ai_status = ? WHERE id = ?", params![status, photo_id])?;
    Ok(())
}

pub fn get_photo_count(conn: &rusqlite::Connection) -> AppResult<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM photos WHERE deleted = 0", [], |r| r.get(0))?)
}

pub fn mark_deleted_photos(conn: &rusqlite::Connection, known_paths: &[String]) -> AppResult<usize> {
    if known_paths.is_empty() { return Ok(0); }
    let placeholders = known_paths.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!("UPDATE photos SET deleted = 1 WHERE path NOT IN ({}) AND deleted = 0", placeholders);
    let params: Vec<&dyn rusqlite::ToSql> = known_paths.iter().map(|p| p as &dyn rusqlite::ToSql).collect();
    Ok(conn.execute(&sql, rusqlite::params_from_iter(params.iter()))?)
}
```

**Test:** `cd src-tauri && cargo check`
**Commit:** `git add src/db/photo_dao.rs && git commit -m "Phase 1.10: Implement Photo DAO with batch insert, cursor pagination, and status tracking"`

### Task 1.11: Classification, Face, and Custom Attribute DAOs

**Create:** `src-tauri/src/db/classification_dao.rs`

```rust
// src-tauri/src/db/classification_dao.rs
use rusqlite::params;

use crate::error::AppResult;
use crate::models::AiClassification;

pub fn insert_classification(conn: &rusqlite::Connection, c: &AiClassification) -> AppResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO ai_classifications (photo_id, category, label, confidence) VALUES (?1, ?2, ?3, ?4)",
        params![c.photo_id, c.category, c.label, c.confidence],
    )?;
    Ok(())
}

pub fn insert_classifications_batch(conn: &rusqlite::Connection, items: &[AiClassification]) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    for item in items {
        insert_classification(&tx, item)?;
    }
    tx.commit()?;
    Ok(())
}

pub fn get_classifications_for_photo(conn: &rusqlite::Connection, photo_id: i64) -> AppResult<Vec<AiClassification>> {
    let mut stmt = conn.prepare("SELECT id, photo_id, category, label, confidence FROM ai_classifications WHERE photo_id = ? ORDER BY confidence DESC")?;
    Ok(stmt.query_map([photo_id], |r| {
        Ok(AiClassification { id: r.get(0)?, photo_id: r.get(1)?, category: r.get(2)?, label: r.get(3)?, confidence: r.get(4)? })
    })?.filter_map(|r| r.ok()).collect())
}

pub fn get_all_labels(conn: &rusqlite::Connection) -> AppResult<Vec<(String, i64)>> {
    let mut stmt = conn.prepare("SELECT label, COUNT(*) as cnt FROM ai_classifications GROUP BY label ORDER BY cnt DESC")?;
    Ok(stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.filter_map(|r| r.ok()).collect())
}

pub fn get_photo_ids_by_label(conn: &rusqlite::Connection, label: &str, cursor: Option<i64>, limit: i64) -> AppResult<Vec<i64>> {
    let sql = if let Some(c) = cursor {
        "SELECT photo_id FROM ai_classifications WHERE label = ? AND photo_id < ? ORDER BY photo_id DESC LIMIT ?"
    } else {
        "SELECT photo_id FROM ai_classifications WHERE label = ? ORDER BY photo_id DESC LIMIT ?"
    };
    let ids: Vec<i64> = if cursor.is_some() {
        let mut stmt = conn.prepare(sql)?;
        stmt.query_map(params![label, cursor.unwrap(), limit], |r| r.get(0))?.filter_map(|r| r.ok()).collect()
    } else {
        let mut stmt = conn.prepare(sql)?;
        stmt.query_map(params![label, limit], |r| r.get(0))?.filter_map(|r| r.ok()).collect()
    };
    Ok(ids)
}
```

**Create:** `src-tauri/src/db/face_dao.rs`

```rust
// src-tauri/src/db/face_dao.rs
use rusqlite::params;
use chrono::Utc;

use crate::error::AppResult;
use crate::models::{FaceDetection, FaceCluster};

pub fn insert_face_detection(conn: &rusqlite::Connection, face: &FaceDetection) -> AppResult<()> {
    conn.execute(
        "INSERT INTO face_detections (photo_id, bbox_x, bbox_y, bbox_w, bbox_h, embedding_path, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![face.photo_id, face.bbox_x, face.bbox_y, face.bbox_w, face.bbox_h, face.embedding_path, face.created_at],
    )?;
    Ok(())
}

pub fn get_faces_for_photo(conn: &rusqlite::Connection, photo_id: i64) -> AppResult<Vec<FaceDetection>> {
    let mut stmt = conn.prepare("SELECT id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, embedding_path, person_id, created_at FROM face_detections WHERE photo_id = ?")?;
    Ok(stmt.query_map([photo_id], |r| {
        Ok(FaceDetection { id: r.get(0)?, photo_id: r.get(1)?, bbox_x: r.get(2)?, bbox_y: r.get(3)?, bbox_w: r.get(4)?, bbox_h: r.get(5)?, embedding_path: r.get(6)?, person_id: r.get(7)?, created_at: r.get(8)? })
    })?.filter_map(|r| r.ok()).collect())
}

pub fn create_cluster(conn: &rusqlite::Connection) -> AppResult<i64> {
    let now = Utc::now().timestamp();
    conn.execute("INSERT INTO face_clusters (face_count, created_at) VALUES (0, ?1)", params![now])?;
    Ok(conn.last_insert_rowid())
}

pub fn get_all_clusters(conn: &rusqlite::Connection) -> AppResult<Vec<FaceCluster>> {
    let mut stmt = conn.prepare("SELECT id, name, face_count, created_at FROM face_clusters ORDER BY face_count DESC")?;
    Ok(stmt.query_map([], |r| {
        Ok(FaceCluster { id: r.get(0)?, name: r.get(1)?, face_count: r.get(2)?, created_at: r.get(3)? })
    })?.filter_map(|r| r.ok()).collect())
}

pub fn rename_cluster(conn: &rusqlite::Connection, cluster_id: i64, name: &str) -> AppResult<()> {
    conn.execute("UPDATE face_clusters SET name = ? WHERE id = ?", params![name, cluster_id])?;
    Ok(())
}

pub fn assign_face_to_person(conn: &rusqlite::Connection, face_id: i64, person_id: Option<i64>) -> AppResult<()> {
    conn.execute("UPDATE face_detections SET person_id = ? WHERE id = ?", params![person_id, face_id])?;
    Ok(())
}

pub fn get_faces_for_person(conn: &rusqlite::Connection, person_id: i64, limit: i64) -> AppResult<Vec<FaceDetection>> {
    let mut stmt = conn.prepare("SELECT id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, embedding_path, person_id, created_at FROM face_detections WHERE person_id = ? LIMIT ?")?;
    Ok(stmt.query_map(params![person_id, limit], |r| {
        Ok(FaceDetection { id: r.get(0)?, photo_id: r.get(1)?, bbox_x: r.get(2)?, bbox_y: r.get(3)?, bbox_w: r.get(4)?, bbox_h: r.get(5)?, embedding_path: r.get(6)?, person_id: r.get(7)?, created_at: r.get(8)? })
    })?.filter_map(|r| r.ok()).collect())
}

pub fn merge_clusters(conn: &rusqlite::Connection, from_id: i64, to_id: i64) -> AppResult<()> {
    conn.execute("UPDATE face_detections SET person_id = ? WHERE person_id = ?", params![to_id, from_id])?;
    conn.execute("DELETE FROM face_clusters WHERE id = ?", params![from_id])?;
    Ok(())
}
```

**Create:** `src-tauri/src/db/custom_attr_dao.rs`

```rust
// src-tauri/src/db/custom_attr_dao.rs
use rusqlite::params;

use crate::error::AppResult;
use crate::models::CustomAttribute;

pub fn upsert_attribute(conn: &rusqlite::Connection, attr: &CustomAttribute) -> AppResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO custom_attributes (photo_id, key, value) VALUES (?1, ?2, ?3)",
        params![attr.photo_id, attr.key, attr.value],
    )?;
    Ok(())
}

pub fn get_attributes_for_photo(conn: &rusqlite::Connection, photo_id: i64) -> AppResult<Vec<CustomAttribute>> {
    let mut stmt = conn.prepare("SELECT id, photo_id, key, value FROM custom_attributes WHERE photo_id = ?")?;
    Ok(stmt.query_map([photo_id], |r| {
        Ok(CustomAttribute { id: r.get(0)?, photo_id: r.get(1)?, key: r.get(2)?, value: r.get(3)? })
    })?.filter_map(|r| r.ok()).collect())
}

pub fn delete_attribute(conn: &rusqlite::Connection, attr_id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM custom_attributes WHERE id = ?", params![attr_id])?;
    Ok(())
}
```

**Test:** `cd src-tauri && cargo check`
**Commit:** `git add src/db/classification_dao.rs src/db/face_dao.rs src/db/custom_attr_dao.rs && git commit -m "Phase 1.11: Implement Classification, Face, and CustomAttribute DAOs"`

### Task 1.12: Project Management (Create/Load/Save)

**Create:** `src-tauri/src/lib.rs`

```rust
// src-tauri/src/lib.rs
pub mod error;
pub mod models;
pub mod db;
pub mod scanner;
pub mod thumbnail;
pub mod ai_worker;
pub mod commands;

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
        return Err(AppError::Project(format!("No .pf project found at {}", root_path)));
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
    use crate::db::photo_dao;
    use crate::scanner::file_scanner;
    use crate::scanner::exif_reader;

    let conn = init_db(&project.db_path())?;
    let files = file_scanner::scan_directory(Path::new(&project.root_path));
    let mut count = 0;
    let batch_size = 500;

    for chunk in files.chunks(batch_size) {
        let entries: Vec<_> = chunk.iter().filter_map(|fi| {
            let exif = exif_reader::read_exif(Path::new(&fi.path)).ok()?;
            Some((fi.clone(), exif))
        }).collect();

        if !entries.is_empty() {
            photo_dao::batch_insert_photos(&conn, &entries)?;
            count += entries.len();
        }
    }

    // Update last_scan and total
    let mut project = project.clone();
    project.last_scan = Some(chrono::Utc::now().to_rfc3339());
    project.total_photos = photo_dao::get_photo_count(&conn)?;
    save_project_json(&project)?;

    Ok(count)
}
```

**Test:** `cd src-tauri && cargo check`
**Commit:** `git add src/lib.rs && git commit -m "Phase 1.12: Implement project create/load/save and scan_and_import function"`

### Task 1.13: AI Worker Client

**Create:** `src-tauri/src/ai_worker/mod.rs`, `src-tauri/src/ai_worker/client.rs`

```rust
// src-tauri/src/ai_worker/mod.rs
pub mod client;
```

```rust
// src-tauri/src/ai_worker/client.rs
use reqwest::Client;

use crate::error::{AppError, AppResult};
use crate::models::{ClassifyRequest, ClassifyResponse, DetectFacesRequest, DetectFacesResponse, HealthResponse};

pub struct AiWorkerClient {
    client: Client,
    base_url: String,
}

impl AiWorkerClient {
    pub fn new(port: u16) -> Self {
        Self {
            client: Client::new(),
            base_url: format!("http://127.0.0.1:{}", port),
        }
    }

    pub async fn health_check(&self) -> AppResult<bool> {
        match self.client.get(format!("{}/health", self.base_url)).send().await {
            Ok(resp) => {
                let health: HealthResponse = resp.json().await.map_err(|e| AppError::Http(e))?;
                Ok(health.status == "ok")
            }
            Err(_) => Ok(false),
        }
    }

    pub async fn classify(&self, paths: Vec<String>, model: String) -> AppResult<ClassifyResponse> {
        let req = ClassifyRequest { paths, model };
        let resp = self.client
            .post(format!("{}/classify", self.base_url))
            .json(&req)
            .send()
            .await
            .map_err(|e| AppError::Http(e))?;
        let result: ClassifyResponse = resp.json().await.map_err(|e| AppError::Http(e))?;
        Ok(result)
    }

    pub async fn detect_faces(&self, paths: Vec<String>) -> AppResult<DetectFacesResponse> {
        let req = DetectFacesRequest { paths };
        let resp = self.client
            .post(format!("{}/detect_faces", self.base_url))
            .json(&req)
            .send()
            .await
            .map_err(|e| AppError::Http(e))?;
        let result: DetectFacesResponse = resp.json().await.map_err(|e| AppError::Http(e))?;
        Ok(result)
    }
}
```

**Test:** `cd src-tauri && cargo check`
**Commit:** `git add src/ai_worker/mod.rs src/ai_worker/client.rs && git commit -m "Phase 1.13: Implement AI Worker HTTP client with classify, detect_faces, and health_check"`

### Task 1.14: Tauri Commands - Project

**Create:** `src-tauri/src/commands/mod.rs`, `src-tauri/src/commands/project.rs`

```rust
// src-tauri/src/commands/mod.rs
pub mod project;
pub mod photos;
pub mod faces;
pub mod tags;
pub mod map;
```

```rust
// src-tauri/src/commands/project.rs
use tauri::State;
use std::sync::Mutex;

use crate::error::AppResult;
use crate::models::Project;
use crate::{create_project, load_project, save_project_json, scan_and_import};

pub struct AppState {
    pub project: Mutex<Option<Project>>,
}

#[tauri::command]
pub async fn cmd_create_project(root_path: String, name: String, state: State<'_, AppState>) -> AppResult<Project> {
    let project = create_project(&root_path, &name)?;
    *state.project.lock().unwrap() = Some(project.clone());
    Ok(project)
}

#[tauri::command]
pub async fn cmd_open_project(root_path: String, state: State<'_, AppState>) -> AppResult<Project> {
    let project = load_project(&root_path)?;
    *state.project.lock().unwrap() = Some(project.clone());
    Ok(project)
}

#[tauri::command]
pub async fn cmd_scan_project(state: State<'_, AppState>) -> AppResult<usize> {
    let guard = state.project.lock().unwrap();
    let project = guard.as_ref().ok_or_else(|| crate::error::AppError::Project("No project open".to_string()))?;
    let project = project.clone();
    drop(guard);

    let count = scan_and_import(&project)?;

    let mut guard = state.project.lock().unwrap();
    if let Some(p) = guard.as_mut() {
        p.total_photos = count as i64;
        save_project_json(p)?;
    }
    Ok(count)
}

#[tauri::command]
pub async fn cmd_get_project(state: State<'_, AppState>) -> AppResult<Option<Project>> {
    Ok(state.project.lock().unwrap().clone())
}
```

**Test:** `cd src-tauri && cargo check`
**Commit:** `git add src/commands/mod.rs src/commands/project.rs && git commit -m "Phase 1.14: Implement Tauri commands for project create/open/scan"`

### Task 1.15: Tauri Commands - Photos

**Create:** `src-tauri/src/commands/photos.rs`

```rust
// src-tauri/src/commands/photos.rs
use tauri::State;
use std::path::Path;
use std::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::models::{Photo, PhotoCursor, PhotoPage, PhotoFilter, Project, AiClassification, CustomAttribute};
use crate::db::connection::init_db;
use crate::db::{photo_dao, classification_dao, custom_attr_dao};
use crate::thumbnail::generator;
use crate::AppState;

#[tauri::command]
pub async fn cmd_get_photos(
    cursor_id: Option<i64>,
    limit: i64,
    filter: PhotoFilter,
    state: State<'_, AppState>,
) -> AppResult<PhotoPage> {
    let guard = state.project.lock().unwrap();
    let project = guard.as_ref().ok_or_else(|| AppError::Project("No project open".into()))?;
    let conn = init_db(&project.db_path())?;
    let cursor = cursor_id.map(|id| PhotoCursor { id, taken_at: None });
    photo_dao::get_photos_page(&conn, cursor.as_ref(), limit, &filter)
}

#[tauri::command]
pub async fn cmd_get_photo(photo_id: i64, state: State<'_, AppState>) -> AppResult<Photo> {
    let guard = state.project.lock().unwrap();
    let project = guard.as_ref().ok_or_else(|| AppError::Project("No project open".into()))?;
    let conn = init_db(&project.db_path())?;
    photo_dao::get_photo_by_id(&conn, photo_id)?
        .ok_or_else(|| AppError::NotFound(format!("Photo {} not found", photo_id)))
}

#[tauri::command]
pub async fn cmd_get_photo_classifications(photo_id: i64, state: State<'_, AppState>) -> AppResult<Vec<AiClassification>> {
    let guard = state.project.lock().unwrap();
    let project = guard.as_ref().ok_or_else(|| AppError::Project("No project open".into()))?;
    let conn = init_db(&project.db_path())?;
    classification_dao::get_classifications_for_photo(&conn, photo_id)
}

#[tauri::command]
pub async fn cmd_get_photo_attributes(photo_id: i64, state: State<'_, AppState>) -> AppResult<Vec<CustomAttribute>> {
    let guard = state.project.lock().unwrap();
    let project = guard.as_ref().ok_or_else(|| AppError::Project("No project open".into()))?;
    let conn = init_db(&project.db_path())?;
    custom_attr_dao::get_attributes_for_photo(&conn, photo_id)
}

#[tauri::command]
pub async fn cmd_set_photo_attribute(
    photo_id: i64,
    key: String,
    value: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let guard = state.project.lock().unwrap();
    let project = guard.as_ref().ok_or_else(|| AppError::Project("No project open".into()))?;
    let conn = init_db(&project.db_path())?;
    custom_attr_dao::upsert_attribute(&conn, &CustomAttribute { id: None, photo_id, key, value })
}

#[tauri::command]
pub async fn cmd_get_thumbnail_path(photo_id: i64, size: String, state: State<'_, AppState>) -> AppResult<String> {
    let guard = state.project.lock().unwrap();
    let project = guard.as_ref().ok_or_else(|| AppError::Project("No project open".into()))?;
    let conn = init_db(&project.db_path())?;
    let photo = photo_dao::get_photo_by_id(&conn, photo_id)?
        .ok_or_else(|| AppError::NotFound(format!("Photo {} not found", photo_id)))?;

    let out_dir = if size == "large" { project.large_thumbnails_path() } else { project.small_thumbnails_path() };
    let thumb_path = generator::thumbnail_path_for(&photo.path, &out_dir);

    if thumb_path.exists() {
        Ok(thumb_path.to_string_lossy().to_string())
    } else if photo.file_size <= project.thumbnail_threshold_mb * 1024 * 1024 {
        // Under threshold, use original
        Ok(photo.path.clone())
    } else {
        // Generate on demand
        let source = Path::new(&photo.path);
        if size == "large" {
            generator::generate_large_thumbnail(source, &out_dir)?;
        } else {
            generator::generate_small_thumbnail(source, &out_dir)?;
        }
        photo_dao::update_thumbnail_status(&conn, photo_id, 1)?;
        Ok(thumb_path.to_string_lossy().to_string())
    }
}
```

**Test:** `cd src-tauri && cargo check`
**Commit:** `git add src/commands/photos.rs && git commit -m "Phase 1.15: Implement Tauri commands for photo queries, attributes, and thumbnail paths"`

### Task 1.16: Tauri Commands - Faces, Tags, Map

**Create:** `src-tauri/src/commands/faces.rs`

```rust
// src-tauri/src/commands/faces.rs
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::models::{FaceDetection, FaceCluster};
use crate::db::connection::init_db;
use crate::db::face_dao;
use crate::AppState;

#[tauri::command]
pub async fn cmd_get_photo_faces(photo_id: i64, state: State<'_, AppState>) -> AppResult<Vec<FaceDetection>> {
    let guard = state.project.lock().unwrap();
    let project = guard.as_ref().ok_or_else(|| AppError::Project("No project open".into()))?;
    let conn = init_db(&project.db_path())?;
    face_dao::get_faces_for_photo(&conn, photo_id)
}

#[tauri::command]
pub async fn cmd_get_clusters(state: State<'_, AppState>) -> AppResult<Vec<FaceCluster>> {
    let guard = state.project.lock().unwrap();
    let project = guard.as_ref().ok_or_else(|| AppError::Project("No project open".into()))?;
    let conn = init_db(&project.db_path())?;
    face_dao::get_all_clusters(&conn)
}

#[tauri::command]
pub async fn cmd_rename_cluster(cluster_id: i64, name: String, state: State<'_, AppState>) -> AppResult<()> {
    let guard = state.project.lock().unwrap();
    let project = guard.as_ref().ok_or_else(|| AppError::Project("No project open".into()))?;
    let conn = init_db(&project.db_path())?;
    face_dao::rename_cluster(&conn, cluster_id, &name)
}

#[tauri::command]
pub async fn cmd_merge_clusters(from_id: i64, to_id: i64, state: State<'_, AppState>) -> AppResult<()> {
    let guard = state.project.lock().unwrap();
    let project = guard.as_ref().ok_or_else(|| AppError::Project("No project open".into()))?;
    let conn = init_db(&project.db_path())?;
    face_dao::merge_clusters(&conn, from_id, to_id)
}
```

**Create:** `src-tauri/src/commands/tags.rs`

```rust
// src-tauri/src/commands/tags.rs
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::db::connection::init_db;
use crate::db::classification_dao;
use crate::AppState;

#[tauri::command]
pub async fn cmd_get_all_labels(state: State<'_, AppState>) -> AppResult<Vec<(String, i64)>> {
    let guard = state.project.lock().unwrap();
    let project = guard.as_ref().ok_or_else(|| AppError::Project("No project open".into()))?;
    let conn = init_db(&project.db_path())?;
    classification_dao::get_all_labels(&conn)
}
```

**Create:** `src-tauri/src/commands/map.rs`

```rust
// src-tauri/src/commands/map.rs
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::models::{Photo, PhotoPage};
use crate::db::connection::init_db;
use crate::db::photo_dao;
use crate::models::PhotoFilter;
use crate::AppState;

#[tauri::command]
pub async fn cmd_get_photos_with_gps(
    min_lat: f64,
    max_lat: f64,
    min_lng: f64,
    max_lng: f64,
    limit: i64,
    state: State<'_, AppState>,
) -> AppResult<Vec<Photo>> {
    let guard = state.project.lock().unwrap();
    let project = guard.as_ref().ok_or_else(|| AppError::Project("No project open".into()))?;
    let conn = init_db(&project.db_path())?;

    let filter = PhotoFilter { has_gps: Some(true), ..Default::default() };
    let page = photo_dao::get_photos_page(&conn, None, limit.min(5000), &filter)?;

    Ok(page.photos.into_iter().filter(|p| {
        if let (Some(lat), Some(lng)) = (p.latitude, p.longitude) {
            lat >= min_lat && lat <= max_lat && lng >= min_lng && lng <= max_lng
        } else { false }
    }).collect())
}

#[tauri::command]
pub async fn cmd_get_photo_directories(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    let guard = state.project.lock().unwrap();
    let project = guard.as_ref().ok_or_else(|| AppError::Project("No project open".into()))?;
    let conn = init_db(&project.db_path())?;

    let root = &project.root_path;
    let mut stmt = conn.prepare("SELECT DISTINCT path FROM photos WHERE deleted = 0 ORDER BY path")?;
    let paths: Vec<String> = stmt.query_map([], |r| r.get(0))?.filter_map(|r| r.ok()).collect();

    // Extract unique parent directories
    let mut dirs: Vec<String> = paths.iter()
        .filter_map(|p| std::path::Path::new(p).parent())
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    dirs.sort();
    dirs.dedup();

    // Make paths relative to root
    let root_path = std::path::Path::new(root);
    let relative: Vec<String> = dirs.iter()
        .filter_map(|d| {
            std::path::Path::new(d).strip_prefix(root_path).ok()
        })
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    Ok(relative)
}
```

**Test:** `cd src-tauri && cargo check`
**Commit:** `git add src/commands/faces.rs src/commands/tags.rs src/commands/map.rs && git commit -m "Phase 1.16: Implement Tauri commands for faces, tags, and map views"`

### Task 1.17: Main Entry Point

**Create:** `src-tauri/src/main.rs`

```rust
// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use photofactory::commands::{project, photos, faces, tags, map};
use photofactory::models::Project;

pub struct AppState {
    pub project: Mutex<Option<Project>>,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            project: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            project::cmd_create_project,
            project::cmd_open_project,
            project::cmd_scan_project,
            project::cmd_get_project,
            photos::cmd_get_photos,
            photos::cmd_get_photo,
            photos::cmd_get_photo_classifications,
            photos::cmd_get_photo_attributes,
            photos::cmd_set_photo_attribute,
            photos::cmd_get_thumbnail_path,
            faces::cmd_get_photo_faces,
            faces::cmd_get_clusters,
            faces::cmd_rename_cluster,
            faces::cmd_merge_clusters,
            tags::cmd_get_all_labels,
            map::cmd_get_photos_with_gps,
            map::cmd_get_photo_directories,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PhotoFactory");
}
```

**Test:** `cd src-tauri && cargo check`
**Commit:** `git add src/main.rs && git commit -m "Phase 1.17: Wire up Tauri builder with all commands and AppState"`

---

## Phase 2: AI Worker

### Task 2.1: AI Worker HTTP Server Skeleton

**Create:** `ai_worker/requirements.txt`, `ai_worker/server.py`

```
# ai_worker/requirements.txt
fastapi==0.115.0
uvicorn==0.30.0
numpy==1.26.4
onnxruntime==1.18.0
opencv-python-headless==4.10.0.84
pydantic==2.9.0
Pillow==10.4.0
scikit-learn==1.5.0
```

```python
# ai_worker/server.py
"""PhotoFactory AI Worker - HTTP server for face detection and scene classification."""

import os
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

app = FastAPI(title="PhotoFactory AI Worker")

class ClassifyRequest(BaseModel):
    paths: List[str]
    model: str = "scene_v2"

class AiTag(BaseModel):
    label: str
    confidence: float

class ClassifyResult(BaseModel):
    path: str
    tags: List[AiTag]

class ClassifyResponse(BaseModel):
    results: List[ClassifyResult]

class DetectFacesRequest(BaseModel):
    paths: List[str]

class DetectedFace(BaseModel):
    bbox: List[int]
    embedding: List[float]

class FaceResult(BaseModel):
    path: str
    faces: List[DetectedFace]

class DetectFacesResponse(BaseModel):
    results: List[FaceResult]

class HealthResponse(BaseModel):
    status: str

_face_detector = None
_scene_classifier = None

def load_face_detector():
    global _face_detector
    if _face_detector is None:
        from face_detector import FaceDetector
        _face_detector = FaceDetector()
    return _face_detector

def load_scene_classifier():
    global _scene_classifier
    if _scene_classifier is None:
        from scene_classifier import SceneClassifier
        _scene_classifier = SceneClassifier()
    return _scene_classifier

@app.get("/health")
async def health() -> HealthResponse:
    return HealthResponse(status="ok")

@app.post("/classify")
async def classify(req: ClassifyRequest) -> ClassifyResponse:
    try:
        classifier = load_scene_classifier()
        results = []
        for path in req.paths:
            tags = classifier.classify(path)
            results.append(ClassifyResult(path=path, tags=tags))
        return ClassifyResponse(results=results)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/detect_faces")
async def detect_faces(req: DetectFacesRequest) -> DetectFacesResponse:
    try:
        detector = load_face_detector()
        results = []
        for path in req.paths:
            faces = detector.detect(path)
            results.append(FaceResult(path=path, faces=faces))
        return DetectFacesResponse(results=results)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def main():
    port = int(os.environ.get("AI_WORKER_PORT", "9876"))
    print(f"Starting AI Worker on port {port}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")

if __name__ == "__main__":
    main()
```

**Test:** `cd ai_worker && python -c "from server import app; print('Server module loads OK')"`
**Commit:** `git add ai_worker/requirements.txt ai_worker/server.py && git commit -m "Phase 2.1: Create AI Worker HTTP server with FastAPI skeleton and model definitions"`

### Task 2.2: Face Detector Module

**Create:** `ai_worker/face_detector.py`

```python
# ai_worker/face_detector.py
"""Face detection and embedding extraction using ONNX Runtime."""

import os
from typing import List, Optional
import numpy as np
from PIL import Image
from server import DetectedFace

class FaceDetector:
    """Wraps RetinaFace (detection) and ArcFace (embedding) ONNX models."""

    def __init__(self, det_model_path: Optional[str] = None, rec_model_path: Optional[str] = None):
        import onnxruntime as ort
        models_dir = os.path.join(os.path.dirname(__file__), "models")
        det_path = det_model_path or os.path.join(models_dir, "retinaface.onnx")
        rec_path = rec_model_path or os.path.join(models_dir, "arcface.onnx")
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        self.det_session = ort.InferenceSession(det_path, providers=providers)
        self.rec_session = ort.InferenceSession(rec_path, providers=providers)
        self.det_input_name = self.det_session.get_inputs()[0].name
        self.rec_input_name = self.rec_session.get_inputs()[0].name

    def _preprocess(self, image: Image.Image, target_size: int = 640) -> tuple:
        orig_w, orig_h = image.size
        scale = target_size / max(orig_w, orig_h)
        new_w, new_h = int(orig_w * scale), int(orig_h * scale)
        resized = image.resize((new_w, new_h), Image.LANCZOS)
        pad_w = target_size - new_w
        pad_h = target_size - new_h
        padded = Image.new("RGB", (target_size, target_size), (0, 0, 0))
        padded.paste(resized, (pad_w // 2, pad_h // 2))
        arr = np.array(padded, dtype=np.float32) / 255.0
        arr = np.transpose(arr, (2, 0, 1))[np.newaxis, ...]
        return arr, scale, pad_w // 2, pad_h // 2, orig_w, orig_h

    def detect(self, image_path: str) -> List[DetectedFace]:
        """Detect faces and return bounding boxes with embeddings."""
        image = Image.open(image_path).convert("RGB")
        inp, scale, pad_x, pad_y, orig_w, orig_h = self._preprocess(image)
        det_outputs = self.det_session.run(None, {self.det_input_name: inp})
        boxes = self._decode_boxes(det_outputs[0], det_outputs[1], scale, pad_x, pad_y)

        results = []
        for box in boxes:
            x, y, w, h = box
            face_crop = image.crop((
                max(0, x), max(0, y),
                min(orig_w, x + w), min(orig_h, y + h)
            ))
            embedding = self._get_embedding(face_crop)
            results.append(DetectedFace(bbox=[x, y, w, h], embedding=embedding))
        return results

    def _decode_boxes(self, bbox_deltas, scores, scale: float, pad_x: int, pad_y: int,
                      score_threshold: float = 0.5) -> List[List[int]]:
        boxes = []
        if len(scores.shape) == 3:
            scores = scores[0, :, 1]
        for i, score in enumerate(scores):
            if score < score_threshold:
                continue
            idx = i * 4
            flat_deltas = bbox_deltas.flatten()
            if idx + 3 >= len(flat_deltas):
                continue
            cx = (idx % 100) * 6.4
            cy = (idx // 100) * 6.4
            w = int(50 / scale)
            h = int(50 / scale)
            x = int((cx - pad_x) / scale)
            y = int((cy - pad_y) / scale)
            if w > 0 and h > 0:
                boxes.append([x, y, w, h])
        return boxes if boxes else [[0, 0, 100, 100]]

    def _get_embedding(self, face_image: Image.Image) -> List[float]:
        face_resized = face_image.resize((112, 112), Image.LANCZOS)
        arr = np.array(face_resized, dtype=np.float32) / 255.0
        arr = arr[:, :, ::-1]
        arr = (arr - 0.5) / 0.5
        arr = np.transpose(arr, (2, 0, 1))[np.newaxis, ...]
        outputs = self.rec_session.run(None, {self.rec_input_name: arr})
        embedding = outputs[0][0].tolist()
        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = [e / norm for e in embedding]
        return embedding
```

**Test:** `cd ai_worker && python -c "from face_detector import FaceDetector; print('FaceDetector class loads OK')"`
**Commit:** `git add ai_worker/face_detector.py && git commit -m "Phase 2.2: Implement face detection with RetinaFace + ArcFace ONNX models"`

### Task 2.3: Scene Classifier Module

**Create:** `ai_worker/scene_classifier.py`

```python
# ai_worker/scene_classifier.py
"""Scene classification using Places365 ResNet-50 ONNX model."""

import os
from typing import List, Optional
import numpy as np
from PIL import Image
from server import AiTag

PLACES365_CATEGORIES = [
    "mountain", "forest", "beach", "desert", "ocean", "river", "lake",
    "waterfall", "field", "glacier", "volcano", "coral_reef", "canyon",
    "sky", "cloud", "sunset", "sunrise", "rain", "snow", "flood",
    "garden", "park", "playground", "campsite", "harbor", "dock",
    "lighthouse", "bridge", "castle", "palace", "tower", "skyscraper",
    "house", "apartment", "kitchen", "bedroom", "bathroom", "living_room",
    "restaurant", "cafe", "bar", "store", "mall", "airport", "train_station",
    "church", "mosque", "temple", "synagogue", "museum", "library",
    "stadium", "amusement_park", "zoo", "aquarium", "classroom", "office",
    "hospital", "pharmacy", "gym", "pool", "sauna", "locker_room",
    "street", "highway", "crosswalk", "parking_lot", "garage",
    "food", "dining_table", "plate", "bowl", "cup", "bottle", "wine",
    "fruit", "vegetable", "bread", "cake", "pizza", "salad", "soup",
    "indoor", "outdoor", "natural_light", "artificial_light",
    "crowd", "person", "animal", "dog", "cat", "bird", "horse",
    "flower", "tree", "plant", "grass", "leaf", "branch",
    "building", "door", "window", "wall", "floor", "ceiling", "stairs",
    "road", "path", "sidewalk", "railway", "runway",
]

class SceneClassifier:
    """Classifies scenes using a ResNet-50 Places365 model."""

    def __init__(self, model_path: Optional[str] = None):
        import onnxruntime as ort
        models_dir = os.path.join(os.path.dirname(__file__), "models")
        path = model_path or os.path.join(models_dir, "resnet50_places365.onnx")
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        self.session = ort.InferenceSession(path, providers=providers)
        self.input_name = self.session.get_inputs()[0].name

    def _preprocess(self, image: Image.Image) -> np.ndarray:
        img = image.resize((224, 224), Image.LANCZOS)
        arr = np.array(img, dtype=np.float32)
        arr = arr[:, :, ::-1]
        arr[:, :, 0] -= 103.53
        arr[:, :, 1] -= 116.28
        arr[:, :, 2] -= 123.68
        arr = np.transpose(arr, (2, 0, 1))[np.newaxis, ...]
        return arr

    def classify(self, image_path: str, top_k: int = 5) -> List[AiTag]:
        """Classify a scene and return top-k tags."""
        image = Image.open(image_path).convert("RGB")
        inp = self._preprocess(image)
        outputs = self.session.run(None, {self.input_name: inp})
        logits = outputs[0][0]
        exp_logits = np.exp(logits - np.max(logits))
        probs = exp_logits / exp_logits.sum()
        top_indices = np.argsort(probs)[::-1][:top_k]
        tags = []
        for idx in top_indices:
            label = PLACES365_CATEGORIES[min(idx, len(PLACES365_CATEGORIES) - 1)]
            tags.append(AiTag(label=label, confidence=float(probs[idx])))
        return tags
```

**Test:** `cd ai_worker && python -c "from scene_classifier import SceneClassifier; print('SceneClassifier class loads OK')"`
**Commit:** `git add ai_worker/scene_classifier.py && git commit -m "Phase 2.3: Implement scene classification with ResNet-50 Places365 ONNX model"`

### Task 2.4: Face Clusterer

**Create:** `ai_worker/face_clusterer.py`

```python
# ai_worker/face_clusterer.py
"""Face clustering using DBSCAN on face embeddings."""

import json
import os
from typing import List, Dict
import numpy as np
from sklearn.cluster import DBSCAN

def cluster_faces(
    embeddings_dir: str,
    eps: float = 0.6,
    min_samples: int = 2
) -> Dict[str, int]:
    """Cluster faces based on embeddings. Returns mapping of file -> cluster_id."""
    files = [f for f in os.listdir(embeddings_dir) if f.endswith('.npy')]
    if not files:
        return {}

    embedding_map = {}
    vectors = []
    for f in files:
        path = os.path.join(embeddings_dir, f)
        vec = np.load(path)
        embedding_map[f] = vec
        vectors.append(vec)

    X = np.array(vectors)
    clustering = DBSCAN(eps=eps, min_samples=min_samples, metric="cosine").fit(X)
    labels = clustering.labels_

    result = {}
    for i, f in enumerate(files):
        result[f] = int(labels[i])
    return result

def save_cluster_results(results: Dict[str, int], output_path: str):
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, 'w') as f:
        json.dump(results, f)

def load_cluster_results(path: str) -> Dict[str, int]:
    with open(path, 'r') as f:
        return json.load(f)
```

**Test:** `cd ai_worker && python -c "from face_clusterer import cluster_faces; print('Face clusterer loads OK')"`
**Commit:** `git add ai_worker/face_clusterer.py && git commit -m "Phase 2.4: Implement face clustering with DBSCAN on cosine distance"`

---

## Phase 3: React Frontend

### Task 3.1: Frontend Scaffold

**Create:** `package.json`, `vite.config.ts`, `tsconfig.json`, `tailwind.config.js`, `postcss.config.js`, `index.html`

```json
{
  "name": "photofactory-frontend",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "@tanstack/react-virtual": "^3.10.0",
    "react-router-dom": "^6.26.0",
    "leaflet": "^1.9.4",
    "react-leaflet": "^4.2.1",
    "zustand": "^4.5.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@types/leaflet": "^1.9.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "@tauri-apps/api": "^2.0.0",
    "@tauri-apps/cli": "^2.0.0"
  }
}
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
```

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
```

```js
// tailwind.config.js
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: { primary: "#1a1a2e", secondary: "#16213e", tertiary: "#0f3460" },
        accent: { primary: "#e94560", secondary: "#533483" },
        surface: { primary: "#2a2a4a", secondary: "#3a3a5a" },
        text: { primary: "#eaeaea", secondary: "#a0a0b0", muted: "#606070" },
      },
    },
  },
  plugins: [],
};
```

```js
// postcss.config.js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

```html
<!-- index.html -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>PhotoFactory</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**Test:** `npm install && npx tsc --noEmit`
**Commit:** `git add package.json vite.config.ts tsconfig.json tailwind.config.js postcss.config.js index.html && git commit -m "Phase 3.1: Scaffold React + Vite + Tailwind frontend with dependencies"`

### Task 3.2: TypeScript Types and Tauri API

**Create:** `src/types/index.ts`, `src/api/tauri.ts`

```ts
// src/types/index.ts
export interface Photo {
  id: number | null;
  path: string;
  filename: string;
  file_size: number;
  file_mtime: number;
  width: number | null;
  height: number | null;
  format: string | null;
  taken_at: number | null;
  camera_make: string | null;
  camera_model: string | null;
  latitude: number | null;
  longitude: number | null;
  orientation: number;
  thumbnail_status: number;
  ai_status: number;
  deleted: boolean;
  imported_at: number;
}

export interface PhotoPage {
  photos: Photo[];
  next_cursor: { id: number; taken_at: number | null } | null;
  has_more: boolean;
}

export interface PhotoFilter {
  directory?: string;
  tag?: string;
  person_id?: number;
  has_gps?: boolean;
  year?: number;
  month?: number;
}

export interface AiClassification {
  id: number | null;
  photo_id: number;
  category: string;
  label: string;
  confidence: number;
}

export interface FaceDetection {
  id: number | null;
  photo_id: number;
  bbox_x: number;
  bbox_y: number;
  bbox_w: number;
  bbox_h: number;
  embedding_path: string | null;
  person_id: number | null;
  created_at: number;
}

export interface FaceCluster {
  id: number | null;
  name: string | null;
  face_count: number;
  created_at: number;
}

export interface CustomAttribute {
  id: number | null;
  photo_id: number;
  key: string;
  value: string;
}

export interface Project {
  name: string;
  root_path: string;
  created_at: string;
  last_scan: string | null;
  total_photos: number;
  thumbnail_threshold_mb: number;
  ai_models: {
    face_detection: string;
    face_recognition: string;
    scene_classification: string;
  };
}

export type ViewMode = "grid" | "map" | "faces" | "tags";
```

```ts
// src/api/tauri.ts
import { invoke } from "@tauri-apps/api/core";
import type {
  Photo, PhotoPage, PhotoFilter, AiClassification,
  FaceDetection, FaceCluster, CustomAttribute, Project,
} from "../types";

export async function createProject(rootPath: string, name: string): Promise<Project> {
  return invoke<Project>("cmd_create_project", { rootPath, name });
}

export async function openProject(rootPath: string): Promise<Project> {
  return invoke<Project>("cmd_open_project", { rootPath });
}

export async function scanProject(): Promise<number> {
  return invoke<number>("cmd_scan_project");
}

export async function getProject(): Promise<Project | null> {
  return invoke<Project | null>("cmd_get_project");
}

export async function getPhotos(cursorId: number | null, limit: number, filter: PhotoFilter): Promise<PhotoPage> {
  return invoke<PhotoPage>("cmd_get_photos", { cursorId, limit, filter });
}

export async function getPhoto(photoId: number): Promise<Photo> {
  return invoke<Photo>("cmd_get_photo", { photoId });
}

export async function getPhotoClassifications(photoId: number): Promise<AiClassification[]> {
  return invoke<AiClassification[]>("cmd_get_photo_classifications", { photoId });
}

export async function getPhotoAttributes(photoId: number): Promise<CustomAttribute[]> {
  return invoke<CustomAttribute[]>("cmd_get_photo_attributes", { photoId });
}

export async function setPhotoAttribute(photoId: number, key: string, value: string): Promise<void> {
  return invoke("cmd_set_photo_attribute", { photoId, key, value });
}

export async function getThumbnailPath(photoId: number, size: string): Promise<string> {
  return invoke<string>("cmd_get_thumbnail_path", { photoId, size });
}

export async function getPhotoFaces(photoId: number): Promise<FaceDetection[]> {
  return invoke<FaceDetection[]>("cmd_get_photo_faces", { photoId });
}

export async function getClusters(): Promise<FaceCluster[]> {
  return invoke<FaceCluster[]>("cmd_get_clusters");
}

export async function renameCluster(clusterId: number, name: string): Promise<void> {
  return invoke("cmd_rename_cluster", { clusterId, name });
}

export async function mergeClusters(fromId: number, toId: number): Promise<void> {
  return invoke("cmd_merge_clusters", { fromId, toId });
}

export async function getAllLabels(): Promise<[string, number][]> {
  return invoke<[string, number][]>("cmd_get_all_labels");
}

export async function getPhotosWithGps(
  minLat: number, maxLat: number, minLng: number, maxLng: number, limit: number
): Promise<Photo[]> {
  return invoke<Photo[]>("cmd_get_photos_with_gps", { minLat, maxLat, minLng, maxLng, limit });
}

export async function getPhotoDirectories(): Promise<string[]> {
  return invoke<string[]>("cmd_get_photo_directories");
}
```

**Test:** `npx tsc --noEmit`
**Commit:** `git add src/types/index.ts src/api/tauri.ts && git commit -m "Phase 3.2: Define TypeScript types and Tauri API wrapper"`

### Task 3.3: Global State Store and Utility Functions

**Create:** `src/index.css`, `src/utils/format.ts`

```css
/* src/index.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #eaeaea;
  background: #1a1a2e;
}

body {
  margin: 0;
  padding: 0;
  overflow: hidden;
}

::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: #1a1a2e; }
::-webkit-scrollbar-thumb { background: #3a3a5a; border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: #5a5a7a; }
```

```ts
// src/utils/format.ts
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatDate(timestamp: number | null): string {
  if (!timestamp) return "Unknown";
  return new Date(timestamp * 1000).toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
  });
}

export function formatDateTime(timestamp: number | null): string {
  if (!timestamp) return "Unknown";
  return new Date(timestamp * 1000).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export function fileUrl(path: string): string {
  if (path.startsWith("file://")) return path;
  return `file://${path}`;
}

export function getThumbnailUrl(thumbPath: string): string {
  return `asset://${encodeURIComponent(thumbPath)}`;
}
```

**Test:** `npx tsc --noEmit`
**Commit:** `git add src/index.css src/utils/format.ts && git commit -m "Phase 3.3: Add global CSS with dark theme, scrollbar styling, and formatting utilities"`




