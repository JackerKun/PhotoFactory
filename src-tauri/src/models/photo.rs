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
    pub exposure_time: Option<String>,
    pub f_number: Option<String>,
    pub iso: Option<u32>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub orientation: i32,
    pub thumbnail_status: i32,
    pub ai_status: i32,
    pub deleted: bool,
    pub is_favorite: bool,
    pub rating: i32,
    pub imported_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhotoCursor {
    pub id: i64,
    pub sort_value: i64,
    #[serde(default)]
    pub sort_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhotoPage {
    pub photos: Vec<Photo>,
    pub next_cursor: Option<PhotoCursor>,
    pub has_more: bool,
    pub total_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PhotoTimelineBucket {
    pub year: i32,
    pub month: u32,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PhotoFilter {
    pub directory: Option<String>,
    pub tag: Option<String>,
    pub person_id: Option<i64>,
    pub has_gps: Option<bool>,
    pub has_favorite: Option<bool>,
    pub year: Option<i32>,
    pub month: Option<u32>,
    pub keyword: Option<String>,
    pub format: Option<String>,
    pub camera: Option<String>,
    pub iso_min: Option<u32>,
    pub iso_max: Option<u32>,
    pub aperture_min: Option<f64>,
    pub aperture_max: Option<f64>,
    pub exposure_time: Option<String>,
    pub orientation_kind: Option<String>,
    pub rating_min: Option<i32>,
    pub rating_max: Option<i32>,
    pub sort_by: Option<String>,
    pub sort_direction: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PhotoFilterFacet {
    pub value: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PhotoFilterOptions {
    pub formats: Vec<PhotoFilterFacet>,
    pub cameras: Vec<PhotoFilterFacet>,
    pub exposure_times: Vec<PhotoFilterFacet>,
    pub iso_min: Option<u32>,
    pub iso_max: Option<u32>,
    pub aperture_min: Option<f64>,
    pub aperture_max: Option<f64>,
}

pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    // Common
    "jpg", "jpeg", "png", "gif", "bmp", "webp", "heic", "heif",
    // RAW (includes TIFF as per user request)
    "cr2", "cr3", "nef", "arw", "orf", "rw2", "pef", "dng", "raf", "tif", "tiff",
    // Professional
    "psd", "xcf", "exr", "raw",
];

/// Person details with timeline info.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonDetail {
    pub person_id: i64,
    pub user_name: Option<String>,
    pub face_count: i64,
    pub confidence: String,
    pub first_seen: Option<String>,
    pub last_seen: Option<String>,
    pub cover_photo_id: Option<i64>,
}
