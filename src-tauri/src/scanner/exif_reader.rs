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
    pub exposure_time: Option<String>,
    pub f_number: Option<String>,
    pub iso: Option<u32>,
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
        Err(_) => {
            return Ok(ExifData {
                orientation: 1,
                ..Default::default()
            })
        }
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

    // ExposureTime
    if let Some(field) = exif.get_field(exif::Tag::ExposureTime, exif::In::PRIMARY) {
        data.exposure_time = match &field.value {
            exif::Value::Rational(r) if !r.is_empty() => {
                let num = r[0].num;
                let den = r[0].denom;
                if den == 0 {
                    None
                } else if num >= den {
                    Some(format!("{}", num / den))
                } else if num == 1 {
                    Some(format!("1/{}", den))
                } else {
                    Some(format!("{}/{}", num, den))
                }
            }
            _ => None,
        };
    }

    // FNumber
    if let Some(field) = exif.get_field(exif::Tag::FNumber, exif::In::PRIMARY) {
        data.f_number = match &field.value {
            exif::Value::Rational(r) if !r.is_empty() => {
                let val = r[0].num as f64 / r[0].denom as f64;
                Some(format!("{val:.1}"))
            }
            _ => None,
        };
    }

    // ISOSpeedRatings
    if let Some(field) = exif.get_field(exif::Tag::ISOSpeed, exif::In::PRIMARY) {
        data.iso = field.value.get_uint(0);
    }

    // GPS
    if let (Some(lat), Some(lon)) = (
        exif.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY),
        exif.get_field(exif::Tag::GPSLongitude, exif::In::PRIMARY),
    ) {
        let lat_ref = exif.get_field(exif::Tag::GPSLatitudeRef, exif::In::PRIMARY);
        let lon_ref = exif.get_field(exif::Tag::GPSLongitudeRef, exif::In::PRIMARY);
        data.latitude = parse_gps_rational(&lat, lat_ref);
        data.longitude = parse_gps_rational(&lon, lon_ref);
    }

    // Orientation
    if let Some(field) = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY) {
        data.orientation = field.value.get_uint(0).map(|v| v as i32).unwrap_or(1);
    }

    Ok(data)
}

fn parse_gps_rational(field: &exif::Field, ref_field: Option<&exif::Field>) -> Option<f64> {
    let vals: Vec<f64> = match &field.value {
        exif::Value::Rational(r) => r
            .iter()
            .map(|rat| rat.num as f64 / rat.denom as f64)
            .collect(),
        _ => return None,
    };
    if vals.len() < 3 {
        return None;
    }
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
