use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Serialize, Deserialize)]
pub struct ErrorPhoto {
    pub filename: String,
    pub path: String,
    pub attempts: Option<i64>,
}

#[derive(Serialize)]
pub struct TaskError {
    pub id: i64,
    pub stage: String,
    pub kind: String,
    pub message: String,
    pub photos: Vec<ErrorPhoto>,
    pub occurred_at: i64,
}

#[derive(Serialize)]
pub struct TaskErrorPage {
    pub entries: Vec<TaskError>,
    pub next_before: Option<i64>,
    pub retryable: i64,
    pub failed_faces: i64,
    pub failed_classifications: i64,
    pub platform: &'static str,
    pub architecture: &'static str,
    pub version: &'static str,
}

pub fn record(
    conn: &Connection,
    stage: &str,
    kind: &str,
    message: &str,
    photos: &[ErrorPhoto],
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO task_error_events (stage,kind,message,photos_json,occurred_at) VALUES (?1,?2,?3,?4,?5)",
        params![stage, kind, message.chars().take(8000).collect::<String>(), serde_json::to_string(photos)?, chrono::Utc::now().timestamp()],
    )?;
    Ok(())
}

pub fn record_task_error(conn: &Connection, stage: &str, message: &str) -> AppResult<()> {
    record(conn, stage, "task", message, &[])
}

pub fn import_legacy_errors(conn: &Connection) -> AppResult<()> {
    let imported = conn
        .query_row(
            "SELECT 1 FROM library_settings WHERE key='task_error_history_imported'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if imported.is_some() {
        return Ok(());
    }

    let tx = conn.unchecked_transaction()?;
    // Only the latest stored error per photo is available from older releases.
    let claimed = tx.execute("INSERT OR IGNORE INTO library_settings(key,value) VALUES ('task_error_history_imported','1')", [])?;
    if claimed != 0 {
        tx.execute(
            "INSERT INTO task_error_events(stage,kind,message,photos_json,occurred_at)
             SELECT t.stage,'photo',t.error,json_array(json_object('filename',p.filename,'path',p.path,'attempts',t.attempts)),t.updated_at
             FROM ai_photo_tasks t JOIN photos p ON p.id=t.photo_id
             WHERE t.error IS NOT NULL AND p.deleted=0 ORDER BY t.updated_at,t.photo_id",
            [],
        )?;
        tx.execute(
            "INSERT INTO task_error_events(stage,kind,message,photos_json,occurred_at)
             SELECT stage,'task',last_error,'[]',updated_at FROM ai_pipeline_state WHERE last_error IS NOT NULL",
            [],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn page(conn: &Connection, before: Option<i64>) -> AppResult<TaskErrorPage> {
    const PAGE_SIZE: usize = 25;
    let mut stmt = conn.prepare(
        "SELECT id,stage,kind,message,photos_json,occurred_at FROM task_error_events
         WHERE id < ?1 ORDER BY id DESC LIMIT ?2",
    )?;
    let mut entries = Vec::new();
    let mut rows = stmt.query(params![before.unwrap_or(i64::MAX), PAGE_SIZE + 1])?;
    while let Some(row) = rows.next()? {
        entries.push(TaskError {
            id: row.get(0)?,
            stage: row.get(1)?,
            kind: row.get(2)?,
            message: row.get(3)?,
            photos: serde_json::from_str(&row.get::<_, String>(4)?)?,
            occurred_at: row.get(5)?,
        });
    }
    let has_more = entries.len() > PAGE_SIZE;
    entries.truncate(PAGE_SIZE);
    let next_before = entries.last().filter(|_| has_more).map(|entry| entry.id);
    let (retryable, failed_faces, failed_classifications) = conn.query_row(
        "SELECT COUNT(*) FILTER (WHERE t.status IN ('pending','running') AND t.error IS NOT NULL),
                COUNT(*) FILTER (WHERE t.status='failed' AND t.stage='face_detection'),
                COUNT(*) FILTER (WHERE t.status='failed' AND t.stage='classification')
         FROM ai_photo_tasks t JOIN photos p ON p.id=t.photo_id WHERE p.deleted=0",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    Ok(TaskErrorPage {
        entries,
        next_before,
        retryable,
        failed_faces,
        failed_classifications,
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        version: env!("CARGO_PKG_VERSION"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::ai_task_dao::{self, FACE_STAGE};

    fn library() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema::CREATE_TABLES)
            .unwrap();
        conn.execute_batch(
            "INSERT INTO photos (id,path,filename,file_size,file_mtime,imported_at)
             VALUES (1,'D:/Photos/one.jpg','one.jpg',1,1,1), (2,'D:/Photos/two.jpg','two.jpg',1,1,1);",
        ).unwrap();
        ai_task_dao::sync_stage_tasks(&conn, FACE_STAGE, "test", "face_status").unwrap();
        conn
    }

    #[test]
    fn batch_history_survives_retry_and_keeps_filenames_and_attempts() {
        let conn = library();
        conn.execute(
            "INSERT INTO photos(id,path,filename,file_size,file_mtime,imported_at)
             VALUES (3,'D:/Photos/three.jpg','three.jpg',1,1,1)",
            [],
        )
        .unwrap();
        ai_task_dao::sync_stage_tasks(&conn, FACE_STAGE, "test", "face_status").unwrap();
        for attempt in 1..=4 {
            let batch = ai_task_dao::claim_tasks(&conn, FACE_STAGE, 2).unwrap();
            assert_eq!(batch, vec![1, 2]);
            ai_task_dao::mark_batch_failed(
                &conn,
                &batch,
                FACE_STAGE,
                "HTTP error",
                "HTTP error\nconnection reset",
            )
            .unwrap();
            assert_eq!(page(&conn, None).unwrap().failed_faces, 2);
            if attempt == 1 {
                assert_eq!(
                    ai_task_dao::claim_tasks(&conn, FACE_STAGE, 2).unwrap(),
                    vec![3]
                );
                conn.execute("UPDATE photos SET face_status=1 WHERE id=3", [])
                    .unwrap();
                ai_task_dao::sync_stage_tasks(&conn, FACE_STAGE, "test", "face_status").unwrap();
            }
            if attempt < 4 {
                assert_eq!(ai_task_dao::retry_failed(&conn).unwrap(), 2);
            }
        }
        assert_eq!(ai_task_dao::retry_failed(&conn).unwrap(), 2);
        let history = page(&conn, None).unwrap();
        assert_eq!(history.failed_faces, 0);
        assert_eq!(history.retryable, 2);
        assert_eq!(history.entries.len(), 4);
        assert_eq!(history.entries[0].kind, "batch");
        assert_eq!(history.entries[0].photos.len(), 2);
        assert_eq!(history.entries[0].photos[1].attempts, Some(4));
        assert_eq!(history.entries[0].photos[1].path, "D:/Photos/two.jpg");
        assert!(history.entries[0].message.contains("connection reset"));
    }

    #[test]
    fn imports_existing_errors_once() {
        let conn = library();
        conn.execute(
            "UPDATE ai_photo_tasks SET error='old error',attempts=1 WHERE photo_id=1",
            [],
        )
        .unwrap();
        import_legacy_errors(&conn).unwrap();
        import_legacy_errors(&conn).unwrap();
        let history = page(&conn, None).unwrap();
        assert_eq!(history.retryable, 1);
        assert_eq!(history.entries.len(), 1);
        assert_eq!(history.entries[0].photos[0].filename, "one.jpg");
        assert_eq!(history.entries[0].message, "old error");
    }
}
