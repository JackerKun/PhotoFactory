// src-tauri/src/db/smart_album_dao.rs
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// A smart album record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmartAlbum {
    pub id: i64,
    pub name: String,
    pub album_type: String,
    pub rule_json: String,
    pub cover_photo_id: Option<i64>,
    pub photo_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersonCombination {
    person_ids: Vec<i64>,
    exact: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct GroupPhoto {
    pub photo_id: i64,
    pub people_count: i64,
    pub unconfirmed_count: i64,
}

// A confirmed identity is counted once (mirrors, collages, etc.). A real face
// with no reliable identity contributes to the visible count, but never to a
// saved person's membership. Ignored and suspected detections do not count.
const GROUP_QUERY: &str = "
WITH selected AS (SELECT CAST(value AS INTEGER) AS id FROM json_each(?1)),
face_counts AS (
  SELECT fd.photo_id,
         COUNT(DISTINCT CASE WHEN COALESCE(fd.review_status,'active')='active' THEN fd.person_id END) AS known,
         SUM(CASE WHEN fd.person_id IS NULL OR fd.review_status='identity_review' THEN 1 ELSE 0 END) AS unconfirmed,
         COUNT(DISTINCT CASE WHEN COALESCE(fd.review_status,'active')='active' AND fd.person_id IN (SELECT id FROM selected)
                             THEN fd.person_id END) AS matched
  FROM face_detections fd JOIN photos p ON p.id=fd.photo_id
  WHERE p.deleted=0 AND COALESCE(fd.review_status,'active') IN ('active','identity_review')
  GROUP BY fd.photo_id
), matches AS (
  SELECT photo_id, known+unconfirmed AS total, unconfirmed
  FROM face_counts WHERE known+unconfirmed >= 2
    AND (?2=0 OR (?2<4 AND known+unconfirmed=?2) OR (?2=4 AND known+unconfirmed>=4))
    AND matched=(SELECT COUNT(*) FROM selected)
    AND (NOT ?3 OR known+unconfirmed=matched)
)";

pub fn get_group_photos(
    conn: &rusqlite::Connection,
    people: &[i64],
    size: i64,
    exact: bool,
    cursor: Option<i64>,
    limit: i64,
) -> AppResult<Vec<GroupPhoto>> {
    let people = serde_json::json!(people).to_string();
    let mut stmt = conn.prepare(&format!(
        "{GROUP_QUERY}
        SELECT photo_id,total,unconfirmed FROM matches
        WHERE (?4 IS NULL OR photo_id < ?4) ORDER BY photo_id DESC LIMIT ?5"
    ))?;
    let rows = stmt.query_map(
        params![people, size, exact, cursor, limit.clamp(1, 200)],
        |row| {
            Ok(GroupPhoto {
                photo_id: row.get(0)?,
                people_count: row.get(1)?,
                unconfirmed_count: row.get(2)?,
            })
        },
    )?;
    rows.collect::<Result<_, _>>().map_err(Into::into)
}

pub fn create_person_combination(
    conn: &rusqlite::Connection,
    name: &str,
    mut person_ids: Vec<i64>,
    exact: bool,
) -> AppResult<i64> {
    let name = name.trim();
    person_ids.sort_unstable();
    person_ids.dedup();
    if name.is_empty() || !(2..=20).contains(&person_ids.len()) {
        return Err(AppError::Project(
            "请输入相册名称，并选择 2–20 位已命名人物".into(),
        ));
    }
    for id in &person_ids {
        let named: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM face_clusters fc LEFT JOIN person_metadata pm ON pm.person_id=fc.id
             WHERE fc.id=?1 AND TRIM(COALESCE(NULLIF(fc.name,''),pm.user_name,''))<>'')",
            [id], |row| row.get(0),
        )?;
        if !named {
            return Err(AppError::Project("人物已变化，请刷新后重新选择".into()));
        }
    }
    let rule = serde_json::json!({ "person_ids": person_ids, "exact": exact }).to_string();
    conn.execute(
        "INSERT INTO smart_albums(name,album_type,rule_json) VALUES (?1,'person_combination',?2)",
        params![name, rule],
    )?;
    Ok(conn.last_insert_rowid())
}

fn combination_rule(json: &str) -> AppResult<PersonCombination> {
    serde_json::from_str(json)
        .map_err(|error| AppError::Project(format!("人物组合相册规则无法读取：{error}")))
}

pub fn replace_combination_person(
    conn: &rusqlite::Connection,
    source: i64,
    target: i64,
) -> AppResult<()> {
    let mut stmt = conn
        .prepare("SELECT id,rule_json FROM smart_albums WHERE album_type='person_combination'")?;
    let albums = stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    for (id, json) in albums {
        let mut rule = combination_rule(&json)?;
        if !rule.person_ids.contains(&source) {
            continue;
        }
        for person in &mut rule.person_ids {
            if *person == source {
                *person = target;
            }
        }
        rule.person_ids.sort_unstable();
        rule.person_ids.dedup();
        conn.execute(
            "UPDATE smart_albums SET rule_json=?2, updated_at=CURRENT_TIMESTAMP WHERE id=?1",
            params![id, serde_json::json!(rule).to_string()],
        )?;
    }
    Ok(())
}

/// Get all smart albums with photo counts.
pub fn get_all_smart_albums(conn: &rusqlite::Connection) -> AppResult<Vec<SmartAlbum>> {
    let mut stmt = conn.prepare(
        "SELECT sa.id, sa.name, sa.album_type, sa.rule_json, sa.cover_photo_id,
                COUNT(sap.photo_id) as photo_count,
                sa.created_at, sa.updated_at
         FROM smart_albums sa
         LEFT JOIN smart_album_photos sap ON sap.album_id = sa.id
         GROUP BY sa.id
         ORDER BY sa.updated_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(SmartAlbum {
            id: row.get(0)?,
            name: row.get(1)?,
            album_type: row.get(2)?,
            rule_json: row.get(3)?,
            cover_photo_id: row.get(4)?,
            photo_count: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    })?;
    let mut albums = rows.collect::<Result<Vec<_>, _>>()?;
    for album in &mut albums {
        if album.album_type != "person_combination" {
            continue;
        }
        let rule = combination_rule(&album.rule_json)?;
        if rule.person_ids.len() < 2 {
            album.cover_photo_id = None;
            continue;
        }
        let people = serde_json::json!(rule.person_ids).to_string();
        let (count, cover) = conn.query_row(
            &format!("{GROUP_QUERY} SELECT COUNT(*), COALESCE(MAX(CASE WHEN photo_id=?4 THEN photo_id END), MAX(photo_id)) FROM matches"),
            params![people, 0, rule.exact, album.cover_photo_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        album.photo_count = count;
        album.cover_photo_id = cover;
    }
    Ok(albums)
}

/// Get photos in a smart album with pagination.
/// Returns (photo_id, position) tuples ordered by position.
pub fn get_album_photos(
    conn: &rusqlite::Connection,
    album_id: i64,
    cursor: Option<i64>,
    limit: i64,
) -> AppResult<Vec<(i64, i64)>> {
    let combination: Option<String> = conn
        .query_row(
            "SELECT rule_json FROM smart_albums WHERE id=?1 AND album_type='person_combination'",
            [album_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(json) = combination {
        let rule = combination_rule(&json)?;
        if rule.person_ids.len() < 2 {
            return Ok(vec![]);
        }
        return Ok(get_group_photos(
            conn,
            &rule.person_ids,
            0,
            rule.exact,
            cursor.and_then(i64::checked_neg),
            limit,
        )?
        .into_iter()
        .map(|row| (row.photo_id, -row.photo_id))
        .collect());
    }
    let mut stmt = conn.prepare(
        "SELECT sap.photo_id, sap.position
         FROM smart_album_photos sap
         WHERE sap.album_id = ?1
           AND (?2 IS NULL OR sap.position > ?2)
         ORDER BY sap.position ASC
         LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![album_id, cursor, limit], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
}

/// Create a user-managed album. Manual albums survive smart-album regeneration.
pub fn create_manual_album(conn: &rusqlite::Connection, name: &str) -> AppResult<i64> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Project("相册名称不能为空".into()));
    }
    conn.execute(
        "INSERT INTO smart_albums (name, album_type, rule_json) VALUES (?1, 'manual', '{\"type\":\"manual\"}')",
        params![name],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Rename an album. This is useful for both generated and manual albums.
pub fn rename_album(conn: &rusqlite::Connection, album_id: i64, name: &str) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Project("相册名称不能为空".into()));
    }
    let changed = conn.execute(
        "UPDATE smart_albums SET name = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        params![album_id, name],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("相册 {}", album_id)));
    }
    Ok(())
}

pub fn delete_album(conn: &rusqlite::Connection, album_id: i64) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM smart_album_photos WHERE album_id = ?1",
        params![album_id],
    )?;
    let changed = tx.execute("DELETE FROM smart_albums WHERE id = ?1", params![album_id])?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("相册 {}", album_id)));
    }
    tx.commit()?;
    Ok(())
}

fn ensure_manual_album(conn: &rusqlite::Connection, album_id: i64) -> AppResult<()> {
    let album_type: String = conn
        .query_row(
            "SELECT album_type FROM smart_albums WHERE id = ?1",
            params![album_id],
            |row| row.get(0),
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => {
                AppError::NotFound(format!("相册 {}", album_id))
            }
            other => other.into(),
        })?;
    if album_type != "manual" {
        return Err(AppError::Project(
            "自动相册的内容由规则生成，不能手工增删照片".into(),
        ));
    }
    Ok(())
}

pub fn add_photos_to_album(
    conn: &rusqlite::Connection,
    album_id: i64,
    photo_ids: &[i64],
) -> AppResult<i64> {
    ensure_manual_album(conn, album_id)?;
    let tx = conn.unchecked_transaction()?;
    let mut next_position: i64 = tx.query_row(
        "SELECT COALESCE(MAX(position), 0) + 1 FROM smart_album_photos WHERE album_id = ?1",
        params![album_id],
        |row| row.get(0),
    )?;
    let mut added = 0;
    for photo_id in photo_ids {
        let changed = tx.execute(
            "INSERT OR IGNORE INTO smart_album_photos (album_id, photo_id, position)
             SELECT ?1, id, ?3 FROM photos WHERE id = ?2 AND deleted = 0",
            params![album_id, photo_id, next_position],
        )?;
        if changed > 0 {
            added += 1;
            next_position += 1;
        }
    }
    tx.execute(
        "UPDATE smart_albums SET cover_photo_id = COALESCE(cover_photo_id,
             (SELECT photo_id FROM smart_album_photos WHERE album_id = ?1 ORDER BY position LIMIT 1)),
             updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        params![album_id],
    )?;
    tx.commit()?;
    Ok(added)
}

pub fn remove_photos_from_album(
    conn: &rusqlite::Connection,
    album_id: i64,
    photo_ids: &[i64],
) -> AppResult<i64> {
    ensure_manual_album(conn, album_id)?;
    let tx = conn.unchecked_transaction()?;
    let mut removed = 0;
    for photo_id in photo_ids {
        removed += tx.execute(
            "DELETE FROM smart_album_photos WHERE album_id = ?1 AND photo_id = ?2",
            params![album_id, photo_id],
        )? as i64;
    }
    tx.execute(
        "UPDATE smart_albums SET cover_photo_id = CASE
             WHEN cover_photo_id IS NULL OR NOT EXISTS (
               SELECT 1 FROM smart_album_photos WHERE album_id = ?1 AND photo_id = cover_photo_id
             ) THEN (SELECT photo_id FROM smart_album_photos WHERE album_id = ?1 ORDER BY position LIMIT 1)
             ELSE cover_photo_id END,
             updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        params![album_id],
    )?;
    tx.commit()?;
    Ok(removed)
}

pub fn set_album_cover(conn: &rusqlite::Connection, album_id: i64, photo_id: i64) -> AppResult<()> {
    let rule: Option<String> = conn
        .query_row(
            "SELECT rule_json FROM smart_albums WHERE id=?1 AND album_type='person_combination'",
            [album_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(json) = rule {
        let rule = combination_rule(&json)?;
        if rule.person_ids.len() >= 2
            && get_group_photos(
                conn,
                &rule.person_ids,
                0,
                rule.exact,
                photo_id.checked_add(1),
                1,
            )?
            .first()
            .is_some_and(|row| row.photo_id == photo_id)
        {
            conn.execute("UPDATE smart_albums SET cover_photo_id=?2,updated_at=CURRENT_TIMESTAMP WHERE id=?1", params![album_id,photo_id])?;
            return Ok(());
        }
        return Err(AppError::Project("照片不在此组合相册中".into()));
    }
    let changed = conn.execute(
        "UPDATE smart_albums SET cover_photo_id = ?2, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?1 AND EXISTS (
           SELECT 1 FROM smart_album_photos WHERE album_id = ?1 AND photo_id = ?2
         )",
        params![album_id, photo_id],
    )?;
    if changed == 0 {
        return Err(AppError::Project("封面照片不在该相册中".into()));
    }
    Ok(())
}

/// Delete generated albums and regenerate them. User-managed albums are preserved.
/// Returns the number of albums created.
pub fn regenerate_smart_albums(conn: &rusqlite::Connection) -> AppResult<i64> {
    conn.execute(
        "DELETE FROM smart_album_photos WHERE album_id IN
         (SELECT id FROM smart_albums WHERE album_type NOT IN ('manual','person_combination'))",
        [],
    )?;
    conn.execute(
        "DELETE FROM smart_albums WHERE album_type NOT IN ('manual','person_combination')",
        [],
    )?;

    let mut count = 0i64;

    count += generate_travel_albums(conn)?;
    count += generate_monthly_albums(conn)?;
    count += generate_themed_albums(conn)?;
    count += generate_person_albums(conn)?;

    Ok(count)
}

// ---------------------------------------------------------------------------
// Travel Albums
// ---------------------------------------------------------------------------

/// Generate travel albums for locations with geo_location tags,
/// 3+ distinct days, and 20+ photos.
/// Name format: "{location}之旅 · {days}天 · {photo_count}张"
fn generate_travel_albums(conn: &rusqlite::Connection) -> AppResult<i64> {
    // Find locations with 3+ days and 20+ photos
    let mut stmt = conn.prepare(
        "SELECT ac.label,
                COUNT(DISTINCT strftime('%Y-%m-%d', COALESCE(p.taken_at, p.file_mtime), 'unixepoch')) as days,
                COUNT(*) as photo_count,
                MIN(p.id) as first_photo_id
         FROM ai_classifications ac
         JOIN photos p ON p.id = ac.photo_id
         WHERE ac.tag_type = 'geo_location' AND p.deleted = 0
         GROUP BY ac.label
         HAVING days >= 3 AND photo_count >= 20
         ORDER BY photo_count DESC"
    )?;

    let rows: Vec<(String, i64, i64, i64)> = stmt
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .filter_map(|r| r.ok())
        .collect();

    let mut count = 0i64;

    for (location, days, photo_count, _first_photo_id) in rows {
        let name = format!("{}之旅 · {}天 · {}张", location, days, photo_count);
        let rule = serde_json::json!({
            "type": "travel",
            "location": location,
            "min_days": 3,
            "min_photos": 20
        });

        // Insert album
        conn.execute(
            "INSERT INTO smart_albums (name, album_type, rule_json) VALUES (?1, ?2, ?3)",
            params![name, "travel", rule.to_string()],
        )?;
        let album_id = conn.last_insert_rowid();

        // Insert photos for this location
        conn.execute(
            "INSERT INTO smart_album_photos (album_id, photo_id, position)
             SELECT ?1, p.id, ROW_NUMBER() OVER (ORDER BY COALESCE(p.taken_at, p.file_mtime) ASC)
             FROM photos p
             JOIN ai_classifications ac ON ac.photo_id = p.id
             WHERE ac.tag_type = 'geo_location' AND ac.label = ?2 AND p.deleted = 0",
            params![album_id, location],
        )?;

        // Set cover photo (first photo)
        conn.execute(
            "UPDATE smart_albums SET cover_photo_id = (
                SELECT sap.photo_id FROM smart_album_photos sap WHERE sap.album_id = ?1 ORDER BY sap.position ASC LIMIT 1
            ) WHERE id = ?1",
            params![album_id],
        )?;

        count += 1;
    }

    Ok(count)
}

// ---------------------------------------------------------------------------
// Monthly Albums
// ---------------------------------------------------------------------------

/// Generate monthly albums. Name format: "{YYYY-MM}精选", limit 50 photos.
fn generate_monthly_albums(conn: &rusqlite::Connection) -> AppResult<i64> {
    let mut stmt = conn.prepare(
        "SELECT strftime('%Y-%m', COALESCE(taken_at, file_mtime), 'unixepoch') as month,
                COUNT(*) as photo_count,
                MIN(id) as first_photo_id
         FROM photos
         WHERE deleted = 0 AND taken_at IS NOT NULL
         GROUP BY month
         ORDER BY month DESC",
    )?;

    let rows: Vec<(String, i64, i64)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .filter_map(|r| r.ok())
        .collect();

    let mut count = 0i64;

    for (month, _photo_count, _first_photo_id) in rows {
        let name = format!("{}精选", month);
        let rule = serde_json::json!({
            "type": "monthly",
            "month": month,
            "limit": 50
        });

        // Insert album
        conn.execute(
            "INSERT INTO smart_albums (name, album_type, rule_json) VALUES (?1, ?2, ?3)",
            params![name, "monthly", rule.to_string()],
        )?;
        let album_id = conn.last_insert_rowid();

        // Insert photos for this month, limited to 50
        conn.execute(
            "INSERT INTO smart_album_photos (album_id, photo_id, position)
             SELECT ?1, p.id, ROW_NUMBER() OVER (ORDER BY COALESCE(p.taken_at, p.file_mtime) ASC)
             FROM photos p
             WHERE p.deleted = 0
               AND strftime('%Y-%m', COALESCE(p.taken_at, p.file_mtime), 'unixepoch') = ?2
             ORDER BY COALESCE(p.taken_at, p.file_mtime) ASC
             LIMIT 50",
            params![album_id, month],
        )?;

        // Set cover photo
        conn.execute(
            "UPDATE smart_albums SET cover_photo_id = (
                SELECT sap.photo_id FROM smart_album_photos sap WHERE sap.album_id = ?1 ORDER BY sap.position ASC LIMIT 1
            ) WHERE id = ?1",
            params![album_id],
        )?;

        count += 1;
    }

    Ok(count)
}

// ---------------------------------------------------------------------------
// Themed Albums
// ---------------------------------------------------------------------------

/// Generate themed albums from ai_scene labels with 10+ photos.
/// Name format: "{label} · {count}张"
fn generate_themed_albums(conn: &rusqlite::Connection) -> AppResult<i64> {
    let mut stmt = conn.prepare(
        "SELECT ac.label, COUNT(*) as photo_count
         FROM ai_classifications ac
         JOIN photos p ON p.id = ac.photo_id
         WHERE ac.tag_type = 'ai_scene' AND p.deleted = 0
         GROUP BY ac.label
         HAVING photo_count >= 10
         ORDER BY photo_count DESC",
    )?;

    let rows: Vec<(String, i64)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();

    let mut count = 0i64;

    for (label, photo_count) in rows {
        let name = format!("{} · {}张", label, photo_count);
        let rule = serde_json::json!({
            "type": "themed",
            "label": label,
            "min_photos": 10
        });

        // Insert album
        conn.execute(
            "INSERT INTO smart_albums (name, album_type, rule_json) VALUES (?1, ?2, ?3)",
            params![name, "themed", rule.to_string()],
        )?;
        let album_id = conn.last_insert_rowid();

        // Insert photos for this label
        conn.execute(
            "INSERT INTO smart_album_photos (album_id, photo_id, position)
             SELECT ?1, p.id, ROW_NUMBER() OVER (ORDER BY COALESCE(p.taken_at, p.file_mtime) ASC)
             FROM photos p
             JOIN ai_classifications ac ON ac.photo_id = p.id
             WHERE ac.tag_type = 'ai_scene' AND ac.label = ?2 AND p.deleted = 0",
            params![album_id, label],
        )?;

        // Set cover photo
        conn.execute(
            "UPDATE smart_albums SET cover_photo_id = (
                SELECT sap.photo_id FROM smart_album_photos sap WHERE sap.album_id = ?1 ORDER BY sap.position ASC LIMIT 1
            ) WHERE id = ?1",
            params![album_id],
        )?;

        count += 1;
    }

    Ok(count)
}

// ---------------------------------------------------------------------------
// Person Albums
// ---------------------------------------------------------------------------

/// Generate albums for named persons with faces.
/// Name format: "{person_name}的照片"
fn generate_person_albums(conn: &rusqlite::Connection) -> AppResult<i64> {
    let persons = super::face_dao::get_named_persons(conn)?;

    let mut count = 0i64;

    for (person_id, person_name) in persons {
        let name = format!("{}的照片", person_name);
        let rule = serde_json::json!({
            "type": "person",
            "person_id": person_id,
            "person_name": person_name
        });

        // Insert album
        conn.execute(
            "INSERT INTO smart_albums (name, album_type, rule_json) VALUES (?1, ?2, ?3)",
            params![name, "person", rule.to_string()],
        )?;
        let album_id = conn.last_insert_rowid();

        // Insert photos for this person, limited to 200
        conn.execute(
            "INSERT INTO smart_album_photos (album_id, photo_id, position)
             SELECT ?1, p.id, ROW_NUMBER() OVER (ORDER BY COALESCE(p.taken_at, p.file_mtime) DESC)
             FROM photos p
             WHERE p.deleted = 0 AND EXISTS (
                 SELECT 1 FROM face_detections fd WHERE fd.photo_id=p.id AND fd.person_id=?2
                   AND COALESCE(fd.review_status,'active')='active'
             )
             ORDER BY COALESCE(p.taken_at, p.file_mtime) DESC
             LIMIT 200",
            params![album_id, person_id],
        )?;

        // Set cover photo (most recent photo)
        conn.execute(
            "UPDATE smart_albums SET cover_photo_id = (
                SELECT sap.photo_id FROM smart_album_photos sap WHERE sap.album_id = ?1 ORDER BY sap.position ASC LIMIT 1
            ) WHERE id = ?1",
            params![album_id],
        )?;

        count += 1;
    }

    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    use crate::db::schema::CREATE_TABLES;

    fn new_in_memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CREATE_TABLES).unwrap();
        // Add tag_type column (migration)
        conn.execute_batch(
            "ALTER TABLE ai_classifications ADD COLUMN tag_type TEXT DEFAULT 'ai_scene';",
        )
        .ok();
        conn
    }

    fn insert_photo(conn: &Connection, id: i64, path: &str, taken_at: i64) {
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at, deleted)
             VALUES (?1, ?2, ?3, 1000, ?4, ?4, ?4, 0)",
            params![id, path, format!("photo_{}.jpg", id), taken_at],
        ).unwrap();
    }

    #[test]
    fn group_filters_and_saved_combinations_track_current_people() {
        let conn = new_in_memory_db();
        for (id, name) in [(1, "甲"), (2, "乙"), (3, "丙"), (4, "丁")] {
            conn.execute(
                "INSERT INTO face_clusters(id,name,face_count,created_at) VALUES (?1,?2,0,0)",
                params![id, name],
            )
            .unwrap();
        }
        for id in 1..=5 {
            insert_photo(&conn, id, &format!("/{id}.jpg"), id);
        }
        for (photo, person, status) in [
            (1, Some(1), "active"),
            (1, Some(1), "active"),
            (1, Some(2), "active"),
            (1, None, "ignored"),
            (2, Some(1), "active"),
            (2, Some(2), "active"),
            (2, Some(3), "identity_review"),
            (3, Some(1), "active"),
            (3, None, "suspected_false_positive"),
            (4, Some(1), "active"),
            (4, Some(2), "active"),
            (4, Some(3), "active"),
            (4, Some(4), "active"),
            (5, Some(1), "active"),
            (5, Some(2), "active"),
        ] {
            conn.execute("INSERT INTO face_detections(photo_id,person_id,review_status,created_at) VALUES (?1,?2,?3,0)",params![photo,person,status]).unwrap();
        }
        conn.execute("UPDATE photos SET deleted=1 WHERE id=5", [])
            .unwrap();
        assert_eq!(
            get_group_photos(&conn, &[], 2, false, None, 20).unwrap()[0].photo_id,
            1
        );
        let three = get_group_photos(&conn, &[], 3, false, None, 20).unwrap();
        assert_eq!((three[0].photo_id, three[0].unconfirmed_count), (2, 1));
        assert_eq!(
            get_group_photos(&conn, &[], 4, false, None, 20).unwrap()[0].photo_id,
            4
        );
        assert_eq!(
            get_group_photos(&conn, &[1, 2], 0, false, None, 20)
                .unwrap()
                .len(),
            3
        );
        let album = create_person_combination(&conn, "  家人  ", vec![1, 2, 2], true).unwrap();
        assert_eq!(
            get_album_photos(&conn, album, None, 20).unwrap(),
            vec![(1, -1)]
        );
        assert!(get_album_photos(&conn, album, Some(-1), 20)
            .unwrap()
            .is_empty());
        conn.execute(
            "UPDATE face_detections SET review_status='ignored' WHERE photo_id=2 AND person_id=3",
            [],
        )
        .unwrap();
        assert_eq!(
            get_album_photos(&conn, album, None, 20).unwrap(),
            vec![(2, -2), (1, -1)]
        );
        set_album_cover(&conn, album, 1).unwrap();
        assert!(set_album_cover(&conn, album, 3).is_err());
        regenerate_smart_albums(&conn).unwrap();
        let albums = get_all_smart_albums(&conn).unwrap();
        let saved = albums.iter().find(|item| item.id == album).unwrap();
        assert_eq!(
            (saved.name.as_str(), saved.photo_count, saved.cover_photo_id),
            ("家人", 2, Some(1))
        );
        super::super::face_dao::merge_clusters(&conn, 2, 3).unwrap();
        assert_eq!(
            get_album_photos(&conn, album, None, 20).unwrap(),
            vec![(2, -2), (1, -1)]
        );
    }

    fn insert_classification(conn: &Connection, photo_id: i64, label: &str, tag_type: &str) {
        conn.execute(
            "INSERT INTO ai_classifications (photo_id, category, label, confidence, tag_type)
             VALUES (?1, 'test', ?2, 0.9, ?3)",
            params![photo_id, label, tag_type],
        )
        .unwrap();
    }

    fn insert_face(conn: &Connection, photo_id: i64, person_id: i64) {
        conn.execute(
            "INSERT INTO face_detections (photo_id, person_id, created_at)
             VALUES (?1, ?2, 0)",
            params![photo_id, person_id],
        )
        .unwrap();
    }

    fn insert_person(conn: &Connection, id: i64, name: &str) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        conn.execute(
            "INSERT INTO face_clusters (id, name, face_count, created_at) VALUES (?1, ?2, 0, ?3)",
            params![id, name, now],
        )
        .unwrap();
    }

    // ----- Travel album tests -----

    #[test]
    fn test_generate_travel_albums_meets_threshold() {
        let conn = new_in_memory_db();

        // Create photos across 4 days in "Tokyo" with 28 photos
        let mut id = 1i64;
        for day_offset in 0..4 {
            let day_ts = 1700000000 + day_offset * 86400;
            for _ in 0..7 {
                insert_photo(&conn, id, &format!("/tokyo/{}.jpg", id), day_ts);
                insert_classification(&conn, id, "Tokyo", "geo_location");
                id += 1;
            }
        }

        // Verify data exists
        let geo_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ai_classifications WHERE tag_type = 'geo_location'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(geo_count, 28, "Expected 28 geo_location classifications");

        let count = generate_travel_albums(&conn).unwrap();
        assert_eq!(count, 1);

        let albums = get_all_smart_albums(&conn).unwrap();
        assert_eq!(albums.len(), 1);
        assert_eq!(albums[0].album_type, "travel");
        assert!(albums[0].name.contains("Tokyo"));
        assert!(albums[0].name.contains("之旅"));
        assert_eq!(albums[0].photo_count, 28);
    }

    #[test]
    fn test_generate_travel_albums_below_day_threshold() {
        let conn = new_in_memory_db();

        // Only 2 days, should not create album
        for day_offset in 0..2 {
            let day_ts = 1700000000 + day_offset * 86400;
            for i in 0..15 {
                let id = day_offset * 15 + i + 1;
                insert_photo(&conn, id, &format!("/tokyo/{}.jpg", id), day_ts);
                insert_classification(&conn, id, "Tokyo", "geo_location");
            }
        }

        let count = generate_travel_albums(&conn).unwrap();
        assert_eq!(count, 0);

        let albums = get_all_smart_albums(&conn).unwrap();
        assert_eq!(albums.len(), 0);
    }

    #[test]
    fn test_generate_travel_albums_below_photo_threshold() {
        let conn = new_in_memory_db();

        // 5 days but only 10 photos total
        for day_offset in 0..5 {
            let day_ts = 1700000000 + day_offset * 86400;
            let id = day_offset + 1;
            insert_photo(&conn, id, &format!("/tokyo/{}.jpg", id), day_ts);
            insert_classification(&conn, id, "Tokyo", "geo_location");
        }

        let count = generate_travel_albums(&conn).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_generate_travel_albums_deleted_photos_excluded() {
        let conn = new_in_memory_db();

        // Create 35 photos across 4 days, mark 10 as deleted, leaving 25 non-deleted
        let mut id = 1i64;
        for day_offset in 0..4 {
            let day_ts = 1700000000 + day_offset * 86400;
            let photos_this_day = if day_offset < 3 { 9 } else { 8 }; // 9+9+9+8 = 35
            for _ in 0..photos_this_day {
                let deleted = if id > 25 { 1 } else { 0 }; // 10 deleted, 25 remain
                conn.execute(
                    "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at, deleted)
                     VALUES (?1, ?2, ?3, 1000, ?4, ?4, ?4, ?5)",
                    params![id, format!("/tokyo/{}.jpg", id), format!("photo_{}.jpg", id), day_ts, deleted],
                ).unwrap();
                insert_classification(&conn, id, "Tokyo", "geo_location");
                id += 1;
            }
        }

        let count = generate_travel_albums(&conn).unwrap();
        assert_eq!(count, 1);

        let albums = get_all_smart_albums(&conn).unwrap();
        assert_eq!(albums.len(), 1);
        assert_eq!(albums[0].photo_count, 25); // Only non-deleted photos
    }

    // ----- Monthly album tests -----

    #[test]
    fn test_generate_monthly_albums() {
        let conn = new_in_memory_db();

        // Photos in two months
        for i in 1..=10 {
            insert_photo(&conn, i, &format!("/photos/{}.jpg", i), 1704067200); // 2024-01
        }
        for i in 11..=20 {
            insert_photo(&conn, i, &format!("/photos/{}.jpg", i), 1706745600); // 2024-02
        }

        let count = generate_monthly_albums(&conn).unwrap();
        assert_eq!(count, 2);

        let albums = get_all_smart_albums(&conn).unwrap();
        assert_eq!(albums.len(), 2);
        assert!(albums.iter().any(|a| a.name == "2024-01精选"));
        assert!(albums.iter().any(|a| a.name == "2024-02精选"));
    }

    #[test]
    fn test_generate_monthly_albums_respects_limit() {
        let conn = new_in_memory_db();

        // 60 photos in one month
        for i in 1..=60 {
            insert_photo(&conn, i, &format!("/photos/{}.jpg", i), 1704067200);
        }

        generate_monthly_albums(&conn).unwrap();

        let albums = get_all_smart_albums(&conn).unwrap();
        assert_eq!(albums.len(), 1);
        assert_eq!(albums[0].photo_count, 50); // Limited to 50
    }

    // ----- Themed album tests -----

    #[test]
    fn test_generate_themed_albums_meets_threshold() {
        let conn = new_in_memory_db();

        // 15 photos with "beach" label
        for i in 1..=15 {
            insert_photo(&conn, i, &format!("/photos/{}.jpg", i), 1704067200 + i);
            insert_classification(&conn, i, "beach", "ai_scene");
        }

        // Only 5 photos with "mountain" label (below threshold)
        for i in 16..=20 {
            insert_photo(&conn, i, &format!("/photos/{}.jpg", i), 1704067200 + i);
            insert_classification(&conn, i, "mountain", "ai_scene");
        }

        let count = generate_themed_albums(&conn).unwrap();
        assert_eq!(count, 1);

        let albums = get_all_smart_albums(&conn).unwrap();
        assert_eq!(albums.len(), 1);
        assert!(albums[0].name.contains("beach"));
        assert_eq!(albums[0].album_type, "themed");
    }

    #[test]
    fn test_generate_themed_albums_deleted_photos_excluded() {
        let conn = new_in_memory_db();

        // 15 photos with "beach" but 6 are deleted
        for i in 1..=15 {
            let deleted = if i > 9 { 1 } else { 0 };
            conn.execute(
                "INSERT INTO photos (id, path, filename, file_size, file_mtime, taken_at, imported_at, deleted)
                 VALUES (?1, ?2, ?3, 1000, 1704067200, 1704067200, 1704067200, ?4)",
                params![i, format!("/photos/{}.jpg", i), format!("photo_{}.jpg", i), deleted],
            ).unwrap();
            insert_classification(&conn, i, "beach", "ai_scene");
        }

        let count = generate_themed_albums(&conn).unwrap();
        assert_eq!(count, 0); // Only 9 non-deleted, below 10 threshold
    }

    // ----- Person album tests -----

    #[test]
    fn test_generate_person_albums() {
        let conn = new_in_memory_db();

        // Create a named person
        insert_person(&conn, 1, "Alice");

        // Add faces for this person in 5 photos
        for i in 1..=5 {
            insert_photo(
                &conn,
                i,
                &format!("/photos/{}.jpg", i),
                1704067200 + i * 1000,
            );
            insert_face(&conn, i, 1);
        }

        // Also create an unnamed person (should not generate album)
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        conn.execute(
            "INSERT INTO face_clusters (id, name, face_count, created_at) VALUES (?1, NULL, 0, ?2)",
            params![2i64, now],
        )
        .unwrap();
        for i in 6..=8 {
            insert_photo(
                &conn,
                i,
                &format!("/photos/{}.jpg", i),
                1704067200 + i * 1000,
            );
            insert_face(&conn, i, 2);
        }

        let count = generate_person_albums(&conn).unwrap();
        assert_eq!(count, 1);

        let albums = get_all_smart_albums(&conn).unwrap();
        assert_eq!(albums.len(), 1);
        assert!(albums[0].name.contains("Alice"));
        assert!(albums[0].name.contains("的照片"));
        assert_eq!(albums[0].album_type, "person");
        assert_eq!(albums[0].photo_count, 5);
    }

    #[test]
    fn test_generate_person_albums_respects_limit() {
        let conn = new_in_memory_db();

        insert_person(&conn, 1, "Bob");

        // 250 photos for Bob (should be limited to 200)
        for i in 1..=250 {
            insert_photo(&conn, i, &format!("/photos/{}.jpg", i), 1704067200 + i);
            insert_face(&conn, i, 1);
        }

        generate_person_albums(&conn).unwrap();

        let albums = get_all_smart_albums(&conn).unwrap();
        assert_eq!(albums.len(), 1);
        assert_eq!(albums[0].photo_count, 200);
    }

    // ----- Regenerate tests -----

    #[test]
    fn test_regenerate_clears_and_recreates() {
        let conn = new_in_memory_db();

        // First generate some albums (need 10+ photos for themed threshold)
        for i in 1..=12 {
            insert_photo(&conn, i, &format!("/photos/{}.jpg", i), 1704067200 + i);
            insert_classification(&conn, i, "beach", "ai_scene");
        }

        generate_themed_albums(&conn).unwrap();
        let albums = get_all_smart_albums(&conn).unwrap();
        assert_eq!(albums.len(), 1);

        // Regenerate (should clear and recreate - themed + monthly)
        let count = regenerate_smart_albums(&conn).unwrap();
        assert!(count >= 1, "Expected at least 1 album, got {}", count);

        let albums = get_all_smart_albums(&conn).unwrap();
        assert!(albums.len() >= 1);
        assert!(albums.iter().any(|a| a.name.contains("beach")));
    }

    // ----- Pagination tests -----

    #[test]
    fn test_get_album_photos_pagination() {
        let conn = new_in_memory_db();

        // Create a manual album with photos
        conn.execute(
            "INSERT INTO smart_albums (name, album_type, rule_json) VALUES (?1, ?2, ?3)",
            params!["Test Album", "test", "{}"],
        )
        .unwrap();
        let album_id = conn.last_insert_rowid();

        for i in 1..=15 {
            insert_photo(&conn, i, &format!("/photos/{}.jpg", i), 1704067200 + i);
            conn.execute(
                "INSERT INTO smart_album_photos (album_id, photo_id, position) VALUES (?1, ?2, ?3)",
                params![album_id, i, i],
            )
            .unwrap();
        }

        // First page
        let photos = get_album_photos(&conn, album_id, None, 5).unwrap();
        assert_eq!(photos.len(), 5);
        assert_eq!(photos[0].0, 1); // First photo_id

        // Second page using cursor
        let last_position = photos.last().unwrap().1;
        let photos = get_album_photos(&conn, album_id, Some(last_position), 5).unwrap();
        assert_eq!(photos.len(), 5);
        assert_eq!(photos[0].0, 6); // Next photo_id

        // Third page - remaining
        let last_position = photos.last().unwrap().1;
        let photos = get_album_photos(&conn, album_id, Some(last_position), 5).unwrap();
        assert_eq!(photos.len(), 5);
        assert_eq!(photos[0].0, 11);
    }

    #[test]
    fn test_get_album_photos_empty_album() {
        let conn = new_in_memory_db();

        conn.execute(
            "INSERT INTO smart_albums (name, album_type, rule_json) VALUES (?1, ?2, ?3)",
            params!["Empty Album", "test", "{}"],
        )
        .unwrap();
        let album_id = conn.last_insert_rowid();

        let photos = get_album_photos(&conn, album_id, None, 100).unwrap();
        assert!(photos.is_empty());
    }

    #[test]
    fn test_manual_album_crud_and_membership() {
        let conn = new_in_memory_db();
        for id in 1..=3 {
            insert_photo(&conn, id, &format!("/photos/{}.jpg", id), 1704067200 + id);
        }
        let album_id = create_manual_album(&conn, " 家庭精选 ").unwrap();
        assert_eq!(
            add_photos_to_album(&conn, album_id, &[1, 2, 2, 3]).unwrap(),
            3
        );
        let albums = get_all_smart_albums(&conn).unwrap();
        assert_eq!(albums[0].name, "家庭精选");
        assert_eq!(albums[0].album_type, "manual");
        assert_eq!(albums[0].photo_count, 3);

        set_album_cover(&conn, album_id, 2).unwrap();
        rename_album(&conn, album_id, "家人").unwrap();
        assert_eq!(remove_photos_from_album(&conn, album_id, &[2]).unwrap(), 1);
        let album = get_all_smart_albums(&conn).unwrap().remove(0);
        assert_eq!(album.name, "家人");
        assert_eq!(album.photo_count, 2);
        assert_ne!(album.cover_photo_id, Some(2));

        delete_album(&conn, album_id).unwrap();
        assert!(get_all_smart_albums(&conn).unwrap().is_empty());
    }

    #[test]
    fn test_regenerate_preserves_manual_albums() {
        let conn = new_in_memory_db();
        insert_photo(&conn, 1, "/photos/1.jpg", 1704067200);
        let album_id = create_manual_album(&conn, "不要删除").unwrap();
        add_photos_to_album(&conn, album_id, &[1]).unwrap();

        regenerate_smart_albums(&conn).unwrap();

        let albums = get_all_smart_albums(&conn).unwrap();
        let manual = albums.iter().find(|album| album.id == album_id).unwrap();
        assert_eq!(manual.album_type, "manual");
        assert_eq!(manual.photo_count, 1);
    }

    #[test]
    fn test_generated_album_rejects_manual_membership_changes() {
        let conn = new_in_memory_db();
        insert_photo(&conn, 1, "/photos/1.jpg", 1704067200);
        conn.execute(
            "INSERT INTO smart_albums (name, album_type, rule_json) VALUES ('自动', 'monthly', '{}')",
            [],
        ).unwrap();
        let album_id = conn.last_insert_rowid();
        assert!(add_photos_to_album(&conn, album_id, &[1]).is_err());
        assert!(remove_photos_from_album(&conn, album_id, &[1]).is_err());
    }
}
