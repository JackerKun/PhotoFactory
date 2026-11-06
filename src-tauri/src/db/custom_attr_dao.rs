// src-tauri/src/db/custom_attr_dao.rs
use rusqlite::params;

use crate::error::AppResult;
use crate::models::CustomAttribute;

pub fn upsert_attribute(conn: &rusqlite::Connection, attr: &CustomAttribute) -> AppResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO custom_attributes (photo_id, key, value) VALUES (?1, ?2, ?3)",
        params![attr.photo_id, attr.key, attr.value],
    )?;
    Ok(())
}

pub fn get_attributes_for_photo(
    conn: &rusqlite::Connection,
    photo_id: i64,
) -> AppResult<Vec<CustomAttribute>> {
    let mut stmt =
        conn.prepare("SELECT id, photo_id, key, value FROM custom_attributes WHERE photo_id = ?")?;
    let rows = stmt
        .query_map([photo_id], |r| {
            Ok(CustomAttribute {
                id: r.get(0)?,
                photo_id: r.get(1)?,
                key: r.get(2)?,
                value: r.get(3)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

pub fn delete_attribute(conn: &rusqlite::Connection, attr_id: i64) -> AppResult<()> {
    conn.execute(
        "DELETE FROM custom_attributes WHERE id = ?",
        params![attr_id],
    )?;
    Ok(())
}
