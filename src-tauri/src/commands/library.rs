use crate::commands::project::{get_conn, AppState};
use crate::db::connection::init_db;
use crate::error::{AppError, AppResult};
use image::imageops::FilterType;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;
use tauri::State;

const MAX_PAGE_SIZE: i64 = 100;
fn page_bounds(offset: i64, limit: i64) -> (i64, i64) {
    (offset.max(0), limit.clamp(1, MAX_PAGE_SIZE))
}

#[derive(Debug, Serialize)]
pub struct Paged<T> {
    pub items: Vec<T>,
    pub total: i64,
    pub offset: i64,
    pub has_more: bool,
}

fn page<T>(items: Vec<T>, total: i64, offset: i64) -> Paged<T> {
    let has_more = offset + (items.len() as i64) < total;
    Paged {
        items,
        total,
        offset,
        has_more,
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\"', "&quot;")
        .replace('\'', "&apos;")
}

#[derive(Debug, Serialize)]
pub struct LibraryJob {
    pub id: i64,
    pub job_type: String,
    pub status: String,
    pub progress: i64,
    pub total: i64,
    pub message: String,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct LibraryPhoto {
    pub id: i64,
    pub path: String,
    pub filename: String,
    pub rating: i64,
    pub is_favorite: bool,
    pub taken_at: Option<i64>,
    pub ocr_text: String,
    pub quality_score: f64,
    pub duplicate_group: Option<String>,
    pub stack_key: Option<String>,
    pub best_in_group: bool,
    pub is_private: bool,
    pub is_sensitive: bool,
    pub trashed_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct DuplicateGroup {
    pub group_id: String,
    pub count: i64,
    pub best_photo_id: Option<i64>,
    pub photo_ids: Vec<i64>,
}

#[derive(Debug, Serialize)]
pub struct StoryEvent {
    pub id: i64,
    pub name: String,
    pub start_at: Option<i64>,
    pub end_at: Option<i64>,
    pub cover_photo_id: Option<i64>,
    pub photo_count: i64,
}

#[derive(Debug, Serialize)]
pub struct ModelPlugin {
    pub id: String,
    pub name: String,
    pub capability: String,
    pub version: String,
    pub enabled: bool,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct StorageSource {
    pub id: i64,
    pub path: String,
    pub label: String,
    pub kind: String,
    pub status: String,
    pub read_only: bool,
    pub last_seen: Option<i64>,
    pub photo_count: i64,
    pub is_primary: bool,
}

#[derive(Debug, Serialize)]
pub struct IgnoredFace {
    pub id: i64,
    pub photo_id: i64,
    pub ignored_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PhotoEdit {
    pub photo_id: i64,
    pub crop_json: String,
    pub rotation: f64,
    pub exposure: f64,
    pub contrast: f64,
    pub temperature: f64,
    pub updated_at: i64,
}

fn map_library_photo(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryPhoto> {
    Ok(LibraryPhoto {
        id: row.get(0)?,
        path: row.get(1)?,
        filename: row.get(2)?,
        rating: row.get(3)?,
        is_favorite: row.get::<_, i64>(4)? != 0,
        taken_at: row.get(5)?,
        ocr_text: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        quality_score: row.get::<_, Option<f64>>(7)?.unwrap_or(0.0),
        duplicate_group: row.get(8)?,
        stack_key: row.get(9)?,
        best_in_group: row.get::<_, Option<i64>>(10)?.unwrap_or(0) != 0,
        is_private: row.get::<_, Option<i64>>(11)?.unwrap_or(0) != 0,
        is_sensitive: row.get::<_, Option<i64>>(12)?.unwrap_or(0) != 0,
        trashed_at: row.get(13)?,
    })
}

const PHOTO_SELECT: &str = "SELECT p.id,p.path,p.filename,p.rating,p.is_favorite,p.taken_at,i.ocr_text,i.quality_score,i.duplicate_group,i.stack_key,i.best_in_group,i.is_private,i.is_sensitive,t.trashed_at FROM photos p LEFT JOIN photo_intelligence i ON i.photo_id=p.id LEFT JOIN photo_trash t ON t.photo_id=p.id";

#[tauri::command]
pub fn cmd_get_library_jobs(state: State<'_, AppState>) -> AppResult<Vec<LibraryJob>> {
    let conn = get_conn(state)?;
    let mut stmt = conn.prepare("SELECT id,job_type,status,progress,total,message,error,created_at,updated_at FROM library_jobs ORDER BY id DESC LIMIT 50")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(LibraryJob {
                id: r.get(0)?,
                job_type: r.get(1)?,
                status: r.get(2)?,
                progress: r.get(3)?,
                total: r.get(4)?,
                message: r.get(5)?,
                error: r.get(6)?,
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub fn cmd_control_library_job(
    job_id: i64,
    action: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let status = match action.as_str() {
        "pause" => "paused",
        "resume" => "running",
        "cancel" => "canceled",
        _ => return Err(AppError::Project("不支持的任务操作".into())),
    };
    get_conn(state)?.execute(
        "UPDATE library_jobs SET status=?1,updated_at=?2 WHERE id=?3",
        params![status, now(), job_id],
    )?;
    Ok(())
}

fn dhash_and_quality(path: &str) -> Option<(String, f64)> {
    let img = image::open(path).ok()?;
    let gray = img.resize_exact(9, 8, FilterType::Triangle).to_luma8();
    let mut hash = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            hash <<= 1;
            if gray.get_pixel(x, y)[0] > gray.get_pixel(x + 1, y)[0] {
                hash |= 1;
            }
        }
    }
    let sample = img.resize(320, 320, FilterType::Triangle).to_luma8();
    let mut energy = 0f64;
    let mut count = 0f64;
    for y in 1..sample.height() {
        for x in 1..sample.width() {
            let p = sample.get_pixel(x, y)[0] as f64;
            energy += (p - sample.get_pixel(x - 1, y)[0] as f64).abs()
                + (p - sample.get_pixel(x, y - 1)[0] as f64).abs();
            count += 2.0;
        }
    }
    let sharp = if count > 0.0 { energy / count } else { 0.0 };
    Some((format!("{hash:016x}"), sharp))
}

fn ocr_text(path: &str) -> String {
    let supported = ["jpg", "jpeg", "png", "bmp", "tif", "tiff", "webp"];
    let ext = Path::new(path)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !supported.contains(&ext.as_str()) {
        return String::new();
    }
    let run = |lang: &str| {
        Command::new("tesseract")
            .arg(path)
            .arg("stdout")
            .arg("-l")
            .arg(lang)
            .arg("--psm")
            .arg("11")
            .output()
    };
    let output = run("chi_sim+eng")
        .ok()
        .filter(|o| o.status.success())
        .or_else(|| run("eng").ok().filter(|o| o.status.success()));
    output
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .chars()
                .take(12000)
                .collect()
        })
        .unwrap_or_default()
}

fn stack_key(path: &str) -> String {
    let p = Path::new(path);
    let parent = p.parent().unwrap_or(Path::new(""));
    let stem = p
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase();
    parent.join(stem).to_string_lossy().to_string()
}

fn finish_groups(conn: &Connection) -> AppResult<()> {
    let mut stmt = conn.prepare(
        "SELECT photo_id,perceptual_hash FROM photo_intelligence WHERE perceptual_hash IS NOT NULL",
    )?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let parsed: Vec<(i64, u64)> = rows
        .into_iter()
        .filter_map(|(id, h)| u64::from_str_radix(&h, 16).ok().map(|v| (id, v)))
        .collect();
    let mut parent: Vec<usize> = (0..parsed.len()).collect();
    fn root(p: &mut [usize], mut x: usize) -> usize {
        while p[x] != x {
            p[x] = p[p[x]];
            x = p[x];
        }
        x
    }
    // Multi-index the 64-bit hash into six disjoint chunks. Two hashes within a
    // Hamming distance of five must share at least one whole chunk, so this keeps
    // exact matching while avoiding an O(n²) comparison across the whole library.
    let chunks = [(0, 11), (11, 11), (22, 11), (33, 11), (44, 10), (54, 10)];
    let mut buckets: HashMap<(u8, u16), Vec<usize>> = HashMap::new();
    for (idx, (_, hash)) in parsed.iter().enumerate() {
        for (chunk, &(shift, width)) in chunks.iter().enumerate() {
            let mask = (1u64 << width) - 1;
            buckets
                .entry((chunk as u8, ((hash >> shift) & mask) as u16))
                .or_default()
                .push(idx);
        }
    }
    let mut compared = HashSet::new();
    for candidates in buckets.values() {
        for a in 0..candidates.len() {
            for b in a + 1..candidates.len() {
                let pair = (
                    candidates[a].min(candidates[b]),
                    candidates[a].max(candidates[b]),
                );
                if !compared.insert(pair) {
                    continue;
                }
                if (parsed[pair.0].1 ^ parsed[pair.1].1).count_ones() <= 5 {
                    let ra = root(&mut parent, pair.0);
                    let rb = root(&mut parent, pair.1);
                    if ra != rb {
                        parent[rb] = ra;
                    }
                }
            }
        }
    }
    let mut groups: HashMap<usize, Vec<i64>> = HashMap::new();
    for (idx, (id, _)) in parsed.iter().enumerate() {
        let r = root(&mut parent, idx);
        groups.entry(r).or_default().push(*id);
    }
    conn.execute(
        "UPDATE photo_intelligence SET duplicate_group=NULL,best_in_group=0",
        [],
    )?;
    for ids in groups.values().filter(|v| v.len() > 1) {
        let gid = format!("相似-{}", ids[0]);
        for id in ids {
            conn.execute(
                "UPDATE photo_intelligence SET duplicate_group=?1 WHERE photo_id=?2",
                params![gid, id],
            )?;
        }
    }
    conn.execute_batch("UPDATE photo_intelligence SET best_in_group=1 WHERE duplicate_group IS NOT NULL AND quality_score=(SELECT MAX(x.quality_score) FROM photo_intelligence x WHERE x.duplicate_group=photo_intelligence.duplicate_group);")?;
    Ok(())
}

fn run_analysis(db: PathBuf, job_id: i64, with_ocr: bool) {
    let result = (|| -> AppResult<()> {
        let conn = init_db(&db)?;
        let photos: Vec<(i64, String, i64, i64)> = {
            let mut s=conn.prepare("SELECT id,path,rating,is_favorite FROM photos WHERE deleted=0 AND id NOT IN(SELECT photo_id FROM photo_trash)")?;
            let rows = s
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<Result<_, _>>()?;
            rows
        };
        conn.execute("UPDATE library_jobs SET status='running',total=?1,message='建立照片智能索引',updated_at=?2 WHERE id=?3",params![photos.len() as i64,now(),job_id])?;
        for (idx, (id, path, rating, favorite)) in photos.iter().enumerate() {
            loop {
                let status: String = conn.query_row(
                    "SELECT status FROM library_jobs WHERE id=?1",
                    [job_id],
                    |r| r.get(0),
                )?;
                if status == "paused" {
                    thread::sleep(Duration::from_millis(300));
                    continue;
                }
                if status == "canceled" {
                    return Ok(());
                }
                break;
            }
            let (hash, sharp) = dhash_and_quality(path).unwrap_or_default();
            let quality = sharp + *rating as f64 * 10.0 + if *favorite != 0 { 15.0 } else { 0.0 };
            let text = if with_ocr {
                ocr_text(path)
            } else {
                conn.query_row(
                    "SELECT ocr_text FROM photo_intelligence WHERE photo_id=?1",
                    [id],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or_default()
            };
            conn.execute("INSERT INTO photo_intelligence(photo_id,ocr_text,perceptual_hash,sharpness,quality_score,stack_key,analyzed_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(photo_id) DO UPDATE SET ocr_text=excluded.ocr_text,perceptual_hash=excluded.perceptual_hash,sharpness=excluded.sharpness,quality_score=excluded.quality_score,stack_key=excluded.stack_key,analyzed_at=excluded.analyzed_at",params![id,text,hash,sharp,quality,stack_key(path),now()])?;
            conn.execute(
                "UPDATE library_jobs SET progress=?1,message=?2,updated_at=?3 WHERE id=?4",
                params![
                    (idx + 1) as i64,
                    Path::new(path)
                        .file_name()
                        .and_then(|v| v.to_str())
                        .unwrap_or(path),
                    now(),
                    job_id
                ],
            )?;
        }
        finish_groups(&conn)?;
        conn.execute("UPDATE library_jobs SET status='completed',message='智能索引已完成',updated_at=?1 WHERE id=?2",params![now(),job_id])?;
        Ok(())
    })();
    if let Err(e) = result {
        if let Ok(conn) = init_db(&db) {
            let _ = conn.execute(
                "UPDATE library_jobs SET status='failed',error=?1,updated_at=?2 WHERE id=?3",
                params![e.to_string(), now(), job_id],
            );
        }
    }
}

#[tauri::command]
pub fn cmd_start_library_analysis(with_ocr: bool, state: State<'_, AppState>) -> AppResult<i64> {
    let project = state
        .project
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| AppError::Project("No project open".into()))?;
    let conn = init_db(&project.db_path())?;
    let ts = now();
    conn.execute("INSERT INTO library_jobs(job_type,status,message,created_at,updated_at) VALUES(?1,'queued','等待开始',?2,?2)",params![if with_ocr{"intelligence+ocr"}else{"intelligence"},ts])?;
    let id = conn.last_insert_rowid();
    let db = project.db_path();
    thread::spawn(move || run_analysis(db, id, with_ocr));
    Ok(id)
}

#[tauri::command]
pub fn cmd_smart_search(
    query: String,
    include_private: bool,
    offset: i64,
    limit: i64,
    state: State<'_, AppState>,
) -> AppResult<Paged<LibraryPhoto>> {
    let (offset, limit) = page_bounds(offset, limit);
    let conn = get_conn(state)?;
    let favorite = query.contains("收藏");
    let private = query.contains("隐私");
    let sensitive = query.contains("敏感");
    let mut term = query.trim().to_string();
    for noise in [
        "帮我找",
        "查找",
        "搜索",
        "找出",
        "照片",
        "图片",
        "相片",
        "包含",
        "里面",
        "中的",
        "的",
        "收藏",
        "隐私",
        "敏感",
    ] {
        term = term.replace(noise, "");
    }
    let q = format!("%{}%", term.trim());
    let filter = " WHERE p.deleted=0 AND t.photo_id IS NULL AND (?2=1 OR ?3=1 OR COALESCE(i.is_private,0)=0) AND (?4=0 OR p.is_favorite=1) AND (?3=0 OR COALESCE(i.is_private,0)=1) AND (?5=0 OR COALESCE(i.is_sensitive,0)=1) AND (?1='%%' OR p.filename LIKE ?1 OR p.path LIKE ?1 OR COALESCE(i.ocr_text,'') LIKE ?1 OR strftime('%Y-%m-%d',datetime(COALESCE(p.taken_at,p.file_mtime),'unixepoch')) LIKE ?1 OR EXISTS(SELECT 1 FROM ai_classifications c WHERE c.photo_id=p.id AND c.label LIKE ?1) OR EXISTS(SELECT 1 FROM photo_manual_tags pt JOIN manual_tags mt ON mt.id=pt.tag_id WHERE pt.photo_id=p.id AND mt.name LIKE ?1) OR EXISTS(SELECT 1 FROM face_detections f JOIN face_clusters fc ON fc.id=f.person_id WHERE f.photo_id=p.id AND fc.name LIKE ?1))";
    let joins = " FROM photos p LEFT JOIN photo_intelligence i ON i.photo_id=p.id LEFT JOIN photo_trash t ON t.photo_id=p.id";
    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*){joins}{filter}"),
        params![
            q,
            include_private as i64,
            private as i64,
            favorite as i64,
            sensitive as i64
        ],
        |r| r.get(0),
    )?;
    let sql = format!("{PHOTO_SELECT}{filter} ORDER BY p.rating DESC,p.taken_at DESC,p.id DESC LIMIT ?6 OFFSET ?7");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(
            params![
                q,
                include_private as i64,
                private as i64,
                favorite as i64,
                sensitive as i64,
                limit,
                offset
            ],
            map_library_photo,
        )?
        .collect::<Result<_, _>>()?;
    Ok(page(rows, total, offset))
}

fn load_group_page(
    conn: &Connection,
    column: &str,
    offset: i64,
    limit: i64,
) -> AppResult<Paged<DuplicateGroup>> {
    let (offset, limit) = page_bounds(offset, limit.min(30));
    let condition = format!("i.{column} IS NOT NULL AND p.deleted=0 AND t.photo_id IS NULL");
    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM (SELECT 1 FROM photo_intelligence i JOIN photos p ON p.id=i.photo_id LEFT JOIN photo_trash t ON t.photo_id=p.id WHERE {condition} GROUP BY i.{column} HAVING COUNT(*)>1)"),
        [], |r| r.get(0),
    )?;
    let sql = format!("SELECT i.{column},COUNT(*),MAX(CASE WHEN i.best_in_group=1 THEN i.photo_id END) FROM photo_intelligence i JOIN photos p ON p.id=i.photo_id LEFT JOIN photo_trash t ON t.photo_id=p.id WHERE {condition} GROUP BY i.{column} HAVING COUNT(*)>1 ORDER BY COUNT(*) DESC,i.{column} LIMIT ?1 OFFSET ?2");
    let summaries: Vec<(String, i64, Option<i64>)> = {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params![limit, offset], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .collect::<Result<_, _>>()?;
        rows
    };
    let mut items = Vec::with_capacity(summaries.len());
    for (group_id, count, best_photo_id) in summaries {
        let preview_sql = format!("SELECT i.photo_id FROM photo_intelligence i JOIN photos p ON p.id=i.photo_id LEFT JOIN photo_trash t ON t.photo_id=p.id WHERE i.{column}=?1 AND p.deleted=0 AND t.photo_id IS NULL ORDER BY i.best_in_group DESC,i.quality_score DESC,i.photo_id LIMIT 8");
        let mut stmt = conn.prepare(&preview_sql)?;
        let photo_ids = stmt
            .query_map([&group_id], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        items.push(DuplicateGroup {
            group_id,
            count,
            best_photo_id,
            photo_ids,
        });
    }
    Ok(page(items, total, offset))
}

#[tauri::command]
pub fn cmd_get_duplicate_groups(
    offset: i64,
    limit: i64,
    state: State<'_, AppState>,
) -> AppResult<Paged<DuplicateGroup>> {
    load_group_page(&get_conn(state)?, "duplicate_group", offset, limit)
}

#[tauri::command]
pub fn cmd_get_raw_jpeg_stacks(
    offset: i64,
    limit: i64,
    state: State<'_, AppState>,
) -> AppResult<Paged<DuplicateGroup>> {
    load_group_page(&get_conn(state)?, "stack_key", offset, limit)
}

#[tauri::command]
pub fn cmd_get_duplicate_group_photos(
    group_id: String,
    offset: i64,
    limit: i64,
    state: State<'_, AppState>,
) -> AppResult<Paged<LibraryPhoto>> {
    let (offset, limit) = page_bounds(offset, limit);
    let conn = get_conn(state)?;
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM photo_intelligence i JOIN photos p ON p.id=i.photo_id LEFT JOIN photo_trash t ON t.photo_id=p.id WHERE i.duplicate_group=?1 AND p.deleted=0 AND t.photo_id IS NULL",
        [&group_id],
        |r| r.get(0),
    )?;
    let sql=format!("{PHOTO_SELECT} WHERE i.duplicate_group=?1 AND p.deleted=0 AND t.photo_id IS NULL ORDER BY i.best_in_group DESC,i.quality_score DESC,p.id LIMIT ?2 OFFSET ?3");
    let mut stmt = conn.prepare(&sql)?;
    let items = stmt
        .query_map(params![group_id, limit, offset], map_library_photo)?
        .collect::<Result<_, _>>()?;
    Ok(page(items, total, offset))
}

#[tauri::command]
pub fn cmd_trash_duplicate_group(group_id: String, state: State<'_, AppState>) -> AppResult<usize> {
    let conn = get_conn(state)?;
    let ts = now();
    let changed=conn.execute("INSERT INTO photo_trash(photo_id,reason,trashed_at) SELECT photo_id,'相似照片清理',?1 FROM photo_intelligence WHERE duplicate_group=?2 AND best_in_group=0 ON CONFLICT(photo_id) DO UPDATE SET reason=excluded.reason,trashed_at=excluded.trashed_at",params![ts,group_id])?;
    Ok(changed)
}

#[tauri::command]
pub fn cmd_move_photos_to_trash(
    photo_ids: Vec<i64>,
    reason: String,
    state: State<'_, AppState>,
) -> AppResult<usize> {
    let conn = get_conn(state)?;
    let tx = conn.unchecked_transaction()?;
    for id in &photo_ids {
        tx.execute("INSERT INTO photo_trash(photo_id,reason,trashed_at) VALUES(?1,?2,?3) ON CONFLICT(photo_id) DO UPDATE SET reason=excluded.reason,trashed_at=excluded.trashed_at",params![id,reason,now()])?;
    }
    tx.commit()?;
    Ok(photo_ids.len())
}

#[tauri::command]
pub fn cmd_get_trashed_photos(
    offset: i64,
    limit: i64,
    state: State<'_, AppState>,
) -> AppResult<Paged<LibraryPhoto>> {
    let (offset, limit) = page_bounds(offset, limit);
    let conn = get_conn(state)?;
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM photo_trash", [], |r| r.get(0))?;
    let mut s = conn.prepare(&format!(
        "{PHOTO_SELECT} WHERE t.photo_id IS NOT NULL ORDER BY t.trashed_at DESC LIMIT ?1 OFFSET ?2"
    ))?;
    let rows = s
        .query_map(params![limit, offset], map_library_photo)?
        .collect::<Result<_, _>>()?;
    Ok(page(rows, total, offset))
}

#[tauri::command]
pub fn cmd_restore_trashed_photos(
    photo_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> AppResult<usize> {
    let conn = get_conn(state)?;
    let mut n = 0;
    for id in photo_ids {
        n += conn.execute("DELETE FROM photo_trash WHERE photo_id=?1", [id])?;
    }
    Ok(n)
}

#[tauri::command]
pub fn cmd_set_photo_privacy(
    photo_ids: Vec<i64>,
    is_private: bool,
    is_sensitive: bool,
    state: State<'_, AppState>,
) -> AppResult<usize> {
    let conn = get_conn(state)?;
    for id in &photo_ids {
        conn.execute("INSERT INTO photo_intelligence(photo_id,is_private,is_sensitive) VALUES(?1,?2,?3) ON CONFLICT(photo_id) DO UPDATE SET is_private=excluded.is_private,is_sensitive=excluded.is_sensitive",params![id,is_private as i64,is_sensitive as i64])?;
    }
    Ok(photo_ids.len())
}

#[tauri::command]
pub fn cmd_get_photo_edit(
    photo_id: i64,
    state: State<'_, AppState>,
) -> AppResult<Option<PhotoEdit>> {
    let conn = get_conn(state)?;
    Ok(conn.query_row("SELECT photo_id,crop_json,rotation,exposure,contrast,temperature,updated_at FROM photo_edits WHERE photo_id=?1",[photo_id],|r|Ok(PhotoEdit{photo_id:r.get(0)?,crop_json:r.get(1)?,rotation:r.get(2)?,exposure:r.get(3)?,contrast:r.get(4)?,temperature:r.get(5)?,updated_at:r.get(6)?})).optional()?)
}

#[tauri::command]
pub fn cmd_save_photo_edit(edit: PhotoEdit, state: State<'_, AppState>) -> AppResult<()> {
    get_conn(state)?.execute("INSERT INTO photo_edits(photo_id,crop_json,rotation,exposure,contrast,temperature,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(photo_id) DO UPDATE SET crop_json=excluded.crop_json,rotation=excluded.rotation,exposure=excluded.exposure,contrast=excluded.contrast,temperature=excluded.temperature,updated_at=excluded.updated_at",params![edit.photo_id,edit.crop_json,edit.rotation,edit.exposure,edit.contrast,edit.temperature,now()])?;
    Ok(())
}

#[tauri::command]
pub fn cmd_export_xmp_sidecars(
    photo_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> AppResult<usize> {
    let conn = get_conn(state)?;
    let mut n = 0;
    for id in photo_ids {
        let row:Option<(String,i64,i64,String,bool)>=conn.query_row("SELECT p.path,p.rating,p.is_favorite,COALESCE(GROUP_CONCAT(mt.name,','),''),COALESCE(s.read_only,0) FROM photos p LEFT JOIN photo_manual_tags pt ON pt.photo_id=p.id LEFT JOIN manual_tags mt ON mt.id=pt.tag_id LEFT JOIN storage_sources s ON s.id=p.storage_source_id WHERE p.id=?1 GROUP BY p.id",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get::<_,i64>(4)?!=0))).optional()?;
        if let Some((path, rating, fav, tags, read_only)) = row {
            if read_only {
                continue;
            }
            let tags = xml_escape(&tags);
            let xmp = format!(
                r#"<?xpacket begin=''?><x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'><rdf:Description xmlns:xmp='http://ns.adobe.com/xap/1.0/' xmlns:dc='http://purl.org/dc/elements/1.1/' xmp:Rating='{rating}' xmp:Label='{fav}'><dc:subject><rdf:Bag><rdf:li>{tags}</rdf:li></rdf:Bag></dc:subject></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end='w'?>"#
            );
            let side = PathBuf::from(format!("{path}.xmp"));
            std::fs::write(side, xmp)?;
            n += 1;
        }
    }
    Ok(n)
}

#[tauri::command]
pub fn cmd_generate_story_events(state: State<'_, AppState>) -> AppResult<usize> {
    let conn = get_conn(state)?;
    let rows: Vec<(i64, i64)> = {
        let mut s=conn.prepare("SELECT id,COALESCE(taken_at,file_mtime) FROM photos WHERE deleted=0 AND id NOT IN(SELECT photo_id FROM photo_trash) ORDER BY COALESCE(taken_at,file_mtime)")?;
        let rows = s
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        rows
    };
    conn.execute("DELETE FROM story_event_photos", [])?;
    conn.execute("DELETE FROM story_events", [])?;
    let mut groups: Vec<Vec<(i64, i64)>> = Vec::new();
    for row in rows {
        if groups
            .last()
            .and_then(|g| g.last())
            .map(|v| row.1 - v.1 > 172800)
            .unwrap_or(true)
        {
            groups.push(Vec::new());
        }
        groups.last_mut().unwrap().push(row);
    }
    for (idx, g) in groups.iter().filter(|g| !g.is_empty()).enumerate() {
        let start = g.first().unwrap().1;
        let end = g.last().unwrap().1;
        let name = chrono::DateTime::from_timestamp(start, 0)
            .map(|d| d.format("%Y年%m月%d日 故事").to_string())
            .unwrap_or_else(|| format!("故事 {}", idx + 1));
        conn.execute("INSERT INTO story_events(name,start_at,end_at,cover_photo_id,created_at) VALUES(?1,?2,?3,?4,?5)",params![name,start,end,g[0].0,now()])?;
        let eid = conn.last_insert_rowid();
        for (pos, (pid, _)) in g.iter().enumerate() {
            conn.execute(
                "INSERT INTO story_event_photos(event_id,photo_id,position) VALUES(?1,?2,?3)",
                params![eid, pid, pos as i64],
            )?;
        }
    }
    Ok(groups.len())
}

#[tauri::command]
pub fn cmd_get_story_events(
    offset: i64,
    limit: i64,
    state: State<'_, AppState>,
) -> AppResult<Paged<StoryEvent>> {
    let (offset, limit) = page_bounds(offset, limit.min(60));
    let conn = get_conn(state)?;
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM story_events", [], |r| r.get(0))?;
    let mut s=conn.prepare("SELECT e.id,e.name,e.start_at,e.end_at,e.cover_photo_id,COUNT(p.photo_id) FROM story_events e LEFT JOIN story_event_photos p ON p.event_id=e.id GROUP BY e.id ORDER BY e.start_at DESC LIMIT ?1 OFFSET ?2")?;
    let rows = s
        .query_map(params![limit, offset], |r| {
            Ok(StoryEvent {
                id: r.get(0)?,
                name: r.get(1)?,
                start_at: r.get(2)?,
                end_at: r.get(3)?,
                cover_photo_id: r.get(4)?,
                photo_count: r.get(5)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(page(rows, total, offset))
}

#[tauri::command]
pub fn cmd_get_story_photos(
    event_id: i64,
    offset: i64,
    limit: i64,
    state: State<'_, AppState>,
) -> AppResult<Paged<LibraryPhoto>> {
    let (offset, limit) = page_bounds(offset, limit);
    let conn = get_conn(state)?;
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM story_event_photos WHERE event_id=?1",
        [event_id],
        |r| r.get(0),
    )?;
    let sql=format!("{PHOTO_SELECT} JOIN story_event_photos ep ON ep.photo_id=p.id WHERE ep.event_id=?1 ORDER BY ep.position LIMIT ?2 OFFSET ?3");
    let mut stmt = conn.prepare(&sql)?;
    let items = stmt
        .query_map(params![event_id, limit, offset], map_library_photo)?
        .collect::<Result<_, _>>()?;
    Ok(page(items, total, offset))
}

#[tauri::command]
pub fn cmd_get_model_plugins(state: State<'_, AppState>) -> AppResult<Vec<ModelPlugin>> {
    let conn = get_conn(state)?;
    let mut s = conn.prepare(
        "SELECT id,name,capability,version,enabled,status FROM model_plugins ORDER BY capability",
    )?;
    let rows = s
        .query_map([], |r| {
            Ok(ModelPlugin {
                id: r.get(0)?,
                name: r.get(1)?,
                capability: r.get(2)?,
                version: r.get(3)?,
                enabled: r.get::<_, i64>(4)? != 0,
                status: r.get(5)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub fn cmd_set_model_plugin_enabled(
    plugin_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> AppResult<()> {
    get_conn(state)?.execute(
        "UPDATE model_plugins SET enabled=?1 WHERE id=?2",
        params![enabled as i64, plugin_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn cmd_get_storage_sources(state: State<'_, AppState>) -> AppResult<Vec<StorageSource>> {
    let project = state
        .project
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| AppError::Project("No project open".into()))?;
    let conn = init_db(&project.db_path())?;
    let kind = if project.root_path.starts_with("/Volumes/") {
        "removable"
    } else {
        "local"
    };
    conn.execute(
        "INSERT OR IGNORE INTO storage_sources(path,label,kind,last_seen) VALUES(?1,?2,?3,?4)",
        params![project.root_path, project.name, kind, now()],
    )?;
    let mut s = conn.prepare(
        "SELECT s.id,s.path,s.label,s.kind,s.status,s.read_only,s.last_seen,COUNT(p.id) FROM storage_sources s LEFT JOIN photos p ON p.storage_source_id=s.id AND p.deleted=0 GROUP BY s.id ORDER BY s.id",
    )?;
    let mut rows = s
        .query_map([], |r| {
            Ok(StorageSource {
                id: r.get(0)?,
                path: r.get(1)?,
                label: r.get(2)?,
                kind: r.get(3)?,
                status: r.get(4)?,
                read_only: r.get::<_, i64>(5)? != 0,
                last_seen: r.get(6)?,
                photo_count: r.get(7)?,
                is_primary: false,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for x in &mut rows {
        x.is_primary = x.path == project.root_path;
        if x.is_primary {
            x.photo_count = conn.query_row(
                "SELECT COUNT(*) FROM photos WHERE storage_source_id IS NULL AND deleted=0",
                [],
                |r| r.get(0),
            )?;
        }
        x.status = if Path::new(&x.path).exists() {
            "online".into()
        } else {
            "offline".into()
        };
    }
    Ok(rows)
}

#[tauri::command]
pub fn cmd_add_storage_source(
    path: String,
    label: String,
    read_only: bool,
    state: State<'_, AppState>,
) -> AppResult<i64> {
    let kind = if path.starts_with("/Volumes/") {
        "nas/removable"
    } else {
        "local"
    };
    let conn = get_conn(state)?;
    conn.execute("INSERT INTO storage_sources(path,label,kind,status,read_only,last_seen) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(path) DO UPDATE SET label=excluded.label,read_only=excluded.read_only,last_seen=excluded.last_seen",params![path,label,kind,if Path::new(&path).exists(){"online"}else{"offline"},read_only as i64,now()])?;
    let id = conn.query_row(
        "SELECT id FROM storage_sources WHERE path=?1",
        [path],
        |r| r.get(0),
    )?;
    Ok(id)
}

#[tauri::command]
pub fn cmd_scan_storage_source(
    source_id: i64,
    state: State<'_, AppState>,
) -> AppResult<crate::models::ScanResult> {
    use crate::scanner::{exif_reader, file_scanner};
    let project = state
        .project
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| AppError::Project("No project open".into()))?;
    let conn = init_db(&project.db_path())?;
    let path: String = conn.query_row(
        "SELECT path FROM storage_sources WHERE id=?1",
        [source_id],
        |r| r.get(0),
    )?;
    if path == project.root_path {
        return crate::commands::project::incremental_scan_with_conn(&project, &conn);
    }
    if !Path::new(&path).is_dir() {
        conn.execute(
            "UPDATE storage_sources SET status='offline' WHERE id=?1",
            [source_id],
        )?;
        return Err(AppError::NotFound(format!("存储源不可访问：{path}")));
    }
    let files =
        file_scanner::scan_directory_with_extensions(Path::new(&path), &project.enabled_extensions);
    let known: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
    let mut result = crate::models::ScanResult::default();
    for file in &files {
        let existing: Option<(i64, i64, i64, bool)> = conn
            .query_row(
                "SELECT id,file_size,file_mtime,deleted FROM photos WHERE path=?1",
                [&file.path],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? != 0)),
            )
            .optional()?;
        match existing {
            Some((id, size, mtime, deleted))
                if size == file.file_size && mtime == file.file_mtime =>
            {
                conn.execute(
                    "UPDATE photos SET storage_source_id=?1,deleted=0 WHERE id=?2",
                    params![source_id, id],
                )?;
                if deleted {
                    result.restored += 1
                } else {
                    result.unchanged += 1
                }
            }
            Some((id, _, _, _)) => {
                let exif = exif_reader::read_exif(Path::new(&file.path)).unwrap_or_default();
                conn.execute("UPDATE photos SET filename=?1,file_size=?2,file_mtime=?3,width=?4,height=?5,format=?6,taken_at=?7,camera_make=?8,camera_model=?9,exposure_time=?10,f_number=?11,iso=?12,latitude=?13,longitude=?14,orientation=?15,thumbnail_status=0,face_status=0,classification_status=0,deleted=0,storage_source_id=?16 WHERE id=?17",params![file.filename,file.file_size,file.file_mtime,exif.width,exif.height,Path::new(&file.path).extension().and_then(|v|v.to_str()).map(str::to_lowercase),exif.taken_at,exif.camera_make,exif.camera_model,exif.exposure_time,exif.f_number,exif.iso,exif.latitude,exif.longitude,exif.orientation,source_id,id])?;
                result.updated += 1
            }
            None => {
                let exif = exif_reader::read_exif(Path::new(&file.path)).unwrap_or_default();
                let id = crate::db::photo_dao::insert_photo(&conn, file, &exif)?;
                conn.execute(
                    "UPDATE photos SET storage_source_id=?1 WHERE id=?2",
                    params![source_id, id],
                )?;
                result.added += 1
            }
        }
    }
    if known.is_empty() {
        result.deleted = conn.execute(
            "UPDATE photos SET deleted=1 WHERE storage_source_id=?1 AND deleted=0",
            [source_id],
        )?;
    } else {
        let marks = known.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql=format!("UPDATE photos SET deleted=1 WHERE storage_source_id=? AND deleted=0 AND path NOT IN ({marks})");
        let mut values: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(known.len() + 1);
        values.push(&source_id);
        for p in &known {
            values.push(p);
        }
        result.deleted = conn.execute(&sql, rusqlite::params_from_iter(values))?;
    }
    conn.execute(
        "UPDATE storage_sources SET status='online',last_seen=?1 WHERE id=?2",
        params![now(), source_id],
    )?;
    Ok(result)
}

#[tauri::command]
pub fn cmd_remove_storage_source(source_id: i64, state: State<'_, AppState>) -> AppResult<usize> {
    let project = state
        .project
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| AppError::Project("No project open".into()))?;
    let conn = get_conn(state)?;
    let source_path: String = conn.query_row(
        "SELECT path FROM storage_sources WHERE id=?1",
        [source_id],
        |r| r.get(0),
    )?;
    if source_path == project.root_path {
        return Err(AppError::Project("主资料库不能作为附加存储源移除".into()));
    }
    let n = conn.execute(
        "UPDATE photos SET deleted=1,storage_source_id=NULL WHERE storage_source_id=?1",
        [source_id],
    )?;
    conn.execute("DELETE FROM storage_sources WHERE id=?1", [source_id])?;
    Ok(n)
}

#[tauri::command]
pub fn cmd_get_library_settings(state: State<'_, AppState>) -> AppResult<HashMap<String, String>> {
    let conn = get_conn(state)?;
    let mut s = conn.prepare("SELECT key,value FROM library_settings")?;
    let rows = s
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub fn cmd_set_library_setting(
    key: String,
    value: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    get_conn(state)?.execute("INSERT INTO library_settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value])?;
    Ok(())
}

#[tauri::command]
pub fn cmd_get_ignored_faces(
    offset: i64,
    limit: i64,
    state: State<'_, AppState>,
) -> AppResult<Paged<IgnoredFace>> {
    let (offset, limit) = page_bounds(offset, limit);
    let conn = get_conn(state)?;
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM face_detections WHERE review_status='ignored'",
        [],
        |r| r.get(0),
    )?;
    let mut s=conn.prepare("SELECT id,photo_id,created_at FROM face_detections WHERE review_status='ignored' ORDER BY created_at DESC,id DESC LIMIT ?1 OFFSET ?2")?;
    let rows = s
        .query_map(params![limit, offset], |r| {
            Ok(IgnoredFace {
                id: r.get(0)?,
                photo_id: r.get(1)?,
                ignored_at: r.get(2)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(page(rows, total, offset))
}

#[tauri::command]
pub fn cmd_restore_ignored_faces(
    face_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> AppResult<usize> {
    let conn = get_conn(state)?;
    let mut n = 0;
    for id in face_ids {
        n+=conn.execute("UPDATE face_detections SET review_status='active' WHERE id=?1 AND review_status='ignored'",[id])?;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::CREATE_TABLES;

    #[test]
    fn stack_groups_extensions() {
        assert_eq!(stack_key("/a/IMG_1.RAW"), stack_key("/a/IMG_1.JPG"));
    }

    #[test]
    fn page_bounds_reject_unbounded_requests() {
        assert_eq!(page_bounds(-20, 50_000), (0, MAX_PAGE_SIZE));
        assert_eq!(page_bounds(40, 0), (40, 1));
    }

    #[test]
    fn bucketed_similarity_keeps_exact_hamming_threshold() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CREATE_TABLES).unwrap();
        let close = (1u64 << 0) | (1u64 << 11) | (1u64 << 22) | (1u64 << 33) | (1u64 << 44);
        for (id, hash) in [(1, 0u64), (2, close), (3, u64::MAX)] {
            conn.execute(
                "INSERT INTO photos(id,path,filename,file_size,file_mtime,imported_at) VALUES(?1,?2,?3,1,1,1)",
                params![id, format!("/{id}.jpg"), format!("{id}.jpg")],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO photo_intelligence(photo_id,perceptual_hash) VALUES(?1,?2)",
                params![id, format!("{hash:016x}")],
            )
            .unwrap();
        }

        finish_groups(&conn).unwrap();
        let first: Option<String> = conn
            .query_row(
                "SELECT duplicate_group FROM photo_intelligence WHERE photo_id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let second: Option<String> = conn
            .query_row(
                "SELECT duplicate_group FROM photo_intelligence WHERE photo_id=2",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let far: Option<String> = conn
            .query_row(
                "SELECT duplicate_group FROM photo_intelligence WHERE photo_id=3",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(first.is_some());
        assert_eq!(first, second);
        assert!(far.is_none());
    }
}
