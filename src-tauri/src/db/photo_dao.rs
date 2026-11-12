// src-tauri/src/db/photo_dao.rs
use chrono::Utc;
use rusqlite::params;
use rusqlite::OptionalExtension;
use std::path::Path;

use crate::error::AppResult;
use crate::models::{
    Photo, PhotoCursor, PhotoFilter, PhotoFilterFacet, PhotoFilterOptions, PhotoPage,
    PhotoTimelineBucket,
};
use crate::scanner::exif_reader::ExifData;
use crate::scanner::file_scanner::FileInfo;

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
        exposure_time: row.get(11)?,
        f_number: row.get(12)?,
        iso: row.get(13)?,
        latitude: row.get(14)?,
        longitude: row.get(15)?,
        orientation: row.get(16)?,
        thumbnail_status: row.get(17)?,
        ai_status: row.get(18)?,
        deleted: row.get::<_, i32>(19)? != 0,
        is_favorite: row.get::<_, i32>(20)? != 0,
        rating: row.get(21)?,
        imported_at: row.get(22)?,
    })
}

const PHOTO_COLS: &str = "id, path, filename, file_size, file_mtime, width, height, format, taken_at, camera_make, camera_model, exposure_time, f_number, iso, latitude, longitude, orientation, thumbnail_status, ai_status, deleted, is_favorite, rating, imported_at";

pub fn insert_photo(
    conn: &rusqlite::Connection,
    file_info: &FileInfo,
    exif: &ExifData,
) -> AppResult<i64> {
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO photos (path, filename, file_size, file_mtime, width, height, format, taken_at, camera_make, camera_model, exposure_time, f_number, iso, latitude, longitude, orientation, is_favorite, rating, imported_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 0, 0, ?17)",
        params![file_info.path, file_info.filename, file_info.file_size, file_info.file_mtime, exif.width, exif.height, Path::new(&file_info.path).extension().and_then(|ext| ext.to_str()).map(|ext| ext.to_lowercase()), exif.taken_at, exif.camera_make, exif.camera_model, exif.exposure_time, exif.f_number, exif.iso, exif.latitude, exif.longitude, exif.orientation, Utc::now().timestamp()],
    )?;
    if inserted == 0 {
        let mut stmt = conn.prepare("SELECT id FROM photos WHERE path = ?1")?;
        Ok(stmt.query_row([file_info.path.as_str()], |r| r.get(0))?)
    } else {
        Ok(conn.last_insert_rowid())
    }
}

/// Clear derived AI rows for a source file that actually changed. Unchanged
/// files never call this function, which is what makes rescans incremental.
pub fn reset_photo_analysis(conn: &rusqlite::Connection, photo_id: i64) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT embedding_path FROM face_detections WHERE photo_id = ?1 AND embedding_path IS NOT NULL"
    )?;
    let embedding_paths = stmt
        .query_map([photo_id], |row| row.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    drop(stmt);

    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM face_detections WHERE photo_id = ?1",
        [photo_id],
    )?;
    tx.execute(
        "DELETE FROM ai_classifications WHERE photo_id = ?1",
        [photo_id],
    )?;
    tx.execute(
        "UPDATE face_clusters SET face_count = (SELECT COUNT(*) FROM face_detections WHERE person_id = face_clusters.id)",
        [],
    )?;
    tx.execute(
        "DELETE FROM person_metadata WHERE person_id IN (
            SELECT id FROM face_clusters WHERE face_count = 0 AND TRIM(COALESCE(name, '')) = ''
        )",
        [],
    )?;
    tx.execute(
        "DELETE FROM face_clusters WHERE face_count = 0 AND TRIM(COALESCE(name, '')) = ''",
        [],
    )?;
    tx.commit()?;
    Ok(embedding_paths)
}

pub fn batch_insert_photos(
    conn: &rusqlite::Connection,
    entries: &[(FileInfo, ExifData)],
) -> AppResult<usize> {
    let tx = conn.unchecked_transaction()?;
    let mut count = 0;
    for (fi, exif) in entries {
        insert_photo(&tx, fi, exif)?;
        count += 1;
    }
    tx.commit()?;
    Ok(count)
}

fn push_keyword_clause(sql: &mut String, args: &mut Vec<Box<dyn rusqlite::ToSql>>, keyword: &str) {
    let value = format!("%{}%", keyword.trim().to_lowercase());
    if value == "%%" {
        return;
    }
    sql.push_str(
        " AND (LOWER(filename) LIKE ? OR LOWER(path) LIKE ? OR LOWER(COALESCE(format, '')) LIKE ? \
         OR LOWER(TRIM(COALESCE(camera_make, '') || ' ' || COALESCE(camera_model, ''))) LIKE ? \
         OR LOWER(COALESCE(exposure_time, '')) LIKE ? OR LOWER(COALESCE(f_number, '')) LIKE ? \
         OR CAST(COALESCE(iso, 0) AS TEXT) LIKE ? OR CAST(rating AS TEXT) LIKE ? \
         OR strftime('%Y-%m-%d %H:%M:%S', datetime(COALESCE(taken_at, file_mtime), 'unixepoch')) LIKE ? \
         OR EXISTS (SELECT 1 FROM photo_manual_tags pmt JOIN manual_tags mt ON mt.id = pmt.tag_id \
                    WHERE pmt.photo_id = photos.id AND LOWER(mt.name) LIKE ?) \
         OR EXISTS (SELECT 1 FROM ai_classifications ac WHERE ac.photo_id = photos.id AND LOWER(ac.label) LIKE ?) \
         OR EXISTS (SELECT 1 FROM custom_attributes ca WHERE ca.photo_id = photos.id \
                    AND (LOWER(ca.key) LIKE ? OR LOWER(ca.value) LIKE ?)) \
         OR EXISTS (SELECT 1 FROM face_detections fd LEFT JOIN person_metadata pm ON pm.person_id = fd.person_id \
                    LEFT JOIN face_clusters fc ON fc.id = fd.person_id WHERE fd.photo_id = photos.id \
                    AND (LOWER(COALESCE(pm.user_name, '')) LIKE ? OR LOWER(COALESCE(fc.name, '')) LIKE ?)))"
    );
    for _ in 0..15 {
        args.push(Box::new(value.clone()));
    }
}

fn append_photo_filters(
    sql: &mut String,
    args: &mut Vec<Box<dyn rusqlite::ToSql>>,
    filter: &PhotoFilter,
    include_time: bool,
) {
    if let Some(ref dir) = filter.directory {
        // Stored paths use the scanner's native separator. The UI or an
        // imported directory can use either form; match both, with a directory
        // boundary and literal SQL wildcard characters in folder names.
        sql.push_str(" AND (path LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')");
        let normalized = dir.replace('\\', "/");
        let normalized = normalized.trim_end_matches('/');
        for separator in ["/", "\\"] {
            let prefix = format!("{}{}", normalized.replace('/', separator), separator);
            let escaped = prefix
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            args.push(Box::new(format!("{}%", escaped)));
        }
    }
    if filter.has_gps == Some(true) {
        sql.push_str(" AND latitude IS NOT NULL");
    } else if filter.has_gps == Some(false) {
        sql.push_str(" AND latitude IS NULL");
    }
    if filter.has_favorite == Some(true) {
        sql.push_str(" AND is_favorite = 1");
    } else if filter.has_favorite == Some(false) {
        sql.push_str(" AND is_favorite = 0");
    }
    if include_time {
        if let Some(year) = filter.year {
            sql.push_str(
                " AND strftime('%Y', datetime(COALESCE(taken_at, file_mtime), 'unixepoch')) = ?",
            );
            args.push(Box::new(format!("{:04}", year)));
        }
        if let Some(month) = filter.month {
            sql.push_str(
                " AND strftime('%m', datetime(COALESCE(taken_at, file_mtime), 'unixepoch')) = ?",
            );
            args.push(Box::new(format!("{:02}", month)));
        }
    }
    if let Some(ref tag) = filter.tag {
        sql.push_str(" AND id IN (SELECT pt.photo_id FROM photo_manual_tags pt JOIN manual_tags t ON t.id = pt.tag_id WHERE t.name = ?)");
        args.push(Box::new(tag.clone()));
    }
    if let Some(person_id) = filter.person_id {
        sql.push_str(
            " AND id IN (SELECT DISTINCT photo_id FROM face_detections WHERE person_id = ?)",
        );
        args.push(Box::new(person_id));
    }

    if let Some(ref keyword) = filter.keyword {
        push_keyword_clause(sql, args, keyword);
    }
    if let Some(ref format) = filter.format {
        sql.push_str(" AND LOWER(COALESCE(format, '')) = ?");
        args.push(Box::new(format.to_lowercase()));
    }
    if let Some(ref camera) = filter.camera {
        sql.push_str(
            " AND LOWER(TRIM(COALESCE(camera_make, '') || ' ' || COALESCE(camera_model, ''))) = ?",
        );
        args.push(Box::new(camera.to_lowercase()));
    }
    if let Some(value) = filter.iso_min {
        sql.push_str(" AND iso >= ?");
        args.push(Box::new(value));
    }
    if let Some(value) = filter.iso_max {
        sql.push_str(" AND iso <= ?");
        args.push(Box::new(value));
    }
    if let Some(value) = filter.aperture_min {
        sql.push_str(" AND CAST(f_number AS REAL) >= ?");
        args.push(Box::new(value));
    }
    if let Some(value) = filter.aperture_max {
        sql.push_str(" AND CAST(f_number AS REAL) <= ?");
        args.push(Box::new(value));
    }
    if let Some(ref value) = filter.exposure_time {
        sql.push_str(" AND exposure_time = ?");
        args.push(Box::new(value.clone()));
    }
    if let Some(ref value) = filter.orientation_kind {
        let effective_width = "CASE WHEN orientation BETWEEN 5 AND 8 THEN height ELSE width END";
        let effective_height = "CASE WHEN orientation BETWEEN 5 AND 8 THEN width ELSE height END";
        match value.as_str() {
            "landscape" => {
                sql.push_str(&format!(" AND {} > {}", effective_width, effective_height))
            }
            "portrait" => sql.push_str(&format!(" AND {} < {}", effective_width, effective_height)),
            "square" => sql.push_str(&format!(" AND {} = {}", effective_width, effective_height)),
            _ => {}
        }
    }
    if let Some(value) = filter.rating_min {
        sql.push_str(" AND rating >= ?");
        args.push(Box::new(value.clamp(0, 5)));
    }
    if let Some(value) = filter.rating_max {
        sql.push_str(" AND rating <= ?");
        args.push(Box::new(value.clamp(0, 5)));
    }
}

fn sort_definition(filter: &PhotoFilter) -> (&'static str, bool, bool) {
    let expression = match filter.sort_by.as_deref() {
        Some("created_date") => "imported_at",
        Some("modified_date") => "file_mtime",
        Some("name") => "LOWER(filename)",
        _ => "COALESCE(taken_at, file_mtime)",
    };
    let ascending = filter.sort_direction.as_deref() == Some("asc");
    let textual = expression == "LOWER(filename)";
    (expression, ascending, textual)
}

pub fn get_photos_page(
    conn: &rusqlite::Connection,
    cursor: Option<&PhotoCursor>,
    limit: i64,
    filter: &PhotoFilter,
) -> AppResult<PhotoPage> {
    let mut sql = format!("SELECT {} FROM photos WHERE deleted = 0 AND id NOT IN (SELECT photo_id FROM photo_trash) AND id NOT IN (SELECT photo_id FROM photo_intelligence WHERE is_private = 1)", PHOTO_COLS);
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    append_photo_filters(&mut sql, &mut args, filter, true);

    // Count the complete filtered result before adding the page cursor. This is
    // returned with every page so the UI can show deterministic load progress.
    let count_sql = sql.replacen(&format!("SELECT {}", PHOTO_COLS), "SELECT COUNT(*)", 1);
    let total_count: i64 =
        conn.query_row(&count_sql, rusqlite::params_from_iter(args.iter()), |row| {
            row.get(0)
        })?;

    let (sort_expression, ascending, textual) = sort_definition(filter);
    let operator = if ascending { ">" } else { "<" };
    let direction = if ascending { "ASC" } else { "DESC" };
    if let Some(c) = cursor {
        sql.push_str(&format!(
            " AND ({} {} ? OR ({} = ? AND id {} ?))",
            sort_expression, operator, sort_expression, operator
        ));
        if textual {
            let value = c.sort_text.clone().unwrap_or_default().to_lowercase();
            args.push(Box::new(value.clone()));
            args.push(Box::new(value));
        } else {
            args.push(Box::new(c.sort_value));
            args.push(Box::new(c.sort_value));
        }
        args.push(Box::new(c.id));
    }
    sql.push_str(&format!(
        " ORDER BY {} {}, id {}",
        sort_expression, direction, direction
    ));
    sql.push_str(&format!(" LIMIT {}", limit + 1));

    let mut stmt = conn.prepare(&sql)?;
    let photos: Vec<Photo> = stmt
        .query_map(rusqlite::params_from_iter(args.iter()), row_to_photo)?
        .filter_map(|r| r.ok())
        .collect();

    let has_more = photos.len() > limit as usize;
    let photos = if has_more {
        photos.into_iter().take(limit as usize).collect()
    } else {
        photos
    };
    let next_cursor = if has_more {
        photos.last().map(|p| PhotoCursor {
            id: p.id.unwrap_or(0),
            sort_value: match filter.sort_by.as_deref() {
                Some("created_date") => p.imported_at,
                Some("modified_date") => p.file_mtime,
                Some("name") => 0,
                _ => p.taken_at.unwrap_or(p.file_mtime),
            },
            sort_text: (filter.sort_by.as_deref() == Some("name"))
                .then(|| p.filename.to_lowercase()),
        })
    } else {
        None
    };

    Ok(PhotoPage {
        photos,
        next_cursor,
        has_more,
        total_count,
    })
}

/// Return the available year/month points for the current non-time filters.
/// The active year/month are intentionally ignored so the timeline remains a
/// navigation surface instead of collapsing to the selected month.
pub fn get_photo_timeline(
    conn: &rusqlite::Connection,
    filter: &PhotoFilter,
) -> AppResult<Vec<PhotoTimelineBucket>> {
    let mut sql = String::from(
        "SELECT \
         CAST(strftime('%Y', datetime(COALESCE(taken_at, file_mtime), 'unixepoch')) AS INTEGER) AS year, \
         CAST(strftime('%m', datetime(COALESCE(taken_at, file_mtime), 'unixepoch')) AS INTEGER) AS month, \
         COUNT(*) \
         FROM photos WHERE deleted = 0 AND id NOT IN (SELECT photo_id FROM photo_trash) AND id NOT IN (SELECT photo_id FROM photo_intelligence WHERE is_private = 1) AND COALESCE(taken_at, file_mtime) > 0",
    );
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    append_photo_filters(&mut sql, &mut args, filter, false);

    sql.push_str(" GROUP BY year, month ORDER BY year DESC, month DESC");
    let mut stmt = conn.prepare(&sql)?;
    let buckets = stmt
        .query_map(rusqlite::params_from_iter(args.iter()), |row| {
            Ok(PhotoTimelineBucket {
                year: row.get(0)?,
                month: row.get(1)?,
                count: row.get(2)?,
            })
        })?
        .filter_map(|row| row.ok())
        .collect();
    Ok(buckets)
}

pub fn get_photo_filter_options(
    conn: &rusqlite::Connection,
    filter: &PhotoFilter,
) -> AppResult<PhotoFilterOptions> {
    let mut where_sql = String::from(" FROM photos WHERE deleted = 0 AND id NOT IN (SELECT photo_id FROM photo_trash) AND id NOT IN (SELECT photo_id FROM photo_intelligence WHERE is_private = 1)");
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    append_photo_filters(&mut where_sql, &mut args, filter, false);

    let load_facets = |expression: &str| -> AppResult<Vec<PhotoFilterFacet>> {
        let sql = format!(
            "SELECT {0} AS value, COUNT(*) {1} AND TRIM(COALESCE({0}, '')) != '' GROUP BY value ORDER BY COUNT(*) DESC, value ASC LIMIT 100",
            expression, where_sql
        );
        let mut stmt = conn.prepare(&sql)?;
        let facets = stmt
            .query_map(rusqlite::params_from_iter(args.iter()), |row| {
                Ok(PhotoFilterFacet {
                    value: row.get(0)?,
                    count: row.get(1)?,
                })
            })?
            .filter_map(|row| row.ok())
            .collect();
        Ok(facets)
    };

    let formats = load_facets("LOWER(format)")?;
    let cameras =
        load_facets("TRIM(COALESCE(camera_make, '') || ' ' || COALESCE(camera_model, ''))")?;
    let exposure_times = load_facets("exposure_time")?;
    let range_sql = format!(
        "SELECT MIN(iso), MAX(iso), MIN(CAST(f_number AS REAL)), MAX(CAST(f_number AS REAL)) {}",
        where_sql
    );
    let (iso_min, iso_max, aperture_min, aperture_max) =
        conn.query_row(&range_sql, rusqlite::params_from_iter(args.iter()), |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?;
    Ok(PhotoFilterOptions {
        formats,
        cameras,
        exposure_times,
        iso_min,
        iso_max,
        aperture_min,
        aperture_max,
    })
}

pub fn update_photos_rating(
    conn: &mut rusqlite::Connection,
    photo_ids: &[i64],
    rating: i32,
) -> AppResult<usize> {
    if !(0..=5).contains(&rating) {
        return Err(crate::error::AppError::Project(
            "Rating must be between 0 and 5".to_string(),
        ));
    }
    let tx = conn.transaction()?;
    let count = {
        let mut stmt = tx.prepare("UPDATE photos SET rating = ?1 WHERE id = ?2 AND deleted = 0")?;
        let mut count = 0;
        for id in photo_ids {
            count += stmt.execute(params![rating, id])?;
        }
        count
    };
    tx.commit()?;
    Ok(count)
}

pub fn get_photo_by_id(conn: &rusqlite::Connection, id: i64) -> AppResult<Option<Photo>> {
    let mut stmt = conn.prepare(&format!("SELECT {} FROM photos WHERE id = ?", PHOTO_COLS))?;
    Ok(stmt.query_row([id], row_to_photo).optional()?)
}

/// Return the photos that live directly beside `photo_path` (not in nested
/// folders).  The lightbox uses this as its navigation context so opening a
/// map result never inherits a stale, partially-loaded grid page.
pub fn get_photos_in_same_directory(
    conn: &rusqlite::Connection,
    photo_path: &str,
) -> AppResult<Vec<Photo>> {
    let directory = Path::new(photo_path).parent().ok_or_else(|| {
        crate::error::AppError::NotFound(format!("Parent folder not found for {}", photo_path))
    })?;
    let prefix = format!(
        "{}{}%",
        directory.to_string_lossy(),
        std::path::MAIN_SEPARATOR
    );
    let sql = format!(
        "SELECT {} FROM photos WHERE deleted = 0 AND id NOT IN (SELECT photo_id FROM photo_trash) AND id NOT IN (SELECT photo_id FROM photo_intelligence WHERE is_private = 1) AND path LIKE ? \
         ORDER BY COALESCE(taken_at, file_mtime) DESC, id DESC",
        PHOTO_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let candidates: Vec<Photo> = stmt
        .query_map([prefix], row_to_photo)?
        .filter_map(|row| row.ok())
        .collect();

    Ok(candidates
        .into_iter()
        .filter(|photo| Path::new(&photo.path).parent() == Some(directory))
        .collect())
}

pub fn get_pending_thumbnails(conn: &rusqlite::Connection, limit: i64) -> AppResult<Vec<Photo>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM photos WHERE thumbnail_status=0 AND deleted=0
         AND NOT EXISTS (SELECT 1 FROM photo_task_ignores i WHERE i.photo_id=photos.id AND i.stage='thumbnail')
         LIMIT ?",
        PHOTO_COLS
    ))?;
    let photos: Vec<Photo> = stmt
        .query_map([limit], row_to_photo)?
        .filter_map(|r| r.ok())
        .collect();
    Ok(photos)
}

pub fn count_pending_thumbnails(conn: &rusqlite::Connection) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM photos WHERE thumbnail_status=0 AND deleted=0
         AND NOT EXISTS (SELECT 1 FROM photo_task_ignores i WHERE i.photo_id=photos.id AND i.stage='thumbnail')",
        [],
        |row| row.get(0),
    )?)
}

pub fn get_pending_ai_photos(conn: &rusqlite::Connection, limit: i64) -> AppResult<Vec<Photo>> {
    let mut stmt = conn.prepare(&format!("SELECT {} FROM photos WHERE (face_status = 0 OR classification_status = 0) AND deleted = 0 LIMIT ?", PHOTO_COLS))?;
    let photos: Vec<Photo> = stmt
        .query_map([limit], row_to_photo)?
        .filter_map(|r| r.ok())
        .collect();
    Ok(photos)
}

pub fn get_pending_face_photos(conn: &rusqlite::Connection, limit: i64) -> AppResult<Vec<Photo>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM photos WHERE face_status = 0 AND deleted = 0 LIMIT ?",
        PHOTO_COLS
    ))?;
    let photos: Vec<Photo> = stmt
        .query_map([limit], row_to_photo)?
        .filter_map(|r| r.ok())
        .collect();
    Ok(photos)
}

pub fn get_pending_classification_photos(
    conn: &rusqlite::Connection,
    limit: i64,
) -> AppResult<Vec<Photo>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM photos WHERE classification_status = 0 AND deleted = 0 LIMIT ?",
        PHOTO_COLS
    ))?;
    let photos: Vec<Photo> = stmt
        .query_map([limit], row_to_photo)?
        .filter_map(|r| r.ok())
        .collect();
    Ok(photos)
}

pub fn get_pending_ai_count(conn: &rusqlite::Connection) -> AppResult<i64> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM photos WHERE deleted=0 AND (
            (face_status=0 AND NOT EXISTS (SELECT 1 FROM photo_task_ignores i WHERE i.photo_id=photos.id AND i.stage='face_detection'))
            OR (classification_status=0 AND NOT EXISTS (SELECT 1 FROM photo_task_ignores i WHERE i.photo_id=photos.id AND i.stage='classification'))
         )",
        [],
        |row| row.get(0),
    )?;
    Ok(count)
}

pub fn update_thumbnail_status(
    conn: &rusqlite::Connection,
    photo_id: i64,
    status: i32,
) -> AppResult<()> {
    conn.execute(
        "UPDATE photos SET thumbnail_status = ? WHERE id = ?",
        params![status, photo_id],
    )?;
    Ok(())
}

/// Get photo IDs, paths, and file sizes for thumbnail rebuild.
pub fn get_thumbnail_rebuild_candidates(
    conn: &rusqlite::Connection,
) -> AppResult<Vec<(i64, String, i64, bool)>> {
    let mut stmt = conn.prepare(
        "SELECT id,path,file_size,COALESCE(thumbnail_status=-1,0) FROM photos WHERE deleted=0
         AND NOT EXISTS (SELECT 1 FROM photo_task_ignores i WHERE i.photo_id=photos.id AND i.stage='thumbnail')",
    )?;
    let rows: Vec<_> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

pub fn update_ai_status(conn: &rusqlite::Connection, photo_id: i64, status: i32) -> AppResult<()> {
    conn.execute(
        "UPDATE photos SET ai_status = ?, face_status = ?, classification_status = ? WHERE id = ?",
        params![status, status, status, photo_id],
    )?;
    Ok(())
}

pub fn update_face_status(
    conn: &rusqlite::Connection,
    photo_id: i64,
    status: i32,
) -> AppResult<()> {
    conn.execute(
        "UPDATE photos SET face_status = ? WHERE id = ?",
        params![status, photo_id],
    )?;
    Ok(())
}

pub fn update_classification_status(
    conn: &rusqlite::Connection,
    photo_id: i64,
    status: i32,
) -> AppResult<()> {
    conn.execute(
        "UPDATE photos SET classification_status = ? WHERE id = ?",
        params![status, photo_id],
    )?;
    Ok(())
}

pub fn get_photo_count(conn: &rusqlite::Connection) -> AppResult<i64> {
    Ok(
        conn.query_row("SELECT COUNT(*) FROM photos WHERE deleted = 0", [], |r| {
            r.get(0)
        })?,
    )
}

pub fn mark_deleted_photos(
    conn: &rusqlite::Connection,
    known_paths: &[String],
) -> AppResult<usize> {
    if known_paths.is_empty() {
        return Ok(conn.execute(
            "UPDATE photos SET deleted = 1 WHERE deleted = 0 AND storage_source_id IS NULL",
            [],
        )?);
    }
    let placeholders = known_paths
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "UPDATE photos SET deleted = 1 WHERE path NOT IN ({}) AND deleted = 0 AND storage_source_id IS NULL",
        placeholders
    );
    let params: Vec<&dyn rusqlite::ToSql> = known_paths
        .iter()
        .map(|p| p as &dyn rusqlite::ToSql)
        .collect();
    Ok(conn.execute(&sql, rusqlite::params_from_iter(params.iter()))?)
}

/// Fetch photos within a geographic bounding box, using the GPS partial index.
pub fn get_photos_in_bbox(
    conn: &rusqlite::Connection,
    min_lat: f64,
    max_lat: f64,
    min_lng: f64,
    max_lng: f64,
    limit: i64,
) -> AppResult<Vec<Photo>> {
    let sql = format!(
        "SELECT {} FROM photos WHERE deleted = 0 AND latitude IS NOT NULL AND longitude IS NOT NULL \
         AND latitude BETWEEN ?1 AND ?2 AND longitude BETWEEN ?3 AND ?4 \
         ORDER BY COALESCE(taken_at, file_mtime) DESC, id DESC LIMIT ?5",
        PHOTO_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let photos: Vec<Photo> = stmt
        .query_map(
            params![min_lat, max_lat, min_lng, max_lng, limit],
            row_to_photo,
        )?
        .filter_map(|r| r.ok())
        .collect();
    Ok(photos)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::CREATE_TABLES;
    use chrono::TimeZone;
    use rusqlite::Connection;
    use std::path::PathBuf;

    fn insert_test_photo(conn: &Connection, id: i64, path: &Path, timestamp: i64, deleted: bool) {
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, deleted, imported_at) \
             VALUES (?1, ?2, ?3, 100, ?4, ?4, ?5, ?4)",
            params![
                id,
                path.to_string_lossy(),
                path.file_name().unwrap().to_string_lossy(),
                timestamp,
                deleted as i32,
            ],
        )
        .unwrap();
    }

    #[test]
    fn inserting_duplicate_path_returns_the_existing_id() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CREATE_TABLES).unwrap();
        let file = FileInfo {
            path: "/library/相片.jpg".to_string(),
            filename: "相片.jpg".to_string(),
            file_size: 10,
            file_mtime: 20,
        };
        let exif = ExifData::default();
        let first = insert_photo(&conn, &file, &exif).unwrap();
        conn.execute(
            "INSERT INTO sync_log (event_type, path, timestamp) VALUES ('test', 'x', 1)",
            [],
        )
        .unwrap();
        let second = insert_photo(&conn, &file, &exif).unwrap();
        assert_eq!(first, second);
        assert_eq!(get_photo_count(&conn).unwrap(), 1);
    }

    #[test]
    fn empty_scan_marks_all_active_photos_deleted() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CREATE_TABLES).unwrap();
        insert_test_photo(&conn, 1, Path::new("/library/a.jpg"), 1, false);
        insert_test_photo(&conn, 2, Path::new("/library/b.jpg"), 1, false);
        assert_eq!(mark_deleted_photos(&conn, &[]).unwrap(), 2);
        assert_eq!(get_photo_count(&conn).unwrap(), 0);
    }

    #[test]
    fn primary_scan_does_not_delete_attached_source_photos() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CREATE_TABLES).unwrap();
        conn.execute(
            "INSERT INTO storage_sources(id,path,label,kind,status) VALUES(1,'/attached','Attached','local','online')",
            [],
        )
        .unwrap();
        insert_test_photo(&conn, 1, Path::new("/library/a.jpg"), 1, false);
        insert_test_photo(&conn, 2, Path::new("/attached/b.jpg"), 1, false);
        conn.execute("UPDATE photos SET storage_source_id=1 WHERE id=2", [])
            .unwrap();

        assert_eq!(mark_deleted_photos(&conn, &[]).unwrap(), 1);
        let attached_deleted: i64 = conn
            .query_row("SELECT deleted FROM photos WHERE id=2", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(attached_deleted, 0);
    }

    #[test]
    fn lightbox_context_contains_only_direct_siblings() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CREATE_TABLES).unwrap();
        let root = PathBuf::from(std::path::MAIN_SEPARATOR.to_string()).join("library");
        let trip = root.join("trip");
        let first = trip.join("first.jpg");
        let second = trip.join("second.jpg");
        insert_test_photo(&conn, 1, &first, 10, false);
        insert_test_photo(&conn, 2, &second, 20, false);
        insert_test_photo(&conn, 3, &trip.join("nested").join("third.jpg"), 30, false);
        insert_test_photo(&conn, 4, &root.join("other.jpg"), 40, false);
        insert_test_photo(&conn, 5, &trip.join("deleted.jpg"), 50, true);

        let result = get_photos_in_same_directory(&conn, first.to_str().unwrap()).unwrap();
        let ids: Vec<i64> = result.into_iter().filter_map(|photo| photo.id).collect();
        assert_eq!(ids, vec![2, 1]);
    }

    #[test]
    fn photo_pagination_follows_sort_order_without_skipping_ids() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CREATE_TABLES).unwrap();
        let root = PathBuf::from(std::path::MAIN_SEPARATOR.to_string()).join("library");

        // Deliberately make insertion ids disagree with capture-time ordering.
        insert_test_photo(&conn, 1, &root.join("newest.jpg"), 100, false);
        insert_test_photo(&conn, 2, &root.join("newer.jpg"), 95, false);
        insert_test_photo(&conn, 100, &root.join("older-high-id.jpg"), 90, false);
        insert_test_photo(&conn, 3, &root.join("oldest.jpg"), 85, false);

        let first = get_photos_page(&conn, None, 2, &PhotoFilter::default()).unwrap();
        assert_eq!(first.total_count, 4);
        assert!(first.has_more);
        assert_eq!(
            first
                .photos
                .iter()
                .filter_map(|photo| photo.id)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );

        let second = get_photos_page(
            &conn,
            first.next_cursor.as_ref(),
            2,
            &PhotoFilter::default(),
        )
        .unwrap();
        assert_eq!(second.total_count, 4);
        assert!(!second.has_more);
        assert_eq!(
            second
                .photos
                .iter()
                .filter_map(|photo| photo.id)
                .collect::<Vec<_>>(),
            vec![100, 3]
        );
    }

    #[test]
    fn photo_timeline_groups_months_and_respects_directory_filter() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CREATE_TABLES).unwrap();
        let root = PathBuf::from(std::path::MAIN_SEPARATOR.to_string()).join("library");
        let trip = root.join("trip");
        let other = root.join("other");
        let august = Utc
            .with_ymd_and_hms(2026, 8, 2, 10, 0, 0)
            .unwrap()
            .timestamp();
        let december = Utc
            .with_ymd_and_hms(2025, 12, 20, 10, 0, 0)
            .unwrap()
            .timestamp();

        insert_test_photo(&conn, 1, &trip.join("one.jpg"), august, false);
        insert_test_photo(&conn, 2, &trip.join("two.jpg"), august + 86_400, false);
        insert_test_photo(&conn, 3, &other.join("three.jpg"), december, false);

        let all = get_photo_timeline(&conn, &PhotoFilter::default()).unwrap();
        assert_eq!(
            all,
            vec![
                PhotoTimelineBucket {
                    year: 2026,
                    month: 8,
                    count: 2
                },
                PhotoTimelineBucket {
                    year: 2025,
                    month: 12,
                    count: 1
                },
            ]
        );

        let trip_only = get_photo_timeline(
            &conn,
            &PhotoFilter {
                directory: Some(trip.to_string_lossy().to_string()),
                ..PhotoFilter::default()
            },
        )
        .unwrap();
        assert_eq!(
            trip_only,
            vec![PhotoTimelineBucket {
                year: 2026,
                month: 8,
                count: 2
            }]
        );
    }

    #[test]
    fn directory_filters_handle_windows_paths_and_literal_wildcards() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CREATE_TABLES).unwrap();
        let timestamp = Utc
            .with_ymd_and_hms(2026, 8, 2, 10, 0, 0)
            .unwrap()
            .timestamp();
        for (index, path) in [
            r"C:\photos\trip_100%\one.jpg",
            "C:/photos/trip_100%/nested/two.jpg",
            r"C:\photos\tripX100other\wrong.jpg",
            r"C:\photos\trip_100%extra\wrong.jpg",
        ]
        .iter()
        .enumerate()
        {
            insert_test_photo(&conn, index as i64 + 1, Path::new(path), timestamp, false);
        }
        for directory in [
            r"C:\photos\trip_100%",
            "C:/photos/trip_100%/",
            r"C:\photos\trip_100%\",
        ] {
            let filter = PhotoFilter {
                directory: Some(directory.to_string()),
                ..PhotoFilter::default()
            };
            let timeline = get_photo_timeline(&conn, &filter).unwrap();
            assert_eq!(
                timeline,
                vec![PhotoTimelineBucket {
                    year: 2026,
                    month: 8,
                    count: 2
                }]
            );
            let page = get_photos_page(&conn, None, 20, &filter).unwrap();
            assert_eq!(page.total_count, 2);
        }
    }

    #[test]
    fn exif_keyword_and_rating_filters_share_the_same_result_set() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CREATE_TABLES).unwrap();
        let root = PathBuf::from(std::path::MAIN_SEPARATOR.to_string()).join("library");
        insert_test_photo(&conn, 1, &root.join("birthday-heic.heic"), 100, false);
        insert_test_photo(&conn, 2, &root.join("landscape.jpg"), 90, false);
        conn.execute(
            "UPDATE photos SET format = 'heic', camera_make = 'Apple', camera_model = 'iPhone 14 Pro', iso = 320, f_number = '1.8', exposure_time = '1/40' WHERE id = 1",
            [],
        ).unwrap();
        update_photos_rating(&mut conn, &[1], 4).unwrap();

        let filter = PhotoFilter {
            keyword: Some("iphone".to_string()),
            format: Some("HEIC".to_string()),
            iso_min: Some(300),
            aperture_max: Some(2.0),
            rating_min: Some(4),
            ..PhotoFilter::default()
        };
        let page = get_photos_page(&conn, None, 20, &filter).unwrap();
        assert_eq!(page.total_count, 1);
        assert_eq!(page.photos[0].id, Some(1));
        assert_eq!(page.photos[0].rating, 4);

        let options = get_photo_filter_options(&conn, &PhotoFilter::default()).unwrap();
        assert_eq!(
            options.formats,
            vec![PhotoFilterFacet {
                value: "heic".into(),
                count: 1
            }]
        );
        assert_eq!(
            options.cameras,
            vec![PhotoFilterFacet {
                value: "Apple iPhone 14 Pro".into(),
                count: 1
            }]
        );
        assert_eq!(
            options.exposure_times,
            vec![PhotoFilterFacet {
                value: "1/40".into(),
                count: 1
            }]
        );
        assert_eq!(options.iso_min, Some(320));
        assert_eq!(options.iso_max, Some(320));
        assert_eq!(options.aperture_min, Some(1.8));
        assert_eq!(options.aperture_max, Some(1.8));
    }

    #[test]
    fn name_sort_paginates_in_both_directions() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CREATE_TABLES).unwrap();
        let root = PathBuf::from(std::path::MAIN_SEPARATOR.to_string()).join("library");
        insert_test_photo(&conn, 1, &root.join("charlie.jpg"), 100, false);
        insert_test_photo(&conn, 2, &root.join("alpha.jpg"), 90, false);
        insert_test_photo(&conn, 3, &root.join("bravo.jpg"), 80, false);
        let filter = PhotoFilter {
            sort_by: Some("name".into()),
            sort_direction: Some("asc".into()),
            ..PhotoFilter::default()
        };
        let first = get_photos_page(&conn, None, 2, &filter).unwrap();
        assert_eq!(
            first
                .photos
                .iter()
                .map(|photo| photo.filename.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha.jpg", "bravo.jpg"]
        );
        let second = get_photos_page(&conn, first.next_cursor.as_ref(), 2, &filter).unwrap();
        assert_eq!(
            second
                .photos
                .iter()
                .map(|photo| photo.filename.as_str())
                .collect::<Vec<_>>(),
            vec!["charlie.jpg"]
        );
    }
}
