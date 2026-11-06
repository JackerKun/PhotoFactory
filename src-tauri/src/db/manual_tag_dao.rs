use chrono::Utc;
use rusqlite::{params, OptionalExtension};

use crate::error::{AppError, AppResult};
use crate::models::ManualTag;

const GENERATED_COLORS: [&str; 8] = [
    "#5B8DEF", "#34C759", "#FF9F0A", "#FF453A", "#AF52DE", "#00A7A5", "#8E8E93", "#D17B49",
];

/// Import AI/rule/device/time/location classifications into the same editable
/// catalog used by user-created tags. Each classification is imported once.
pub fn sync_generated_tags(conn: &rusqlite::Connection) -> AppResult<usize> {
    let pending: Vec<(i64, i64, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, photo_id, label FROM ai_classifications
             WHERE COALESCE(manual_tag_synced, 0) = 0 ORDER BY id",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if pending.is_empty() {
        return Ok(0);
    }

    let tx = conn.unchecked_transaction()?;
    let now = Utc::now().timestamp();
    for (classification_id, photo_id, raw_label) in &pending {
        let label = crate::tags::places365_cn::translate_label(raw_label).trim();
        if !label.is_empty() {
            let color_index = label
                .bytes()
                .fold(0usize, |sum, byte| sum.wrapping_add(byte as usize))
                % GENERATED_COLORS.len();
            tx.execute(
                "INSERT OR IGNORE INTO manual_tags (name, color, created_at) VALUES (?1, ?2, ?3)",
                params![label, GENERATED_COLORS[color_index], now],
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO photo_manual_tags (photo_id, tag_id, created_at)
                 SELECT ?1, id, ?3 FROM manual_tags WHERE name = ?2 COLLATE NOCASE",
                params![photo_id, label, now],
            )?;
        }
        tx.execute(
            "UPDATE ai_classifications SET manual_tag_synced = 1 WHERE id = ?1",
            [classification_id],
        )?;
    }
    tx.commit()?;
    Ok(pending.len())
}

fn valid_color(color: &str) -> bool {
    color.len() == 7
        && color.starts_with('#')
        && color[1..].chars().all(|ch| ch.is_ascii_hexdigit())
}

fn validate(name: &str, color: &str) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 40 {
        return Err(AppError::Project(
            "Tag name must contain 1-40 characters".into(),
        ));
    }
    if !valid_color(color) {
        return Err(AppError::Project(
            "Tag color must use #RRGGBB format".into(),
        ));
    }
    Ok(())
}

pub fn get_all(conn: &rusqlite::Connection) -> AppResult<Vec<ManualTag>> {
    sync_generated_tags(conn)?;
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.color, COUNT(pt.photo_id) FROM manual_tags t
         LEFT JOIN photo_manual_tags pt ON pt.tag_id = t.id
         GROUP BY t.id ORDER BY lower(t.name)",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ManualTag {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
            photo_count: row.get(3)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn get_for_photo(conn: &rusqlite::Connection, photo_id: i64) -> AppResult<Vec<ManualTag>> {
    sync_generated_tags(conn)?;
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.color, (SELECT COUNT(*) FROM photo_manual_tags all_pt WHERE all_pt.tag_id = t.id)
         FROM manual_tags t JOIN photo_manual_tags pt ON pt.tag_id = t.id
         WHERE pt.photo_id = ?1 ORDER BY lower(t.name)"
    )?;
    let rows = stmt.query_map([photo_id], |row| {
        Ok(ManualTag {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
            photo_count: row.get(3)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn create(conn: &rusqlite::Connection, name: &str, color: &str) -> AppResult<i64> {
    validate(name, color)?;
    conn.execute(
        "INSERT INTO manual_tags (name, color, created_at) VALUES (?1, ?2, ?3)",
        params![name.trim(), color, Utc::now().timestamp()],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn update(conn: &rusqlite::Connection, tag_id: i64, name: &str, color: &str) -> AppResult<()> {
    validate(name, color)?;
    let changed = conn.execute(
        "UPDATE manual_tags SET name = ?1, color = ?2 WHERE id = ?3",
        params![name.trim(), color, tag_id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("Tag {} not found", tag_id)));
    }
    Ok(())
}

pub fn delete(conn: &rusqlite::Connection, tag_id: i64) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM photo_manual_tags WHERE tag_id = ?1", [tag_id])?;
    tx.execute("DELETE FROM manual_tags WHERE id = ?1", [tag_id])?;
    tx.commit()?;
    Ok(())
}

pub fn set_for_photo(conn: &rusqlite::Connection, photo_id: i64, tag_ids: &[i64]) -> AppResult<()> {
    let photo_exists: Option<i64> = conn
        .query_row("SELECT id FROM photos WHERE id = ?1", [photo_id], |row| {
            row.get(0)
        })
        .optional()?;
    if photo_exists.is_none() {
        return Err(AppError::NotFound(format!("Photo {} not found", photo_id)));
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM photo_manual_tags WHERE photo_id = ?1",
        [photo_id],
    )?;
    {
        let mut insert = tx.prepare_cached(
            "INSERT INTO photo_manual_tags (photo_id, tag_id, created_at) SELECT ?1, id, ?3 FROM manual_tags WHERE id = ?2"
        )?;
        let now = Utc::now().timestamp();
        for tag_id in tag_ids {
            insert.execute(params![photo_id, tag_id, now])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::CREATE_TABLES;
    use rusqlite::Connection;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CREATE_TABLES).unwrap();
        conn.execute_batch(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at)
             VALUES (1, '/photos/one.jpg', 'one.jpg', 100, 1, 1);
             INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at)
             VALUES (2, '/photos/two.jpg', 'two.jpg', 100, 1, 1);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn manual_tag_crud_and_photo_counts() {
        let conn = test_db();
        let trip = create(&conn, "旅行", "#5B8DEF").unwrap();
        let family = create(&conn, "家人", "#F97316").unwrap();

        set_for_photo(&conn, 1, &[trip, family]).unwrap();
        set_for_photo(&conn, 2, &[trip]).unwrap();

        let all = get_all(&conn).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(
            all.iter().find(|tag| tag.id == trip).unwrap().photo_count,
            2
        );
        assert_eq!(
            all.iter().find(|tag| tag.id == family).unwrap().photo_count,
            1
        );

        update(&conn, trip, "江南之行", "#22C55E").unwrap();
        let photo_tags = get_for_photo(&conn, 1).unwrap();
        assert!(photo_tags
            .iter()
            .any(|tag| tag.name == "江南之行" && tag.color == "#22C55E"));

        delete(&conn, family).unwrap();
        assert_eq!(get_all(&conn).unwrap().len(), 1);
        assert_eq!(get_for_photo(&conn, 1).unwrap().len(), 1);
    }

    #[test]
    fn replacing_photo_tags_is_atomic_on_invalid_duplicate_input() {
        let conn = test_db();
        let first = create(&conn, "精选", "#8B5CF6").unwrap();
        let second = create(&conn, "待修图", "#EC4899").unwrap();

        set_for_photo(&conn, 1, &[first]).unwrap();
        assert!(set_for_photo(&conn, 1, &[second, second]).is_err());
        let tags = get_for_photo(&conn, 1).unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].id, first);

        assert!(create(&conn, "", "#123456").is_err());
        assert!(create(&conn, "错误颜色", "blue").is_err());
        assert!(set_for_photo(&conn, 999, &[first]).is_err());
    }

    #[test]
    fn ai_labels_are_imported_into_the_editable_catalog_once() {
        let conn = test_db();
        conn.execute(
            "INSERT INTO ai_classifications (photo_id, category, label, confidence)
             VALUES (1, 'scene', 'b_beach', 0.91)",
            [],
        )
        .unwrap();

        let tags = get_all(&conn).unwrap();
        let beach = tags.iter().find(|tag| tag.name == "海滩").unwrap();
        assert_eq!(beach.photo_count, 1);
        let beach_id = beach.id;

        delete(&conn, beach_id).unwrap();
        // The underlying classifier result is retained for diagnostics, but its
        // one-time sync marker prevents a user-deleted tag from reappearing.
        assert!(get_all(&conn).unwrap().iter().all(|tag| tag.name != "海滩"));
    }
}
