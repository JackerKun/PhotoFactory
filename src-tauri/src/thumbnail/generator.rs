use hex;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

const THUMBNAIL_SIZE_SMALL: u32 = 256;
const THUMBNAIL_SIZE_MEDIUM: u32 = 512;
const THUMBNAIL_SIZE_LARGE: u32 = 1024;

const RAW_EXTENSIONS: &[&str] = &["arw", "cr2", "nef", "dng", "raw", "orf", "rw2", "pef"];

/// Formats that need external conversion before the image crate can read them.
const CONVERSION_EXTENSIONS: &[&str] = &["heic", "heif"];

pub fn is_raw_format(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| RAW_EXTENSIONS.contains(&e.to_lowercase().trim_start_matches('.')))
        .unwrap_or(false)
}

/// Check if the file needs external conversion (HEIC/HEIF).
fn needs_conversion(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| CONVERSION_EXTENSIONS.contains(&e.to_lowercase().trim_start_matches('.')))
        .unwrap_or(false)
}

/// Convert a RAW file to JPEG. On macOS uses sips; on other platforms tries image crate.
fn raw_to_jpeg(raw_path: &Path) -> AppResult<PathBuf> {
    let temp_dir = std::env::temp_dir().join("photofactory_raw");
    std::fs::create_dir_all(&temp_dir)?;
    let hash = path_hash(&raw_path.to_string_lossy());
    // A photo can be requested concurrently at small/medium/large sizes. A
    // path derived only from the source made those conversions delete each
    // other's intermediate JPEG. Give every conversion its own file.
    let jpeg_path = temp_dir.join(format!("{}-{}.jpg", hash, uuid::Uuid::new_v4()));

    // Try image crate first (handles some DNG/TIFF files)
    if let Ok(img) = image::open(raw_path) {
        img.save_with_format(&jpeg_path, image::ImageFormat::Jpeg)
            .map_err(|e| AppError::Image(e))?;
        return Ok(jpeg_path);
    }

    // macOS: use sips
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("sips")
            .args([
                "-s",
                "format",
                "jpeg",
                "-s",
                "formatOptions",
                "90",
                raw_path.to_str().unwrap(),
                "-o",
                jpeg_path.to_str().unwrap(),
            ])
            .output()
            .map_err(|e| AppError::Io(e))?;

        if output.status.success() && jpeg_path.exists() {
            return Ok(jpeg_path);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Image(image::ImageError::IoError(
            std::io::Error::other(format!("RAW conversion failed (sips): {}", stderr)),
        )));
    }

    // Other platforms: no sips available
    #[cfg(not(target_os = "macos"))]
    {
        Err(AppError::Image(image::ImageError::IoError(
            std::io::Error::other(format!(
                "RAW format not supported by image crate: {:?}",
                raw_path
            )),
        )))
    }
}

fn path_hash(path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    hex::encode(&hasher.finalize()[..8])
}

pub fn generate_thumbnail(source_path: &Path, output_dir: &Path, size: u32) -> AppResult<PathBuf> {
    std::fs::create_dir_all(output_dir)?;

    // RAW and HEIC/HEIF files are not decoded reliably by the image crate on
    // every platform. Convert them to a temporary JPEG first. The HEIC branch
    // used to be missing here, which made the original/lightbox work in WebKit
    // while every cached thumbnail failed to generate.
    let img = if is_raw_format(source_path) || needs_conversion(source_path) {
        let jpeg_path = raw_to_jpeg(source_path)?;
        let result = image::open(&jpeg_path).map_err(|e| AppError::Image(e));
        // Clean up temp JPEG
        let _ = std::fs::remove_file(&jpeg_path);
        result?
    } else {
        image::open(source_path).map_err(|e| AppError::Image(e))?
    };

    let thumb = img.thumbnail(size, size);
    let hash = path_hash(&source_path.to_string_lossy());
    let shard_dir = output_dir.join(&hash[..2]);
    std::fs::create_dir_all(&shard_dir)?;
    let out_path = shard_dir.join(format!("{}.webp", hash));
    // Never expose a partially encoded WebP to WKWebView. Concurrent callers
    // write complete unique files, then atomically publish one of them.
    let temp_path = shard_dir.join(format!(".{}-{}.webp", hash, uuid::Uuid::new_v4()));
    if let Err(error) = thumb.save_with_format(&temp_path, image::ImageFormat::WebP) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(AppError::Image(error));
    }
    if let Err(error) = std::fs::rename(&temp_path, &out_path) {
        if out_path.exists() {
            // Another complete concurrent generation won the race.
            let _ = std::fs::remove_file(&temp_path);
        } else {
            let _ = std::fs::remove_file(&temp_path);
            return Err(AppError::Io(error));
        }
    }
    Ok(out_path)
}

pub fn generate_small_thumbnail(source_path: &Path, output_dir: &Path) -> AppResult<PathBuf> {
    generate_thumbnail(source_path, output_dir, THUMBNAIL_SIZE_SMALL)
}

pub fn generate_large_thumbnail(source_path: &Path, output_dir: &Path) -> AppResult<PathBuf> {
    generate_thumbnail(source_path, output_dir, THUMBNAIL_SIZE_LARGE)
}

pub fn generate_medium_thumbnail(source_path: &Path, output_dir: &Path) -> AppResult<PathBuf> {
    generate_thumbnail(source_path, output_dir, THUMBNAIL_SIZE_MEDIUM)
}

const FACE_CONTEXT_SCALE: f64 = 1.8;
const FACE_CONTEXT_VERTICAL_OFFSET: f64 = 0.12;

fn expanded_face_crop(
    img_w: u32,
    img_h: u32,
    bbox_x: u32,
    bbox_y: u32,
    bbox_w: u32,
    bbox_h: u32,
) -> (u32, u32, u32, u32) {
    let face_w = bbox_w.max(1) as f64;
    let face_h = bbox_h.max(1) as f64;
    let side = (face_w.max(face_h) * FACE_CONTEXT_SCALE)
        .ceil()
        .min(img_w as f64)
        .min(img_h as f64)
        .max(1.0);
    let center_x = bbox_x as f64 + face_w / 2.0;
    // A small downward shift keeps the whole head while showing more shoulders.
    let center_y = bbox_y as f64 + face_h / 2.0 + face_h * FACE_CONTEXT_VERTICAL_OFFSET;
    let max_x = (img_w as f64 - side).max(0.0);
    let max_y = (img_h as f64 - side).max(0.0);
    let x = (center_x - side / 2.0).round().clamp(0.0, max_x) as u32;
    let y = (center_y - side / 2.0).round().clamp(0.0, max_y) as u32;
    let side = side as u32;
    (x, y, side, side)
}

/// Crop a face with surrounding head-and-shoulder context and resize it to a square thumbnail.
/// `bbox_x/y` = top-left corner, `bbox_w/h` = face dimensions in original pixel space.
pub fn generate_face_thumbnail(
    source_path: &Path,
    bbox_x: u32,
    bbox_y: u32,
    bbox_w: u32,
    bbox_h: u32,
    size: u32,
) -> AppResult<Vec<u8>> {
    let mut img = if is_raw_format(source_path) || needs_conversion(source_path) {
        let jpeg_path = raw_to_jpeg(source_path)?;
        let result = image::open(&jpeg_path).map_err(|e| AppError::Image(e));
        let _ = std::fs::remove_file(&jpeg_path);
        result?
    } else {
        image::open(source_path).map_err(|e| AppError::Image(e))?
    };

    let (img_w, img_h) = (img.width(), img.height());
    let (x, y, w, h) = expanded_face_crop(img_w, img_h, bbox_x, bbox_y, bbox_w, bbox_h);
    let crop = img.crop(x, y, w, h);
    let thumb = crop.thumbnail(size, size);
    // Encode as JPEG
    let mut buf = Vec::new();
    thumb
        .write_to(
            &mut std::io::Cursor::new(&mut buf),
            image::ImageFormat::Jpeg,
        )
        .map_err(|e| AppError::Image(e))?;
    Ok(buf)
}

pub fn thumbnail_path_for(photo_path: &str, output_dir: &Path) -> PathBuf {
    let hash = path_hash(photo_path);
    // Sharded directory: use first 2 chars of hash as subdirectory
    output_dir.join(&hash[..2]).join(format!("{}.webp", hash))
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use image::DynamicImage;
    use std::fs;

    #[test]
    fn face_crop_adds_head_and_shoulder_context() {
        let crop = expanded_face_crop(400, 300, 150, 100, 100, 80);
        assert_eq!(crop, (110, 60, 180, 180));
    }

    #[test]
    fn face_crop_shifts_inside_image_at_edges() {
        let crop = expanded_face_crop(400, 300, 0, 0, 100, 100);
        assert_eq!(crop, (0, 0, 180, 180));

        let crop = expanded_face_crop(400, 300, 350, 250, 100, 100);
        assert_eq!(crop, (220, 120, 180, 180));
    }

    #[test]
    fn test_face_thumbnail_with_real_photo() {
        let photo_path = "/Users/jackerkun/Media/2026-01-30——公司年会/Out/Small/DSC07725.jpg";
        if !std::path::Path::new(photo_path).exists() {
            println!("Test photo not found, skipping");
            return;
        }
        println!("Opening photo: {}", photo_path);
        let img = image::open(photo_path).expect("Failed to open image");
        let (img_w, img_h) = (img.width(), img.height());
        println!("Image dimensions: {}x{}", img_w, img_h);

        // Simulate a face bbox from the logs
        let bbox_x: u32 = 1432;
        let bbox_y: u32 = 554;
        let bbox_w: u32 = 176;
        let bbox_h: u32 = 212;

        let result = generate_face_thumbnail(
            std::path::Path::new(photo_path),
            bbox_x,
            bbox_y,
            bbox_w,
            bbox_h,
            160,
        );
        match result {
            Ok(bytes) => println!("Face thumbnail generated: {} bytes", bytes.len()),
            Err(e) => panic!("Face thumbnail failed: {}", e),
        }
    }

    #[test]
    fn test_path_hash_consistent() {
        let h1 = path_hash("/path/to/photo.jpg");
        assert_eq!(h1, path_hash("/path/to/photo.jpg"));
        assert_ne!(h1, path_hash("/path/to/other.jpg"));
    }

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

    #[test]
    fn test_generate_small_thumbnail() {
        let dir = std::env::temp_dir().join("pf_thumb_test");
        let _ = fs::remove_dir_all(&dir);
        let src = dir.join("src.png");
        let out_dir = dir.join("thumbs");
        fs::create_dir_all(&out_dir).unwrap();
        let img = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            500,
            500,
            image::Rgb([255, 0, 0]),
        ));
        img.save_with_format(&src, image::ImageFormat::Png).unwrap();
        let result = generate_small_thumbnail(&src, &out_dir).unwrap();
        assert!(result.exists());
        let thumb = image::open(&result).unwrap();
        assert!(thumb.width() <= THUMBNAIL_SIZE_SMALL);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_thumbnail_generation_publishes_only_complete_files() {
        let dir = std::env::temp_dir().join(format!("pf_thumb_race_{}", uuid::Uuid::new_v4()));
        let src = dir.join("src.png");
        let out_dir = dir.join("thumbs");
        fs::create_dir_all(&out_dir).unwrap();
        DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            1200,
            900,
            image::Rgb([12, 140, 220]),
        ))
        .save_with_format(&src, image::ImageFormat::Png)
        .unwrap();

        let workers: Vec<_> = (0..8)
            .map(|_| {
                let src = src.clone();
                let out_dir = out_dir.clone();
                std::thread::spawn(move || generate_small_thumbnail(&src, &out_dir).unwrap())
            })
            .collect();
        let paths: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();

        assert!(paths.iter().all(|path| path == &paths[0]));
        let decoded = image::open(&paths[0]).expect("published thumbnail must be fully decodable");
        assert!(decoded.width() <= THUMBNAIL_SIZE_SMALL);
        let shard = paths[0].parent().unwrap();
        assert!(fs::read_dir(shard).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with('.')));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_thumbnail_path_finds_new_sharded() {
        let dir = std::env::temp_dir().join("pf_find_thumb");
        let _ = fs::remove_dir_all(&dir);
        let src = dir.join("photo.png");
        fs::create_dir_all(&dir).unwrap();
        let img = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            500,
            500,
            image::Rgb([255, 0, 0]),
        ));
        img.save_with_format(&src, image::ImageFormat::Png).unwrap();

        let thumb = generate_small_thumbnail(&src, &dir).unwrap();
        let found = find_thumbnail_path(&src.to_string_lossy(), &dir).unwrap();
        assert_eq!(found, thumb);
        assert_eq!(found.extension().unwrap(), "webp");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_thumbnail_path_falls_back_to_legacy() {
        let dir = std::env::temp_dir().join("pf_find_thumb_legacy");
        let _ = fs::remove_dir_all(&dir);
        let src = dir.join("photo.png");
        fs::create_dir_all(&dir).unwrap();
        let img = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            500,
            500,
            image::Rgb([255, 0, 0]),
        ));
        img.save_with_format(&src, image::ImageFormat::Png).unwrap();

        // Create a legacy flat thumbnail manually
        let hash = path_hash(&src.to_string_lossy());
        let legacy_path = dir.join(format!("{}.webp", hash));

        // Generate the thumbnail (writes to sharded path)
        let sharded = generate_small_thumbnail(&src, &dir).unwrap();
        // Move it to legacy flat path
        fs::rename(&sharded, &legacy_path).unwrap();

        // find_thumbnail_path should find the legacy path
        let found = find_thumbnail_path(&src.to_string_lossy(), &dir).unwrap();
        assert_eq!(found, legacy_path);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_thumbnail_path_returns_none_when_missing() {
        let dir = std::env::temp_dir().join("pf_find_thumb_missing");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let result = find_thumbnail_path("/nonexistent/photo.jpg", &dir);
        assert!(result.is_none());

        let _ = fs::remove_dir_all(&dir);
    }
}
