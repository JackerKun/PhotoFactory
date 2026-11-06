use rusqlite::{params, Connection};

use crate::error::AppResult;

pub const FACE_STAGE: &str = "face_detection";
pub const CLASSIFICATION_STAGE: &str = "classification";

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

pub fn sync_stage_tasks(
    conn: &Connection,
    stage: &str,
    model_version: &str,
    status_column: &str,
) -> AppResult<()> {
    let ts = now();
    let insert = format!(
        "INSERT OR IGNORE INTO ai_photo_tasks(photo_id,stage,model_version,source_fingerprint,status,completed_at,updated_at)
         SELECT id,?1,?2,CAST(file_size AS TEXT)||':'||CAST(file_mtime AS TEXT),
                CASE WHEN {status_column}=1 THEN 'done' ELSE 'pending' END,
                CASE WHEN {status_column}=1 THEN ?3 ELSE NULL END,?3
         FROM photos WHERE deleted=0"
    );
    conn.execute(&insert, params![stage, model_version, ts])?;

    let changed =
        "UPDATE ai_photo_tasks
         SET model_version=?1,
             source_fingerprint=(SELECT CAST(file_size AS TEXT)||':'||CAST(file_mtime AS TEXT) FROM photos WHERE id=photo_id),
             status='pending',attempts=0,lease_until=NULL,error=NULL,started_at=NULL,completed_at=NULL,updated_at=?2
         WHERE stage=?3 AND EXISTS(
             SELECT 1 FROM photos p WHERE p.id=photo_id AND p.deleted=0 AND
             (ai_photo_tasks.source_fingerprint != CAST(p.file_size AS TEXT)||':'||CAST(p.file_mtime AS TEXT)
              OR ai_photo_tasks.model_version != ?1))";
    conn.execute(changed, params![model_version, ts, stage])?;

    let reset = format!(
        "UPDATE ai_photo_tasks SET status='pending',attempts=0,lease_until=NULL,error=NULL,completed_at=NULL,updated_at=?1
         WHERE stage=?2 AND status='done' AND EXISTS(SELECT 1 FROM photos p WHERE p.id=photo_id AND p.deleted=0 AND p.{status_column}=0)"
    );
    conn.execute(&reset, params![ts, stage])?;

    let make_source_pending = format!(
        "UPDATE photos SET {status_column}=0 WHERE deleted=0 AND EXISTS(
             SELECT 1 FROM ai_photo_tasks t WHERE t.photo_id=photos.id AND t.stage=?1 AND t.status='pending')"
    );
    conn.execute(&make_source_pending, [stage])?;

    let completed = format!(
        "UPDATE ai_photo_tasks SET status='done',lease_until=NULL,error=NULL,completed_at=COALESCE(completed_at,?1),updated_at=?1
         WHERE stage=?2 AND status!='done' AND EXISTS(SELECT 1 FROM photos p WHERE p.id=photo_id AND p.deleted=0 AND p.{status_column}=1)"
    );
    conn.execute(&completed, params![ts, stage])?;
    Ok(())
}

pub fn recover_expired_leases(conn: &Connection) -> AppResult<usize> {
    Ok(conn.execute(
        "UPDATE ai_photo_tasks SET status='pending',lease_until=NULL,updated_at=?1
         WHERE status='running' AND COALESCE(lease_until,0)<?1",
        [now()],
    )?)
}

pub fn claim_tasks(conn: &Connection, stage: &str, limit: i64) -> AppResult<Vec<i64>> {
    let ts = now();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE ai_photo_tasks SET status='pending',lease_until=NULL,updated_at=?1
         WHERE stage=?2 AND status='running' AND COALESCE(lease_until,0)<?1",
        params![ts, stage],
    )?;
    let ids = {
        let mut statement = tx.prepare(
            "SELECT t.photo_id FROM ai_photo_tasks t JOIN photos p ON p.id=t.photo_id
             WHERE t.stage=?1 AND t.status='pending' AND t.attempts<3 AND p.deleted=0
             ORDER BY t.photo_id LIMIT ?2",
        )?;
        let mapped = statement.query_map(params![stage, limit.max(1)], |row| row.get(0))?;
        mapped.collect::<Result<Vec<i64>, _>>()?
    };
    for id in &ids {
        tx.execute(
            "UPDATE ai_photo_tasks SET status='running',attempts=attempts+1,lease_until=?1,
             started_at=COALESCE(started_at,?2),updated_at=?2 WHERE photo_id=?3 AND stage=?4",
            params![ts + 600, ts, id, stage],
        )?;
    }
    tx.commit()?;
    Ok(ids)
}

pub fn mark_task_failed(
    conn: &Connection,
    photo_id: i64,
    stage: &str,
    error: &str,
) -> AppResult<()> {
    let attempts: i64 = conn.query_row(
        "SELECT attempts FROM ai_photo_tasks WHERE photo_id=?1 AND stage=?2",
        params![photo_id, stage],
        |row| row.get(0),
    )?;
    conn.execute(
        "UPDATE ai_photo_tasks SET status=?1,lease_until=NULL,error=?2,updated_at=?3
         WHERE photo_id=?4 AND stage=?5",
        params![
            if attempts >= 3 { "failed" } else { "pending" },
            error.chars().take(1000).collect::<String>(),
            now(),
            photo_id,
            stage
        ],
    )?;
    Ok(())
}

pub fn retry_failed(conn: &Connection) -> AppResult<usize> {
    Ok(conn.execute(
        "UPDATE ai_photo_tasks SET status='pending',attempts=0,lease_until=NULL,error=NULL,updated_at=?1 WHERE status='failed'",
        [now()],
    )?)
}

pub fn stage_counts(conn: &Connection, stage: &str) -> AppResult<(i64, i64, i64)> {
    conn.query_row(
        "SELECT COUNT(*),SUM(CASE WHEN status='done' THEN 1 ELSE 0 END),SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END)
         FROM ai_photo_tasks t JOIN photos p ON p.id=t.photo_id WHERE t.stage=?1 AND p.deleted=0",
        [stage],
        |row| Ok((row.get(0)?, row.get::<_, Option<i64>>(1)?.unwrap_or(0), row.get::<_, Option<i64>>(2)?.unwrap_or(0))),
    ).map_err(Into::into)
}

pub fn set_pipeline_state(
    conn: &Connection,
    status: &str,
    stage: &str,
    total: i64,
    processed: i64,
    failed: i64,
    error: Option<&str>,
) -> AppResult<()> {
    let ts = now();
    conn.execute(
        "UPDATE ai_pipeline_state SET status=CASE WHEN status IN('paused','canceled') AND ?1='running' THEN status ELSE ?1 END,stage=?2,total=?3,processed=?4,failed=?5,
         started_at=CASE WHEN status IN('idle','done','canceled') AND ?1='running' THEN ?6 ELSE started_at END,
         stage_started_at=CASE WHEN stage!=?2 OR (status!='running' AND ?1='running') THEN ?6 ELSE stage_started_at END,
         stage_base_processed=CASE WHEN stage!=?2 OR (status!='running' AND ?1='running') THEN ?4 ELSE stage_base_processed END,
         updated_at=?6,last_error=?7 WHERE id=1",
        params![status, stage, total, processed, failed, ts, error],
    )?;
    Ok(())
}

pub fn pipeline_control_status(conn: &Connection) -> AppResult<String> {
    conn.query_row(
        "SELECT status FROM ai_pipeline_state WHERE id=1",
        [],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

pub fn set_pipeline_control(conn: &Connection, status: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE ai_pipeline_state SET status=?1,
         stage_started_at=CASE WHEN ?1='running' AND status!='running' THEN ?2 ELSE stage_started_at END,
         stage_base_processed=CASE WHEN ?1='running' AND status!='running' THEN processed ELSE stage_base_processed END,
         updated_at=?2 WHERE id=1",
        params![status, now()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::CREATE_TABLES;

    #[test]
    fn tasks_resume_from_persisted_photo_status() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CREATE_TABLES).unwrap();
        for id in 1..=3 {
            conn.execute(
                "INSERT INTO photos(id,path,filename,file_size,file_mtime,face_status,imported_at) VALUES(?1,?2,?3,10,20,?4,1)",
                params![id, format!("/{id}.jpg"), format!("{id}.jpg"), if id == 1 { 1 } else { 0 }],
            ).unwrap();
        }
        sync_stage_tasks(&conn, FACE_STAGE, "v1", "face_status").unwrap();
        assert_eq!(stage_counts(&conn, FACE_STAGE).unwrap(), (3, 1, 0));
        let claimed = claim_tasks(&conn, FACE_STAGE, 1).unwrap();
        assert_eq!(claimed, vec![2]);
        conn.execute(
            "UPDATE ai_photo_tasks SET lease_until=0 WHERE photo_id=2",
            [],
        )
        .unwrap();
        assert_eq!(claim_tasks(&conn, FACE_STAGE, 1).unwrap(), vec![2]);
    }

    #[test]
    fn model_change_requeues_completed_photo() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CREATE_TABLES).unwrap();
        conn.execute(
            "INSERT INTO photos(id,path,filename,file_size,file_mtime,face_status,imported_at) VALUES(1,'/1.jpg','1.jpg',10,20,1,1)",
            [],
        ).unwrap();
        sync_stage_tasks(&conn, FACE_STAGE, "v1", "face_status").unwrap();
        sync_stage_tasks(&conn, FACE_STAGE, "v2", "face_status").unwrap();
        let source_status: i64 = conn
            .query_row("SELECT face_status FROM photos WHERE id=1", [], |row| {
                row.get(0)
            })
            .unwrap();
        let task_status: String = conn
            .query_row(
                "SELECT status FROM ai_photo_tasks WHERE photo_id=1 AND stage=?1",
                [FACE_STAGE],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(source_status, 0);
        assert_eq!(task_status, "pending");
    }

    #[test]
    fn repeatedly_failed_task_can_be_explicitly_retried() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(CREATE_TABLES).unwrap();
        conn.execute(
            "INSERT INTO photos(id,path,filename,file_size,file_mtime,face_status,imported_at) VALUES(1,'/1.jpg','1.jpg',10,20,0,1)",
            [],
        ).unwrap();
        sync_stage_tasks(&conn, FACE_STAGE, "v1", "face_status").unwrap();
        for _ in 0..3 {
            assert_eq!(claim_tasks(&conn, FACE_STAGE, 1).unwrap(), vec![1]);
            mark_task_failed(&conn, 1, FACE_STAGE, "bad image").unwrap();
        }
        assert!(claim_tasks(&conn, FACE_STAGE, 1).unwrap().is_empty());
        assert_eq!(stage_counts(&conn, FACE_STAGE).unwrap(), (1, 0, 1));
        assert_eq!(retry_failed(&conn).unwrap(), 1);
        assert_eq!(claim_tasks(&conn, FACE_STAGE, 1).unwrap(), vec![1]);
    }
}
