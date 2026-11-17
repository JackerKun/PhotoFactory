use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{Datelike, NaiveDateTime, Utc};
use rusqlite::{params, Connection, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::project::{current_project, AppState};
use crate::db::{connection::init_db, manual_tag_dao};
use crate::error::{AppError, AppResult};
use crate::scanner::exif_writer::write_capture_exif;

static EXIF_BATCH: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
pub struct ExifPatch {
    camera_make: Option<String>,
    camera_model: Option<String>,
    lens_make: Option<String>,
    lens_model: Option<String>,
    focal_length: Option<f64>,
    exposure_time: Option<String>,
    f_number: Option<String>,
    iso: Option<u32>,
    capture_time: Option<String>,
}

#[derive(Serialize, Default)]
pub struct ExifBatchResult {
    updated: usize,
    files_written: usize,
    files_failed: usize,
    file_errors: Vec<String>,
}

fn selected_ids(photo_ids: Vec<i64>) -> AppResult<BTreeSet<i64>> {
    if photo_ids.is_empty() || photo_ids.len() > 5000 || photo_ids.iter().any(|id| *id <= 0) {
        return Err(AppError::Project("请选择 1 到 5000 张照片。".into()));
    }
    Ok(photo_ids.into_iter().collect())
}

fn ensure_selected_photo(tx: &Transaction<'_>, id: i64) -> AppResult<()> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM photos WHERE id = ?1 AND deleted = 0
                       AND NOT EXISTS (SELECT 1 FROM photo_trash WHERE photo_id = ?1))",
        [id],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(AppError::NotFound(format!(
            "照片 {id} 已移除或移入回收站。"
        )));
    }
    Ok(())
}

impl ExifPatch {
    fn validate(&mut self) -> AppResult<Option<NaiveDateTime>> {
        for value in [
            &mut self.camera_make,
            &mut self.camera_model,
            &mut self.lens_make,
            &mut self.lens_model,
            &mut self.exposure_time,
            &mut self.f_number,
            &mut self.capture_time,
        ] {
            *value = value
                .take()
                .map(|text| text.trim().to_owned())
                .filter(|text| !text.is_empty());
        }
        for value in [
            &self.camera_make,
            &self.camera_model,
            &self.lens_make,
            &self.lens_model,
        ]
        .into_iter()
        .flatten()
        {
            if value.chars().count() > 120 || value.chars().any(char::is_control) {
                return Err(AppError::Project(
                    "相机和镜头的品牌、型号最多 120 个字符，且不能包含控制字符。".into(),
                ));
            }
        }
        let positive = |text: &str| {
            text.len() <= 32
                && text
                    .parse::<f64>()
                    .is_ok_and(|number| number.is_finite() && number > 0.0)
        };
        if self.exposure_time.as_deref().is_some_and(|text| {
            !text
                .split_once('/')
                .map_or_else(|| positive(text), |(n, d)| positive(n) && positive(d))
        }) {
            return Err(AppError::Project(
                "快门应为正数秒或分数，例如 0.5 或 1/125。".into(),
            ));
        }
        if self
            .f_number
            .as_deref()
            .is_some_and(|value| !positive(value))
        {
            return Err(AppError::Project("光圈应为正数，例如 2.8。".into()));
        }
        if self.iso.is_some_and(|iso| !(1..=65535).contains(&iso)) {
            return Err(AppError::Project("ISO 应为 1 到 65535 的整数。".into()));
        }
        if self
            .focal_length
            .is_some_and(|mm| !mm.is_finite() || mm <= 0.0 || mm > 100_000.0)
        {
            return Err(AppError::Project(
                "焦距应大于 0 且不超过 100000 毫米。".into(),
            ));
        }
        let date = self
            .capture_time
            .as_deref()
            .map(|value| {
                NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S")
                    .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M"))
                    .map_err(|_| AppError::Project("请输入有效的拍摄日期和时间。".into()))
            })
            .transpose()?;
        if date.is_some_and(|value| !(1..=9999).contains(&value.year())) {
            return Err(AppError::Project("拍摄年份应在 1 到 9999 之间。".into()));
        }
        if self.camera_make.is_none()
            && self.camera_model.is_none()
            && self.lens_make.is_none()
            && self.lens_model.is_none()
            && self.focal_length.is_none()
            && self.exposure_time.is_none()
            && self.f_number.is_none()
            && self.iso.is_none()
            && date.is_none()
        {
            return Err(AppError::Project("请至少填写一项 EXIF 信息。".into()));
        }
        Ok(date)
    }
}

fn save_exif(
    conn: &mut Connection,
    ids: &BTreeSet<i64>,
    patch: &ExifPatch,
    date: Option<NaiveDateTime>,
    write_originals: bool,
) -> AppResult<Vec<(String, bool)>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut files = Vec::new();
    {
        let mut overrides = tx.prepare(
            "INSERT INTO photo_exif_overrides (photo_id, camera_make, camera_model, exposure_time, f_number, iso, taken_at, lens_make, lens_model, focal_length)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(photo_id) DO UPDATE SET
                camera_make = COALESCE(excluded.camera_make, camera_make),
                camera_model = COALESCE(excluded.camera_model, camera_model),
                exposure_time = COALESCE(excluded.exposure_time, exposure_time),
                f_number = COALESCE(excluded.f_number, f_number),
                iso = COALESCE(excluded.iso, iso),
                taken_at = COALESCE(excluded.taken_at, taken_at),
                lens_make = COALESCE(excluded.lens_make, lens_make),
                lens_model = COALESCE(excluded.lens_model, lens_model),
                focal_length = COALESCE(excluded.focal_length, focal_length)",
        )?;
        let mut update = tx.prepare(
            "UPDATE photos SET camera_make = COALESCE(?2, camera_make), camera_model = COALESCE(?3, camera_model),
                exposure_time = COALESCE(?4, exposure_time), f_number = COALESCE(?5, f_number),
                iso = COALESCE(?6, iso), taken_at = COALESCE(?7, taken_at),
                lens_make = COALESCE(?8, lens_make), lens_model = COALESCE(?9, lens_model),
                focal_length = COALESCE(?10, focal_length) WHERE id = ?1",
        )?;
        let taken_at = date.map(|value| value.and_utc().timestamp());
        for id in ids {
            ensure_selected_photo(&tx, *id)?;
            let values = params![
                id,
                patch.camera_make,
                patch.camera_model,
                patch.exposure_time,
                patch.f_number,
                patch.iso,
                taken_at,
                patch.lens_make,
                patch.lens_model,
                patch.focal_length,
            ];
            overrides.execute(values)?;
            update.execute(values)?;
            if write_originals {
                files.push(tx.query_row(
                    "SELECT p.path, COALESCE(s.read_only, 0) FROM photos p
                     LEFT JOIN storage_sources s ON s.id = p.storage_source_id WHERE p.id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?);
            }
        }
    }
    tx.commit()?;
    Ok(files)
}

#[tauri::command]
pub async fn cmd_update_batch_exif(
    photo_ids: Vec<i64>,
    mut patch: ExifPatch,
    write_originals: bool,
    state: State<'_, AppState>,
) -> AppResult<ExifBatchResult> {
    let ids = selected_ids(photo_ids)?;
    let date = patch.validate()?;
    let project = current_project(&state)?;
    tokio::task::spawn_blocking(move || {
        let _batch = EXIF_BATCH.lock().unwrap_or_else(|error| error.into_inner());
        let mut conn = init_db(&project.db_path())?;
        let files = save_exif(&mut conn, &ids, &patch, date, write_originals)?;
        let mut result = ExifBatchResult {
            updated: ids.len(),
            ..Default::default()
        };
        if files.is_empty() {
            return Ok(result);
        }

        let root = PathBuf::from(project.root_path).canonicalize().ok();
        let mut fields = Vec::new();
        for (key, value) in [
            ("IFD0:Make", patch.camera_make),
            ("IFD0:Model", patch.camera_model),
            ("ExifIFD:LensMake", patch.lens_make),
            ("ExifIFD:LensModel", patch.lens_model),
            (
                "ExifIFD:FocalLength",
                patch.focal_length.map(|mm| mm.to_string()),
            ),
            ("ExifIFD:ExposureTime", patch.exposure_time),
            ("ExifIFD:FNumber", patch.f_number),
            ("ExifIFD:ISO", patch.iso.map(|iso| iso.to_string())),
            (
                "ExifIFD:DateTimeOriginal",
                date.map(|value| value.format("%Y:%m:%d %H:%M:%S").to_string()),
            ),
        ] {
            if let Some(value) = value {
                fields.push(format!("-{key}={value}"));
            }
        }
        for (path, read_only) in files {
            let file = Path::new(&path).canonicalize();
            let written = match file {
                Ok(file)
                    if !read_only && root.as_ref().is_some_and(|root| file.starts_with(root)) =>
                {
                    write_capture_exif(&file, &fields)
                }
                _ => Err("原文件不可访问、属于只读来源或位于照片库目录之外。".into()),
            };
            match written {
                Ok(()) => result.files_written += 1,
                Err(error) => {
                    result.files_failed += 1;
                    if result.file_errors.len() < 8 {
                        result.file_errors.push(format!("{path} · {error}"));
                    }
                }
            }
        }
        Ok(result)
    })
    .await
    .map_err(|error| AppError::Internal(format!("EXIF 批量保存中断：{error}")))?
}

#[tauri::command]
pub async fn cmd_update_batch_tags(
    photo_ids: Vec<i64>,
    tag_ids: Vec<i64>,
    new_name: Option<String>,
    remove: bool,
    state: State<'_, AppState>,
) -> AppResult<usize> {
    let ids = selected_ids(photo_ids)?;
    if tag_ids.len() > 100 || (remove && new_name.is_some()) {
        return Err(AppError::Project(
            "每次最多处理 100 个标签，移除时请选择现有标签。".into(),
        ));
    }
    let project = current_project(&state)?;
    tokio::task::spawn_blocking(move || {
        let mut conn = init_db(&project.db_path())?;
        update_tags(
            &mut conn,
            &ids,
            tag_ids.into_iter().collect(),
            new_name.as_deref(),
            remove,
        )
    })
    .await
    .map_err(|error| AppError::Internal(format!("批量标签处理失败：{error}")))?
}

fn update_tags(
    conn: &mut Connection,
    ids: &BTreeSet<i64>,
    mut tags: BTreeSet<i64>,
    new_name: Option<&str>,
    remove: bool,
) -> AppResult<usize> {
    manual_tag_dao::sync_generated_tags(conn)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = Utc::now().timestamp();
    if let Some(name) = new_name.map(str::trim).filter(|name| !name.is_empty()) {
        let existing = tx.query_row(
            "SELECT id FROM manual_tags WHERE name = ?1 COLLATE NOCASE",
            [name],
            |row| row.get(0),
        );
        let id = match existing {
            Ok(id) => id,
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                manual_tag_dao::create(&tx, name, "#5B8DEF")?
            }
            Err(error) => return Err(error.into()),
        };
        tags.insert(id);
    }
    if tags.is_empty() || tags.len() > 100 {
        return Err(AppError::Project("请选择或填写 1 到 100 个标签。".into()));
    }
    let mut affected = 0;
    {
        let mut exists = tx.prepare("SELECT EXISTS(SELECT 1 FROM manual_tags WHERE id = ?1)")?;
        for tag_id in &tags {
            if !exists.query_row([tag_id], |row| row.get::<_, bool>(0))? {
                return Err(AppError::NotFound("有标签已被删除，请重新选择。".into()));
            }
        }
        let mut change = tx.prepare(if remove {
            "DELETE FROM photo_manual_tags WHERE photo_id = ?1 AND tag_id = ?2"
        } else {
            "INSERT OR IGNORE INTO photo_manual_tags (photo_id, tag_id, created_at) VALUES (?1, ?2, ?3)"
        })?;
        for id in ids {
            ensure_selected_photo(&tx, *id)?;
            let mut changed = false;
            for tag_id in &tags {
                let rows = if remove {
                    change.execute(params![id, tag_id])?
                } else {
                    change.execute(params![id, tag_id, now])?
                };
                changed |= rows != 0;
            }
            affected += usize::from(changed);
        }
    }
    tx.commit()?;
    Ok(affected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{commands::project::incremental_scan_with_conn, models::Project};

    #[test]
    fn batch_exif_keeps_unspecified_fields_and_survives_rescanning() {
        let folder = tempfile::Builder::new()
            .prefix("photofactory-exif-")
            .tempdir()
            .unwrap();
        let project = Project::new("test".into(), folder.path().to_string_lossy().into());
        let mut conn = init_db(&project.db_path()).unwrap();
        let path = folder.path().join("胶片.jpg");
        std::fs::write(&path, b"scan").unwrap();
        assert_eq!(
            incremental_scan_with_conn(&project, &conn).unwrap().added,
            1
        );
        conn.execute("UPDATE photos SET iso = 200 WHERE id = 1", [])
            .unwrap();
        let mut patch: ExifPatch = serde_json::from_str(
            r#"{"camera_make":" Nikon ","camera_model":"FM2","lens_make":" Nikon ","lens_model":"AI-S Nikkor 50mm f/1.4","focal_length":50.5,"exposure_time":"1/125","capture_time":"1995-04-08T15:20"}"#,
        ).unwrap();
        let date = patch.validate().unwrap();
        assert!(save_exif(&mut conn, &BTreeSet::from([1, 2]), &patch, date, false).is_err());
        let photo = crate::db::photo_dao::get_photo_by_id(&conn, 1)
            .unwrap()
            .unwrap();
        assert!(photo.camera_make.is_none());
        save_exif(&mut conn, &BTreeSet::from([1]), &patch, date, false).unwrap();
        let photo = crate::db::photo_dao::get_photo_by_id(&conn, 1)
            .unwrap()
            .unwrap();
        assert_eq!(photo.iso, Some(200));

        std::fs::write(&path, b"rescanned image").unwrap();
        assert_eq!(
            incremental_scan_with_conn(&project, &conn).unwrap().updated,
            1
        );
        let photo = crate::db::photo_dao::get_photo_by_id(&conn, 1)
            .unwrap()
            .unwrap();
        assert_eq!(photo.camera_make.as_deref(), Some("Nikon"));
        assert_eq!(photo.camera_model.as_deref(), Some("FM2"));
        assert_eq!(photo.lens_make.as_deref(), Some("Nikon"));
        assert_eq!(photo.lens_model.as_deref(), Some("AI-S Nikkor 50mm f/1.4"));
        assert_eq!(photo.focal_length, Some(50.5));
        assert_eq!(photo.exposure_time.as_deref(), Some("1/125"));
        assert_eq!(
            photo.taken_at,
            date.map(|value| value.and_utc().timestamp())
        );
        assert_eq!(photo.iso, None);
    }

    #[test]
    fn batch_tags_are_additive_idempotent_and_remove_only_selected_assignments() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema::CREATE_TABLES)
            .unwrap();
        conn.execute_batch(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at)
            VALUES (1, '/a.jpg', 'a.jpg', 1, 1, 1), (2, '/b.jpg', 'b.jpg', 1, 1, 1);",
        )
        .unwrap();
        let keep = manual_tag_dao::create(&conn, "既有", "#123456").unwrap();
        manual_tag_dao::set_for_photo(&conn, 1, &[keep]).unwrap();
        let all = BTreeSet::from([1, 2]);
        assert_eq!(
            update_tags(&mut conn, &all, BTreeSet::new(), Some("胶片"), false).unwrap(),
            2
        );
        assert_eq!(
            update_tags(&mut conn, &all, BTreeSet::new(), Some("胶片"), false).unwrap(),
            0
        );
        let tags = manual_tag_dao::get_all(&conn).unwrap();
        let film = tags.iter().find(|tag| tag.name == "胶片").unwrap().id;
        assert!(update_tags(
            &mut conn,
            &BTreeSet::from([1, 3]),
            BTreeSet::from([film]),
            None,
            true
        )
        .is_err());
        assert_eq!(manual_tag_dao::get_for_photo(&conn, 1).unwrap().len(), 2);
        assert_eq!(
            update_tags(
                &mut conn,
                &BTreeSet::from([1]),
                BTreeSet::from([film]),
                None,
                true
            )
            .unwrap(),
            1
        );
        assert_eq!(manual_tag_dao::get_for_photo(&conn, 1).unwrap()[0].id, keep);
        assert_eq!(manual_tag_dao::get_for_photo(&conn, 2).unwrap()[0].id, film);
    }
}
