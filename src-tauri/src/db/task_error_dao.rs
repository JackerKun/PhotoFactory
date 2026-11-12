use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Serialize, Deserialize)]
pub struct ErrorPhoto {
    pub filename: String,
    pub path: String,
    pub attempts: Option<i64>,
}

#[derive(Serialize, Deserialize)]
pub struct TaskErrorGroupKey {
    pub stage: String,
    pub reason: String,
    pub through: i64,
}

#[derive(Serialize)]
pub struct TaskErrorGroup {
    pub key: TaskErrorGroupKey,
    pub message: String,
    pub occurrences: i64,
    pub occurred_at: i64,
}

#[derive(Serialize)]
pub struct TaskErrorPage {
    pub groups: Vec<TaskErrorGroup>,
    pub stages: Vec<String>,
    pub next_before: Option<i64>,
    pub retryable: i64,
    pub failed_faces: i64,
    pub failed_classifications: i64,
    pub ignored_count: i64,
    pub platform: &'static str,
    pub architecture: &'static str,
    pub version: &'static str,
}

#[derive(Serialize)]
pub struct TaskErrorGroupPhoto {
    pub photo_id: Option<i64>,
    pub filename: String,
    pub path: String,
    pub attempts: Option<i64>,
    pub ignored: bool,
    pub can_ignore: bool,
}

#[derive(Serialize)]
pub struct TaskErrorGroupPhotos {
    pub photos: Vec<TaskErrorGroupPhoto>,
    pub next_after: Option<String>,
    pub total: i64,
    pub can_ignore: i64,
}

#[derive(Serialize)]
pub struct IgnoredTaskPhoto {
    pub photo_id: i64,
    pub stage: String,
    pub filename: String,
    pub path: String,
}

#[derive(Serialize)]
pub struct IgnoredTaskPhotos {
    pub photos: Vec<IgnoredTaskPhoto>,
    pub next_offset: Option<i64>,
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

pub fn page(
    conn: &Connection,
    stage: Option<&str>,
    before: Option<i64>,
) -> AppResult<TaskErrorPage> {
    const PAGE_SIZE: usize = 12;
    let mut stmt = conn.prepare(
        "WITH groups AS (
            SELECT stage,reason,MAX(id) AS newest,COUNT(*) AS occurrences,
                   COALESCE(MAX(id) FILTER (WHERE instr(message,char(10))>0),MAX(id)) AS detail_id
            FROM task_error_reasons
            WHERE (?1 IS NULL OR stage=?1)
            GROUP BY stage,reason
         )
         SELECT g.stage,g.reason,g.newest,g.occurrences,d.message,n.occurred_at
         FROM groups g
         JOIN task_error_events d ON d.id=g.detail_id
         JOIN task_error_events n ON n.id=g.newest
         WHERE g.newest < ?2 ORDER BY g.newest DESC LIMIT ?3",
    )?;
    let mut groups = stmt
        .query_map(
            params![stage, before.unwrap_or(i64::MAX), PAGE_SIZE + 1],
            |row| {
                Ok(TaskErrorGroup {
                    key: TaskErrorGroupKey {
                        stage: row.get(0)?,
                        reason: row.get(1)?,
                        through: row.get(2)?,
                    },
                    occurrences: row.get(3)?,
                    message: row.get(4)?,
                    occurred_at: row.get(5)?,
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let has_more = groups.len() > PAGE_SIZE;
    groups.truncate(PAGE_SIZE);
    let next_before = groups
        .last()
        .filter(|_| has_more)
        .map(|group| group.key.through);
    let mut stages_stmt =
        conn.prepare("SELECT DISTINCT stage FROM task_error_events ORDER BY stage")?;
    let stages = stages_stmt
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let (retryable, failed_faces, failed_classifications) = conn.query_row(
        "SELECT COUNT(*) FILTER (WHERE status IN ('pending','running') AND error IS NOT NULL),
                COUNT(*) FILTER (WHERE status='failed' AND stage='face_detection'),
                COUNT(*) FILTER (WHERE status='failed' AND stage='classification')
         FROM active_ai_photo_tasks",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let ignored_count = conn.query_row(
        "SELECT COUNT(*) FROM photo_task_ignores i JOIN photos p ON p.id=i.photo_id WHERE p.deleted=0",
        [],
        |row| row.get(0),
    )?;
    Ok(TaskErrorPage {
        groups,
        stages,
        next_before,
        retryable,
        failed_faces,
        failed_classifications,
        ignored_count,
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        version: env!("CARGO_PKG_VERSION"),
    })
}

// Use the newest event shown to the user as a boundary so a group action never
// includes photos added to the group after it was displayed.
const GROUP_PHOTOS: &str = "
    WITH affected AS (
        SELECT photo.value->>'path' AS path, MAX(photo.value->>'filename') AS filename,
               MAX(photo.value->>'attempts') AS attempts
        FROM task_error_reasons e, json_each(e.photos_json) photo
        WHERE e.stage=?1 AND e.reason=?2 AND e.id<=?3
        GROUP BY photo.value->>'path'
    ), related AS (
        SELECT p.id AS photo_id, a.filename, a.path, a.attempts,
               i.photo_id IS NOT NULL AS ignored,
               CASE
                   WHEN i.photo_id IS NOT NULL THEN 0
                   WHEN ?1='thumbnail' THEN COALESCE(p.thumbnail_status IN (-1,0),0)
                   WHEN ?1 IN ('face_detection','classification') THEN COALESCE(t.status IN ('failed','pending') AND t.error IS NOT NULL
                       AND substr(t.error,1,instr(t.error || char(10),char(10))-1)
                           = substr(?2,1,1000),0)
                   ELSE 0
               END AS can_ignore
        FROM affected a
        LEFT JOIN photos p ON p.path=a.path AND p.deleted=0
        LEFT JOIN photo_task_ignores i ON i.photo_id=p.id AND i.stage=?1
        LEFT JOIN ai_photo_tasks t ON t.photo_id=p.id AND t.stage=?1
    )";

pub fn group_photos(
    conn: &Connection,
    key: &TaskErrorGroupKey,
    after: Option<&str>,
) -> AppResult<TaskErrorGroupPhotos> {
    const PAGE_SIZE: usize = 25;
    let mut stmt = conn.prepare(&format!(
        "{GROUP_PHOTOS}, counted AS (
             SELECT *,COUNT(*) OVER () AS total,SUM(can_ignore) OVER () AS eligible FROM related
         )
         SELECT photo_id,filename,path,attempts,ignored,can_ignore,total,eligible
         FROM counted WHERE (?4 IS NULL OR path>?4) ORDER BY path LIMIT ?5"
    ))?;
    let mut rows = stmt.query(params![
        key.stage,
        key.reason,
        key.through,
        after,
        PAGE_SIZE + 1
    ])?;
    let mut photos = Vec::new();
    let (mut total, mut can_ignore) = (0, 0);
    while let Some(row) = rows.next()? {
        photos.push(TaskErrorGroupPhoto {
            photo_id: row.get(0)?,
            filename: row.get(1)?,
            path: row.get(2)?,
            attempts: row.get(3)?,
            ignored: row.get(4)?,
            can_ignore: row.get(5)?,
        });
        total = row.get(6)?;
        can_ignore = row.get(7)?;
    }
    let has_more = photos.len() > PAGE_SIZE;
    photos.truncate(PAGE_SIZE);
    let next_after = photos
        .last()
        .filter(|_| has_more)
        .map(|photo| photo.path.clone());
    Ok(TaskErrorGroupPhotos {
        photos,
        next_after,
        total,
        can_ignore,
    })
}

pub fn ignore_group_photos(
    conn: &Connection,
    key: &TaskErrorGroupKey,
    photo_id: Option<i64>,
) -> AppResult<usize> {
    Ok(conn.execute(
        &format!(
            "{GROUP_PHOTOS}
             INSERT OR IGNORE INTO photo_task_ignores(photo_id,stage)
             SELECT photo_id,?1 FROM related WHERE can_ignore AND (?4 IS NULL OR photo_id=?4)"
        ),
        params![key.stage, key.reason, key.through, photo_id],
    )?)
}

pub fn ignored_photos(conn: &Connection, offset: i64) -> AppResult<IgnoredTaskPhotos> {
    const PAGE_SIZE: usize = 25;
    let offset = offset.max(0);
    let mut stmt = conn.prepare(
        "SELECT p.id,i.stage,p.filename,p.path
         FROM photo_task_ignores i JOIN photos p ON p.id=i.photo_id
         WHERE p.deleted=0 ORDER BY p.id DESC,i.stage LIMIT ?1 OFFSET ?2",
    )?;
    let mut photos = stmt
        .query_map(params![PAGE_SIZE + 1, offset], |row| {
            Ok(IgnoredTaskPhoto {
                photo_id: row.get(0)?,
                stage: row.get(1)?,
                filename: row.get(2)?,
                path: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let next_offset = (photos.len() > PAGE_SIZE).then_some(offset.saturating_add(PAGE_SIZE as i64));
    photos.truncate(PAGE_SIZE);
    Ok(IgnoredTaskPhotos {
        photos,
        next_offset,
    })
}

pub fn restore_photo(conn: &Connection, stage: &str, photo_id: i64) -> AppResult<usize> {
    Ok(conn.execute(
        "DELETE FROM photo_task_ignores WHERE photo_id=?1 AND stage=?2",
        params![photo_id, stage],
    )?)
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
            assert_eq!(page(&conn, None, None).unwrap().failed_faces, 2);
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
        let history = page(&conn, None, None).unwrap();
        assert_eq!(history.failed_faces, 0);
        assert_eq!(history.retryable, 2);
        assert_eq!(history.groups.len(), 1);
        let group = &history.groups[0];
        assert_eq!(group.occurrences, 4);
        assert!(group.message.contains("connection reset"));
        let photos = group_photos(&conn, &group.key, None).unwrap();
        assert_eq!(photos.total, 2);
        assert_eq!(photos.photos[1].attempts, Some(4));
        assert_eq!(photos.photos[1].path, "D:/Photos/two.jpg");
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
        let history = page(&conn, None, None).unwrap();
        assert_eq!(history.retryable, 1);
        assert_eq!(history.groups.len(), 1);
        let group = &history.groups[0];
        let photos = group_photos(&conn, &group.key, None).unwrap();
        assert_eq!(photos.photos[0].filename, "one.jpg");
        assert_eq!(group.message, "old error");
    }

    #[test]
    fn bulk_ignore_excludes_unseen_failures_and_only_skips_the_selected_stage() {
        let conn = library();
        ai_task_dao::sync_stage_tasks(
            &conn,
            ai_task_dao::CLASSIFICATION_STAGE,
            "test",
            "classification_status",
        )
        .unwrap();
        assert_eq!(
            ai_task_dao::claim_tasks(&conn, FACE_STAGE, 1).unwrap(),
            vec![1]
        );
        ai_task_dao::mark_task_failed(&conn, 1, FACE_STAGE, "connection reset").unwrap();
        record_task_error(&conn, FACE_STAGE, "connection reset").unwrap();
        let page_one = page(&conn, Some(FACE_STAGE), None).unwrap();
        assert_eq!(page_one.groups.len(), 1);
        assert_eq!(page_one.groups[0].occurrences, 2);
        let key = &page_one.groups[0].key;
        assert_eq!(group_photos(&conn, key, None).unwrap().can_ignore, 1);

        assert_eq!(
            ai_task_dao::claim_tasks(&conn, FACE_STAGE, 1).unwrap(),
            vec![2]
        );
        ai_task_dao::mark_task_failed(&conn, 2, FACE_STAGE, "connection reset").unwrap();
        assert_eq!(ignore_group_photos(&conn, key, None).unwrap(), 1);
        assert_eq!(ignore_group_photos(&conn, key, None).unwrap(), 0);
        assert_eq!(
            ai_task_dao::stage_counts(&conn, FACE_STAGE).unwrap(),
            (1, 0, 1)
        );
        assert_eq!(ai_task_dao::retry_failed(&conn).unwrap(), 1);
        assert_eq!(
            ai_task_dao::claim_tasks(&conn, FACE_STAGE, 10).unwrap(),
            vec![2]
        );
        assert_eq!(
            ai_task_dao::claim_tasks(&conn, ai_task_dao::CLASSIFICATION_STAGE, 10).unwrap(),
            vec![1, 2]
        );

        ai_task_dao::sync_stage_tasks(&conn, FACE_STAGE, "updated model", "face_status").unwrap();
        assert_eq!(
            ai_task_dao::claim_tasks(&conn, FACE_STAGE, 10).unwrap(),
            vec![2]
        );
        assert!(group_photos(&conn, key, None).unwrap().photos[0].ignored);
        assert_eq!(ignored_photos(&conn, 0).unwrap().photos[0].photo_id, 1);
        assert_eq!(restore_photo(&conn, FACE_STAGE, 1).unwrap(), 1);
        assert_eq!(
            ai_task_dao::claim_tasks(&conn, FACE_STAGE, 10).unwrap(),
            vec![1]
        );
    }

    #[test]
    fn ignoring_thumbnail_failure_survives_thumbnail_queue_resets() {
        use crate::db::photo_dao;
        let conn = library();
        conn.execute("UPDATE photos SET thumbnail_status=-1 WHERE id=1", [])
            .unwrap();
        record(
            &conn,
            "thumbnail",
            "photo",
            "cannot decode",
            &[ErrorPhoto {
                filename: "one.jpg".into(),
                path: "D:/Photos/one.jpg".into(),
                attempts: None,
            }],
        )
        .unwrap();
        let page = page(&conn, Some("thumbnail"), None).unwrap();
        assert_eq!(
            ignore_group_photos(&conn, &page.groups[0].key, Some(1)).unwrap(),
            1
        );
        conn.execute("UPDATE photos SET thumbnail_status=0 WHERE id=1", [])
            .unwrap();
        assert_eq!(photo_dao::count_pending_thumbnails(&conn).unwrap(), 1);
        assert_eq!(
            photo_dao::get_pending_thumbnails(&conn, 10).unwrap()[0].id,
            Some(2)
        );
        assert_eq!(
            photo_dao::get_thumbnail_rebuild_candidates(&conn).unwrap()[0].0,
            2
        );
        assert_eq!(restore_photo(&conn, "thumbnail", 1).unwrap(), 1);
        assert_eq!(photo_dao::count_pending_thumbnails(&conn).unwrap(), 2);
    }
}
