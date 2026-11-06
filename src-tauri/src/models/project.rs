// src-tauri/src/models/project.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScanResult {
    pub added: usize,
    pub updated: usize,
    pub restored: usize,
    pub deleted: usize,
    pub unchanged: usize,
}

impl ScanResult {
    pub fn changed(&self) -> usize {
        self.added + self.updated + self.restored + self.deleted
    }
}

/// Default extensions enabled for import: common image formats only.
pub const DEFAULT_EXTENSIONS: &[&str] =
    &["jpg", "jpeg", "png", "gif", "bmp", "webp", "heic", "heif"];

fn default_extensions() -> Vec<String> {
    DEFAULT_EXTENSIONS.iter().map(|s| s.to_string()).collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub name: String,
    pub root_path: String,
    pub created_at: String,
    pub last_scan: Option<String>,
    pub total_photos: i64,
    pub thumbnail_threshold_mb: i64,
    pub ai_models: AiModelConfig,
    #[serde(default = "default_extensions")]
    pub enabled_extensions: Vec<String>,
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
            thumbnail_threshold_mb: 30,
            ai_models: AiModelConfig::default(),
            enabled_extensions: DEFAULT_EXTENSIONS.iter().map(|s| s.to_string()).collect(),
        }
    }

    pub fn pf_path(&self) -> std::path::PathBuf {
        std::path::PathBuf::from(&self.root_path).join(".pf")
    }
    pub fn db_path(&self) -> std::path::PathBuf {
        self.pf_path().join("photos.db")
    }
    pub fn small_thumbnails_path(&self) -> std::path::PathBuf {
        self.pf_path().join("thumbnails/small")
    }
    pub fn medium_thumbnails_path(&self) -> std::path::PathBuf {
        self.pf_path().join("thumbnails/medium")
    }
    pub fn large_thumbnails_path(&self) -> std::path::PathBuf {
        self.pf_path().join("thumbnails/large")
    }
    pub fn tiles_path(&self) -> std::path::PathBuf {
        self.pf_path().join("maps/tiles")
    }
    pub fn faces_cache_path(&self) -> std::path::PathBuf {
        self.pf_path().join("ai_cache/faces")
    }
    pub fn tags_cache_path(&self) -> std::path::PathBuf {
        self.pf_path().join("ai_cache/tags")
    }
    pub fn project_json_path(&self) -> std::path::PathBuf {
        self.pf_path().join("project.json")
    }
}
