use image::{imageops::FilterType, GenericImageView};
use rusqlite::Connection;

use crate::db::classification_dao::insert_classification_with_type;
use crate::error::{AppError, AppResult};
use crate::models::AiClassification;

/// Analyze a thumbnail image and return tone labels.
fn analyze_tone(thumbnail_path: &str) -> Option<Vec<String>> {
    let img = image::open(thumbnail_path).ok()?;
    let img = img.resize(64, 64, FilterType::Nearest);

    let mut hue_sum: f64 = 0.0;
    let mut value_sum: f64 = 0.0;
    let mut saturated_count: u64 = 0;

    for (_, _, pixel) in img.pixels() {
        let [r, g, b, _] = pixel.0;
        let (h, s, v) = rgb_to_hsv(r, g, b);

        if s > 0.1 {
            hue_sum += h;
            saturated_count += 1;
        }
        value_sum += v as f64;
    }

    let total_pixels = (img.width() * img.height()) as f64;
    let avg_value = value_sum / total_pixels;

    let mut labels = Vec::new();

    if saturated_count > 0 {
        let avg_hue = hue_sum / saturated_count as f64;
        if avg_hue <= 60.0 || avg_hue >= 330.0 {
            labels.push("暖调".to_string());
        } else if (180.0..=270.0).contains(&avg_hue) {
            labels.push("冷调".to_string());
        }
    }

    if avg_value > 180.0 {
        labels.push("明亮".to_string());
    } else if avg_value < 80.0 {
        labels.push("暗调".to_string());
    }

    if labels.is_empty() {
        None
    } else {
        Some(labels)
    }
}

/// Convert RGB (0-255) to HSV (H: 0-360, S: 0-1, V: 0-1).
fn rgb_to_hsv(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let r = r as f64 / 255.0;
    let g = g as f64 / 255.0;
    let b = b as f64 / 255.0;

    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;

    let h = if delta == 0.0 {
        0.0
    } else if max == r {
        60.0 * (((g - b) / delta) % 6.0)
    } else if max == g {
        60.0 * ((b - r) / delta + 2.0)
    } else {
        60.0 * ((r - g) / delta + 4.0)
    };

    let h = if h < 0.0 { h + 360.0 } else { h };
    let s = if max == 0.0 { 0.0 } else { delta / max };
    let v = max;

    (h, s, v)
}

/// Run tone analysis on photos.
pub fn run_tone_tagging(conn: &Connection, batch_size: usize) -> AppResult<usize> {
    let query = "
        SELECT p.id, p.path FROM photos p
        WHERE p.deleted = 0
          AND p.id NOT IN (
              SELECT photo_id FROM ai_classifications WHERE tag_type = 'rule_tone'
          )
        LIMIT ?
    ";

    let mut stmt = conn
        .prepare(query)
        .map_err(|e| AppError::Internal(format!("Failed to prepare query: {}", e)))?;

    let rows: Vec<(i64, String)> = stmt
        .query_map([batch_size as i64], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| AppError::Internal(format!("Failed to query photos: {}", e)))?
        .filter_map(|r| r.ok())
        .collect();

    let mut tagged = 0;
    for (photo_id, path) in rows {
        let thumb_path = find_thumbnail(&path);
        let labels = match thumb_path.and_then(|p| analyze_tone(&p)) {
            Some(labels) => labels,
            None => continue,
        };

        for label in labels {
            let classification = AiClassification {
                id: None,
                photo_id,
                category: "rule".into(),
                label,
                confidence: 1.0,
            };
            let _ = insert_classification_with_type(conn, &classification, "rule_tone");
        }
        tagged += 1;
    }

    Ok(tagged)
}

/// Find the small thumbnail for a given photo path.
/// Thumbnails are stored in .pf/small/ directory.
fn find_thumbnail(photo_path: &str) -> Option<String> {
    let filename = std::path::Path::new(photo_path).file_name()?.to_str()?;

    let photo_dir = std::path::Path::new(photo_path).parent()?;

    let mut current = photo_dir;
    loop {
        let pf = current.join(".pf/small");
        if pf.exists() {
            let thumb = pf.join(filename);
            if thumb.exists() {
                return thumb.to_str().map(String::from);
            }
            break;
        }
        current = current.parent()?;
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rgb_to_hsv() {
        let (h, s, v) = rgb_to_hsv(255, 0, 0);
        assert!((h - 0.0).abs() < 1.0);
        assert!((s - 1.0).abs() < 0.01);
        assert!((v - 1.0).abs() < 0.01);

        let (h, _, _) = rgb_to_hsv(0, 255, 0);
        assert!((h - 120.0).abs() < 1.0);

        let (h, _, _) = rgb_to_hsv(0, 0, 255);
        assert!((h - 240.0).abs() < 1.0);

        let (_, s, _) = rgb_to_hsv(128, 128, 128);
        assert!(s < 0.01);
    }
}
