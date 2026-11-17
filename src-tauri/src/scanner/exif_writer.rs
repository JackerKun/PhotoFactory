use std::{
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::{Mutex, OnceLock},
};

static EXIF_FILE_WRITE: Mutex<()> = Mutex::new(());
static BUNDLED_EXIFTOOL: OnceLock<PathBuf> = OnceLock::new();

pub fn set_exiftool_resource_dir(resource_dir: &Path) {
    let path = resource_dir.join("exiftool").join(if cfg!(windows) {
        "exiftool.exe"
    } else {
        "exiftool"
    });
    if path.is_file() {
        let _ = BUNDLED_EXIFTOOL.set(path);
    }
}

fn exiftool_command() -> Command {
    if let Some(path) = BUNDLED_EXIFTOOL.get() {
        #[cfg(target_os = "macos")]
        {
            let mut command = crate::process::background_command("/usr/bin/perl");
            command.arg(path);
            return command;
        }
        #[cfg(not(target_os = "macos"))]
        return crate::process::background_command(path);
    }
    crate::process::background_command("exiftool")
}

fn run_exiftool(path: &Path, fields: &[String]) -> std::io::Result<Output> {
    let mut command = exiftool_command();
    command.args(["-overwrite_original", "-P"]);
    #[cfg(windows)]
    {
        use std::io::{Error, ErrorKind, Write};
        use std::process::Stdio;

        // ExifTool's Windows launcher converts command-line arguments through a
        // code page. UTF-8 stdin preserves Unicode paths and metadata values.
        let path = path
            .to_str()
            .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "EXIF 路径无法转换为 UTF-8"))?;
        let mut child = command
            .args(["-charset", "filename=UTF8", "-@", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let written = {
            let mut stdin = child.stdin.take().expect("piped ExifTool stdin");
            (|| {
                for field in fields {
                    writeln!(stdin, "{field}")?;
                }
                writeln!(stdin, "{path}")
            })()
        };
        let output = child.wait_with_output()?;
        if output.status.success() {
            written?;
        }
        Ok(output)
    }
    #[cfg(not(windows))]
    command.args(fields).arg(path).output()
}

pub fn write_capture_exif(path: &Path, fields: &[String]) -> Result<(), String> {
    let _write = EXIF_FILE_WRITE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let output = run_exiftool(path, fields).map_err(|e| format!("无法运行 ExifTool：{e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let error = String::from_utf8_lossy(&output.stderr);
        Err(format!("ExifTool 写入失败：{}", error.trim()))
    }
}

/// Write GPS coordinates to a photo file's EXIF using ExifTool.
pub fn write_gps_exif(
    file_path: &str,
    latitude: Option<f64>,
    longitude: Option<f64>,
) -> Result<(), String> {
    let path = Path::new(file_path);
    if !path.exists() {
        return Err(format!("File not found: {file_path}"));
    }

    let fields = if let (Some(lat), Some(lng)) = (latitude, longitude) {
        let lat_ref = if lat >= 0.0 { "N" } else { "S" };
        let lng_ref = if lng >= 0.0 { "E" } else { "W" };
        vec![
            format!("-GPSLatitude={:.8}", lat.abs()),
            format!("-GPSLatitudeRef={lat_ref}"),
            format!("-GPSLongitude={:.8}", lng.abs()),
            format!("-GPSLongitudeRef={lng_ref}"),
        ]
    } else {
        [
            "-GPSLatitude=",
            "-GPSLongitude=",
            "-GPSLatitudeRef=",
            "-GPSLongitudeRef=",
        ]
        .map(str::to_owned)
        .to_vec()
    };
    write_capture_exif(path, &fields)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Minimal valid JPEG (1x1 pixel) that exiftool can modify.
    fn minimal_jpeg(path: &Path) {
        let bytes: &[u8] = &[
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
            0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06,
            0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D,
            0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12, 0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D,
            0x1A, 0x1C, 0x1C, 0x20, 0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C, 0x23, 0x1C, 0x1C, 0x28,
            0x37, 0x29, 0x2C, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32,
            0x3C, 0x2E, 0x33, 0x34, 0x32, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01,
            0x01, 0x01, 0x11, 0x00, 0xFF, 0xC4, 0x00, 0x1F, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
            0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02,
            0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0xFF, 0xC4, 0x00, 0xB5, 0x10,
            0x00, 0x02, 0x01, 0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00,
            0x01, 0x7D, 0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
            0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xA1, 0x08, 0x23, 0x42,
            0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0A, 0x16,
            0x17, 0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x34, 0x35, 0x36, 0x37,
            0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x53, 0x54, 0x55,
            0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x73,
            0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
            0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5,
            0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA,
            0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6,
            0xD7, 0xD8, 0xD9, 0xDA, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA,
            0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA, 0xFF, 0xDA, 0x00, 0x08,
            0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0xFB, 0xD5, 0xDB, 0x20, 0xBC, 0xAF, 0xFF, 0xD9,
        ];
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn writes_capture_exif_to_unicode_path() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("胶片扫描.jpg");
        minimal_jpeg(&path);
        write_capture_exif(
            &path.canonicalize().unwrap(),
            &[
                "-ExifIFD:LensModel=Nikkor 50mm".into(),
                "-ExifIFD:FocalLength=50".into(),
            ],
        )
        .unwrap();
        let result = crate::scanner::exif_reader::read_exif(&path).unwrap();
        assert_eq!(result.lens_model.as_deref(), Some("Nikkor 50mm"));
        assert_eq!(result.focal_length, Some(50.0));
    }

    #[test]
    fn test_write_gps_nonexistent_file() {
        let result = write_gps_exif("/nonexistent/file.jpg", Some(39.9), Some(116.4));
        assert!(result.is_err());
    }

    #[test]
    fn test_write_gps_positive_coords() {
        let dir = std::env::temp_dir().join("pf_gps_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.jpg");
        minimal_jpeg(&path);

        let result = write_gps_exif(path.to_str().unwrap(), Some(39.9042), Some(116.4074));
        assert!(result.is_ok());

        let verify = crate::process::background_command("exiftool")
            .args([
                "-c",
                "%.6f",
                "-GPSLatitude",
                "-GPSLongitude",
                "-s",
                path.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        let output = String::from_utf8_lossy(&verify.stdout);
        assert!(output.contains("39.9042"));
        assert!(output.contains("116.4074"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_clear_gps() {
        let dir = std::env::temp_dir().join("pf_gps_clear");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test2.jpg");
        minimal_jpeg(&path);
        // First add GPS data
        crate::process::background_command("exiftool")
            .args([
                "-GPSLatitude=39.9",
                "-GPSLongitude=116.4",
                path.to_str().unwrap(),
            ])
            .output()
            .unwrap();

        let result = write_gps_exif(path.to_str().unwrap(), None, None);
        assert!(result.is_ok());

        let verify = crate::process::background_command("exiftool")
            .args(["-GPSLatitude", "-s", path.to_str().unwrap()])
            .output()
            .unwrap();
        let output = String::from_utf8_lossy(&verify.stdout);
        assert!(output.is_empty() || !output.contains("39.9"));

        let _ = fs::remove_dir_all(&dir);
    }
}
