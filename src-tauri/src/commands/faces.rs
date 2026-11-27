// src-tauri/src/commands/faces.rs
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, State};
use tokio::sync::watch;

use crate::commands::ai::AiWorkerState;
use crate::commands::project::{current_project, get_conn, read_project_db, AppState};
use crate::db::face_dao;
use crate::error::{AppError, AppResult};
use crate::models::{AutomaticFaceMergeProgress, FaceCluster, FaceClusterPage, FaceDetection, Project};
use crate::thumbnail::generator;

const FACE_THUMBNAIL_CACHE_VERSION: &str = "context_v2";

#[derive(Debug, Clone, serde::Serialize)]
pub struct FaceAiVersionStatus {
    current_version: String,
    stored_version: Option<String>,
    upgrade_available: bool,
}

#[tauri::command]
pub async fn cmd_get_photo_faces(
    photo_id: i64,
    state: State<'_, AppState>,
) -> AppResult<Vec<FaceDetection>> {
    read_project_db(current_project(&state)?, move |conn| face_dao::get_visible_faces_for_photo(conn, photo_id)).await
}

#[tauri::command]
pub async fn cmd_get_clusters(state: State<'_, AppState>) -> AppResult<Vec<FaceCluster>> {
    let conn = get_conn(state.clone())?;
    face_dao::get_all_clusters(&conn)
}

#[tauri::command]
pub async fn cmd_get_cluster_page(
    tab: String,
    offset: i64,
    limit: i64,
    cluster_id: Option<i64>,
    state: State<'_, AppState>,
) -> AppResult<FaceClusterPage> {
    read_project_db(current_project(&state)?, move |conn| {
        face_dao::get_cluster_page(conn, &tab, offset, limit, cluster_id)
    }).await
}

#[tauri::command]
pub async fn cmd_get_person_avatar_choices(person_id: i64, after: Option<i64>, state: State<'_, AppState>) -> AppResult<face_dao::AvatarChoicePage> {
    read_project_db(current_project(&state)?, move |conn| face_dao::person_avatar_choices(conn, person_id, after)).await
}

#[tauri::command]
pub async fn cmd_save_person_profile(person_id: i64, name: String, avatar_face_id: Option<i64>, state: State<'_, AppState>) -> AppResult<()> {
    let project = current_project(&state)?;
    tokio::task::spawn_blocking(move || {
        let conn = crate::db::connection::init_db(&project.db_path())?;
        face_dao::save_person_profile(&conn, person_id, &name, avatar_face_id)
    }).await.map_err(|error| AppError::Internal(format!("保存人物资料中断：{error}")))?
}

#[tauri::command]
pub async fn cmd_rename_cluster(
    cluster_id: i64,
    name: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let conn = get_conn(state.clone())?;
    face_dao::rename_cluster(&conn, cluster_id, &name)
}

#[tauri::command]
pub async fn cmd_confirm_face_cluster(
    cluster_id: i64,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let conn = get_conn(state)?;
    face_dao::set_cluster_confidence(&conn, cluster_id, "high")
}

#[tauri::command]
pub async fn cmd_confirm_face_clusters(
    mut cluster_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> AppResult<usize> {
    if cluster_ids.len() > 5000 {
        return Err(AppError::Project("单次最多确认 5000 个人物".into()));
    }
    cluster_ids.sort_unstable();
    cluster_ids.dedup();
    let mut conn = get_conn(state)?;
    let tx = conn.transaction()?;
    for id in &cluster_ids {
        face_dao::set_cluster_confidence(&tx, *id, "high")?;
    }
    tx.commit()?;
    Ok(cluster_ids.len())
}

#[tauri::command]
pub async fn cmd_reassign_photo_face(
    face_id: i64,
    person_id: i64,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let conn = get_conn(state)?;
    face_dao::reassign_face_to_person(&conn, face_id, person_id)
}

#[tauri::command]
pub async fn cmd_create_named_person_for_face(
    face_id: i64,
    name: String,
    state: State<'_, AppState>,
) -> AppResult<i64> {
    let conn = get_conn(state)?;
    face_dao::create_named_person_for_face(&conn, face_id, &name)
}

#[tauri::command]
pub async fn cmd_delete_photo_face(face_id: i64, state: State<'_, AppState>) -> AppResult<()> {
    let conn = get_conn(state)?;
    face_dao::delete_face_detection(&conn, face_id)
}

#[tauri::command]
pub async fn cmd_merge_clusters(
    from_id: i64,
    to_id: i64,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let conn = get_conn(state.clone())?;
    face_dao::merge_clusters(&conn, from_id, to_id)
}

#[tauri::command]
pub async fn cmd_merge_clusters_batch(
    cluster_ids: Vec<i64>,
    name: Option<String>,
    target_cluster_id: Option<i64>,
    state: State<'_, AppState>,
) -> AppResult<i64> {
    let mut ids = cluster_ids;
    ids.sort_unstable();
    ids.dedup();
    if target_cluster_id.is_none() && ids.len() < 2 {
        return Err(AppError::Project(
            "Select at least two people to merge".into(),
        ));
    }
    if target_cluster_id.is_some() && ids.is_empty() {
        return Err(AppError::Project(
            "Select at least one person to merge".into(),
        ));
    }

    let conn = get_conn(state)?;
    let clusters = face_dao::get_all_clusters(&conn)?;
    let target_id = if let Some(target_id) = target_cluster_id {
        clusters
            .iter()
            .any(|cluster| cluster.id == Some(target_id))
            .then_some(target_id)
            .ok_or_else(|| AppError::NotFound("The target person no longer exists".into()))?
    } else {
        clusters
            .iter()
            .filter(|cluster| cluster.id.is_some_and(|id| ids.contains(&id)))
            .max_by_key(|cluster| cluster.face_count)
            .and_then(|cluster| cluster.id)
            .ok_or_else(|| AppError::NotFound("None of the selected people exist".into()))?
    };
    let found = clusters
        .iter()
        .filter(|cluster| cluster.id.is_some_and(|id| ids.contains(&id)))
        .count();
    if found != ids.len() {
        return Err(AppError::NotFound(
            "One or more selected people no longer exist".into(),
        ));
    }

    face_dao::merge_clusters_batch(&conn, target_id, &ids, name.as_deref())?;
    Ok(target_id)
}

/// Internal clustering — called from both the command and the auto-pipeline
pub async fn cmd_run_face_clustering_inner(
    state: State<'_, AppState>,
    worker_state: State<'_, AiWorkerState>,
) -> AppResult<String> {
    cluster_face_batch(&current_project(&state)?, &worker_state, None).await
}

pub async fn cluster_face_batch(
    project: &Project,
    worker_state: &AiWorkerState,
    progress: Option<&(dyn Fn(AutomaticFaceMergeProgress) + Sync)>,
) -> AppResult<String> {
    let conn = crate::db::connection::init_db(&project.db_path())?;

    // Keep empty named groups reserved without recounting each group's photos.
    let existing_ids: std::collections::HashSet<i64> = {
        let mut statement = conn.prepare("SELECT id FROM face_clusters")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        rows.collect::<Result<_, _>>()?
    };

    // One query instead of one query per cluster (the old N+1 path also silently
    // capped each person at 1000 faces, weakening centroids for large libraries).
    let existing: HashMap<String, i64> = face_dao::get_embedding_cluster_prototypes(&conn, 5)?
        .into_iter()
        .collect();
    let memberships: HashMap<String, i64> = face_dao::get_embedding_cluster_assignments(&conn)?
        .into_iter()
        .collect();
    let known_assigned_cluster_ids: std::collections::HashSet<i64> =
        memberships.values().copied().collect();

    // Get unassigned faces
    let unassigned = face_dao::get_unassigned_faces_limited(&conn, 1000)?;

    // Build lookup: embedding_path -> face_id for O(1) access
    let face_id_by_path: std::collections::HashMap<String, i64> = unassigned
        .iter()
        .filter_map(|f| {
            f.embedding_path
                .as_ref()
                .map(|p| (p.clone(), f.id.unwrap_or(0)))
        })
        .collect();
    if unassigned.is_empty() {
        return Ok("No faces to cluster".into());
    }

    // Load constraints
    let must_links = crate::db::constraint_dao::get_must_links(&conn)?;
    let cannot_links = crate::db::constraint_dao::get_cannot_links(&conn)?;

    // Call v2 clustering endpoint with constraints
    let req = crate::models::ClusterFaceV2Request {
        request_id: None,
        embeddings_dir: project.faces_cache_path().to_string_lossy().to_string(),
        existing_clusters: Some(existing),
        threshold: Some(0.6),
        must_links: Some(must_links),
        cannot_links: Some(cannot_links),
        candidate_files: Some(face_id_by_path.keys().cloned().collect()),
        memberships,
        qualities: face_dao::get_unassigned_embedding_qualities(&conn, 1000)?,
    };

    let report_stage = |stage: &str| {
        if let Some(report) = progress {
            report(AutomaticFaceMergeProgress { stage: stage.into(), done: 0, total: 0, skipped: 0 });
        }
    };
    report_stage("load_worker");
    let response = crate::commands::ai::request_worker_batch(
        worker_state,
        true,
        |client| {
            let mut req = req.clone();
            req.request_id = Some(uuid::Uuid::new_v4().to_string());
            async move {
                let clustering = client.cluster_faces_v2(&req);
                let request_id = req.request_id.as_deref().unwrap();
                let poll = async {
                    let mut last = None;
                    let mut updated = std::time::Instant::now();
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        if let Ok(Some(current)) = client.face_progress("cluster_faces_v2", request_id).await {
                            if last.as_ref() != Some(&current) {
                                if let Some(report) = progress {
                                    report(current.clone());
                                }
                                updated = std::time::Instant::now();
                                last = Some(current);
                            }
                        }
                        if let Some(phase) = &last {
                            if matches!(phase.stage.as_str(), "load_clustering" | "run_linkage" | "form_groups")
                                && updated.elapsed().as_secs() >= 120
                            {
                                return Err(AppError::AiWorkerStalled(format!(
                                    "本批人脸分组在 {} 阶段 120 秒没有新进度（请求 {request_id}）",
                                    phase.stage,
                                )));
                            }
                        }
                    }
                };
                tokio::select! {
                    result = clustering => result,
                    stalled = poll => stalled,
                }
            }
        },
        || report_stage("retry_batch"),
    ).await??;
    report_stage("save_groups");

    let mut assigned_count = 0;

    // Ensure all cluster IDs from the response exist in the database.
    // The Python worker assigns new IDs (e.g., 0, 1, 2...) but doesn't
    // create rows in face_clusters, so we must upsert them here.
    // A named person can temporarily have no faces, so its id is absent from
    // `existing_clusters`. Avoid letting a newly generated automatic id collide
    // with that reserved user-owned cluster.
    let mut next_cluster_id = existing_ids
        .iter()
        .chain(response.clusters.values())
        .copied()
        .max()
        .unwrap_or(-1)
        + 1;
    let mut collision_remap = HashMap::new();
    for cluster_id in response.clusters.values().copied() {
        if existing_ids.contains(&cluster_id) && !known_assigned_cluster_ids.contains(&cluster_id) {
            collision_remap.entry(cluster_id).or_insert_with(|| {
                let replacement = next_cluster_id;
                next_cluster_id += 1;
                replacement
            });
        }
    }
    let resolved_cluster_ids: std::collections::HashSet<i64> = response
        .clusters
        .values()
        .map(|cluster_id| {
            collision_remap
                .get(cluster_id)
                .copied()
                .unwrap_or(*cluster_id)
        })
        .collect();
    let new_ids: std::collections::HashSet<i64> = resolved_cluster_ids
        .into_iter()
        .filter(|cid| !existing_ids.contains(cid))
        .collect();
    // Resolve response entries to unassigned database rows, then write all changes
    // in one transaction rather than one UPDATE per face.
    let mut assignments = Vec::new();
    let review_files: std::collections::HashSet<_> = response.review_files.iter().collect();
    for (embedding_file, cluster_id) in &response.clusters {
        if let Some(&face_id) = face_id_by_path.get(embedding_file) {
            let resolved_cluster_id = collision_remap
                .get(cluster_id)
                .copied()
                .unwrap_or(*cluster_id);
            assignments.push((
                face_id,
                resolved_cluster_id,
                review_files.contains(embedding_file),
            ));
            assigned_count += 1;
        }
    }
    let new_ids: Vec<i64> = new_ids.into_iter().collect();
    face_dao::apply_cluster_assignments(&conn, &new_ids, &assignments)?;
    Ok(format!(
        "Clustered {} faces into {} clusters",
        assigned_count,
        assignments
            .iter()
            .map(|(_, id, _)| id)
            .collect::<std::collections::HashSet<_>>()
            .len()
    ))
}

/// The Tauri command wrapper — calls the inner implementation
#[tauri::command]
pub async fn cmd_run_face_clustering(
    state: State<'_, AppState>,
    worker_state: State<'_, AiWorkerState>,
    app: tauri::AppHandle,
) -> AppResult<String> {
    crate::commands::ai::run_manual_face_clustering(current_project(&state)?, worker_state, app, false).await
}

/// Rebuild automatic groups while preserving every user-named person.
#[tauri::command]
pub async fn cmd_rebuild_face_clusters(
    state: State<'_, AppState>,
    worker_state: State<'_, AiWorkerState>,
    app: tauri::AppHandle,
) -> AppResult<String> {
    crate::commands::ai::run_manual_face_clustering(current_project(&state)?, worker_state, app, true).await
}

async fn preview_automatic_merges(
    threshold: f64,
    state: State<'_, AppState>,
    worker_state: State<'_, AiWorkerState>,
    progress: Option<(&tauri::AppHandle, &str)>,
) -> AppResult<crate::models::AutomaticFaceMergeResponse> {
    if !threshold.is_finite() || !(0.35..=0.90).contains(&threshold) {
        return Err(AppError::Project(
            "Automatic merge threshold must be between 0.35 and 0.90".into(),
        ));
    }

    use crate::models::AutomaticFaceMergeProgress;
    let emit = |value: &AutomaticFaceMergeProgress| {
        if let Some((app, request_id)) = progress {
            let _ = app.emit(
                "automatic-face-merge-progress",
                serde_json::json!({
                    "requestId": request_id, "progress": value,
                }),
            );
        }
    };
    emit(&AutomaticFaceMergeProgress {
        stage: "read_database".into(),
        done: 0,
        total: 0,
        skipped: 0,
    });
    let project = current_project(&state)?;
    let embeddings_dir = project.faces_cache_path().to_string_lossy().to_string();
    let (assignments, named, cannot_links) =
        crate::commands::project::read_project_db(project, |conn| {
            let mut assignments = HashMap::new();
            let mut named = HashMap::new();
            for (embedding, id, name) in face_dao::get_automatic_merge_assignments(conn)? {
                assignments.insert(embedding, id);
                if let Some(name) = name {
                    named.entry(id).or_insert(name);
                }
            }
            let cannot_links = crate::db::constraint_dao::get_cannot_links(conn)?;
            Ok((assignments, named, cannot_links))
        })
        .await?;
    if assignments.len() < 2 || !assignments.values().any(|id| !named.contains_key(id)) {
        return Ok(crate::models::AutomaticFaceMergeResponse {
            candidates: Vec::new(),
            skipped: 0,
        });
    }

    let client = {
        let worker = worker_state.client.lock().unwrap();
        worker
            .as_ref()
            .ok_or_else(|| AppError::AiWorker("AI worker not connected".into()))?
            .clone()
    };
    emit(&AutomaticFaceMergeProgress {
        stage: "load_worker".into(),
        done: 0,
        total: 0,
        skipped: 0,
    });
    let request = crate::models::AutomaticFaceMergeRequest {
        request_id: progress.map(|(_, id)| id.to_owned()),
        embeddings_dir,
        unnamed_clusters: assignments,
        named_cluster_ids: named.keys().copied().collect(),
        threshold,
        cannot_links,
    };
    let analysis = client.plan_automatic_face_merges(&request);
    let response = if let Some(request_id) = &request.request_id {
        let report_progress = async {
            let mut last = None;
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                if let Ok(Some(current)) = client.automatic_face_merge_progress(request_id).await {
                    if last.as_ref() != Some(&current) {
                        emit(&current);
                        last = Some(current);
                    }
                }
            }
        };
        tokio::select! {
            result = analysis => result?,
            _ = report_progress => unreachable!(),
        }
    } else {
        analysis.await?
    };
    emit(&AutomaticFaceMergeProgress {
        stage: "done".into(),
        done: 0,
        total: 0,
        skipped: response.skipped,
    });
    let candidates = response
        .candidates
        .into_iter()
        .filter_map(|mut candidate| {
            let mut targets = candidate
                .cluster_ids
                .iter()
                .filter_map(|id| named.get(id).map(|name| (*id, name)));
            let target = targets.next();
            if targets.next().is_some() {
                return None;
            }
            if let Some((id, name)) = target {
                candidate.named_target_id = Some(id);
                candidate.named_target_name = Some(name.clone());
            }
            Some(candidate)
        })
        .collect();
    Ok(crate::models::AutomaticFaceMergeResponse {
        candidates,
        skipped: response.skipped,
    })
}

#[tauri::command]
pub async fn cmd_preview_auto_merge_unnamed_faces(
    threshold: f64,
    request_id: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    worker_state: State<'_, AiWorkerState>,
) -> AppResult<crate::models::AutomaticFaceMergeResponse> {
    let request_id = request_id.filter(|id| uuid::Uuid::parse_str(id).is_ok());
    preview_automatic_merges(
        threshold,
        state,
        worker_state,
        request_id.as_deref().map(|id| (&app, id)),
    )
    .await
}

#[tauri::command]
pub fn cmd_apply_auto_merge_unnamed_faces(
    merge_groups: Vec<Vec<i64>>,
    threshold: f64,
    named_target_ids: Option<Vec<i64>>,
    state: State<'_, AppState>,
) -> AppResult<String> {
    if !threshold.is_finite() || !(0.35..=0.90).contains(&threshold) {
        return Err(AppError::Project(
            "Invalid automatic merge threshold".into(),
        ));
    }
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".into()))?
            .clone()
    };
    let conn = get_conn(state)?;
    let (_operation_id, merged_groups, removed_groups) = face_dao::apply_automatic_merge_groups(
        &conn,
        &merge_groups,
        threshold,
        &named_target_ids.unwrap_or_default(),
    )?;
    if merged_groups == 0 {
        return Ok("选中的候选已变化或存在冲突，没有合并。".into());
    }

    if merged_groups > 0 {
        let cache_dir = project
            .faces_cache_path()
            .parent()
            .unwrap()
            .join("face_thumbnails");
        match std::fs::remove_dir_all(cache_dir) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let skipped = merge_groups.len().saturating_sub(merged_groups);
    let skipped_message = if skipped > 0 {
        format!("另有 {skipped} 组因候选变化或冲突未合并。")
    } else {
        String::new()
    };
    Ok(format!(
        "自动合并了 {merged_groups} 组相似人物，减少 {removed_groups} 个未命名分组。{skipped_message}可从菜单撤销本次操作。"
    ))
}

/// Backwards-compatible one-click path. The UI uses preview + reviewed apply.
#[tauri::command]
pub async fn cmd_auto_merge_unnamed_faces(
    threshold: f64,
    state: State<'_, AppState>,
    worker_state: State<'_, AiWorkerState>,
) -> AppResult<String> {
    let candidates = preview_automatic_merges(threshold, state.clone(), worker_state, None).await?;
    let groups = candidates
        .candidates
        .into_iter()
        .filter(|candidate| candidate.named_target_id.is_none())
        .map(|candidate| candidate.cluster_ids)
        .collect();
    cmd_apply_auto_merge_unnamed_faces(groups, threshold, None, state)
}

#[tauri::command]
pub fn cmd_reject_auto_merge_candidate(
    cluster_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let conn = get_conn(state)?;
    let mut keys = Vec::new();
    for cluster_id in cluster_ids {
        if let Some(key) = face_dao::get_best_face_key_for_cluster(&conn, cluster_id)? {
            keys.push(key);
        }
    }
    for left in 0..keys.len() {
        for right in left + 1..keys.len() {
            crate::db::constraint_dao::add_constraint_by_face_keys(
                &conn,
                keys[left],
                keys[right],
                "cannot_link",
            )?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn cmd_undo_last_automatic_face_merge(state: State<'_, AppState>) -> AppResult<String> {
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".into()))?
            .clone()
    };
    let conn = get_conn(state)?;
    let result = face_dao::undo_last_automatic_merge(&conn)?;
    if result.is_some() {
        let cache_dir = project
            .faces_cache_path()
            .parent()
            .unwrap()
            .join("face_thumbnails");
        let _ = std::fs::remove_dir_all(cache_dir);
    }
    Ok(match result {
        Some((people, faces)) => format!(
            "已撤销上次自动合并，恢复 {} 个人物、{} 张人脸。",
            people, faces
        ),
        None => "没有可以撤销的自动合并。".into(),
    })
}

#[tauri::command]
pub async fn cmd_has_automatic_face_merge_to_undo(state: State<'_, AppState>) -> AppResult<bool> {
    read_project_db(current_project(&state)?, face_dao::has_automatic_merge_to_undo).await
}

/// Get a face thumbnail for a cluster, caching the JPEG to disk.
/// Returns base64-encoded JPEG data URL so the frontend can display it directly.
#[tauri::command]
pub async fn cmd_get_cluster_face_thumbnail(
    cluster_id: i64,
    use_person_avatar: Option<bool>,
    state: State<'_, AppState>,
) -> AppResult<String> {
    cluster_face_thumbnail(current_project(&state)?, cluster_id, use_person_avatar.unwrap_or(true), false)
        .await?
        .ok_or_else(|| AppError::NotFound("头像缩略图不可用".into()))
}

#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FaceThumbnailRequest {
    Cluster { id: i64, #[serde(rename = "usePersonAvatar")] use_person_avatar: bool },
    Face { id: i64 },
}

#[derive(Clone, Default, serde::Serialize)]
pub struct FaceThumbnailResult {
    url: Option<String>,
    error: Option<String>,
}

#[derive(Default)]
struct FaceThumbnailBatches {
    active: HashMap<String, watch::Sender<bool>>,
    canceled_before_start: VecDeque<String>,
}

impl FaceThumbnailBatches {
    fn start(&mut self, id: &str) -> Option<watch::Receiver<bool>> {
        if let Some(index) = self.canceled_before_start.iter().position(|key| key == id) {
            self.canceled_before_start.remove(index);
            return None;
        }
        let (sender, receiver) = watch::channel(false);
        self.active.insert(id.to_owned(), sender);
        Some(receiver)
    }

    fn cancel(&mut self, id: String) {
        if let Some(sender) = self.active.get(&id) {
            let _ = sender.send(true);
        } else {
            // Async commands can be scheduled out of order, including around completion.
            if self.canceled_before_start.len() >= 128 {
                self.canceled_before_start.pop_front();
            }
            self.canceled_before_start.push_back(id);
        }
    }
}

fn face_thumbnail_batches() -> &'static Mutex<FaceThumbnailBatches> {
    static BATCHES: OnceLock<Mutex<FaceThumbnailBatches>> = OnceLock::new();
    BATCHES.get_or_init(|| Mutex::new(FaceThumbnailBatches::default()))
}

struct ActiveFaceThumbnailBatch(String);

impl Drop for ActiveFaceThumbnailBatch {
    fn drop(&mut self) {
        face_thumbnail_batches().lock().unwrap().active.remove(&self.0);
    }
}

#[tauri::command]
pub fn cmd_cancel_face_thumbnail_batch(batch_id: String) {
    face_thumbnail_batches().lock().unwrap().cancel(batch_id);
}

#[tauri::command]
pub async fn cmd_get_face_thumbnail_batch(
    requests: Vec<FaceThumbnailRequest>,
    cache_only: bool,
    batch_id: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<FaceThumbnailResult>> {
    if requests.len() > 32 {
        return Err(AppError::Project("单批最多读取 32 张头像。".into()));
    }
    let receiver = face_thumbnail_batches().lock().unwrap().start(&batch_id);
    let Some(mut canceled) = receiver else {
        return Ok(Vec::new());
    };
    let _active_batch = ActiveFaceThumbnailBatch(batch_id);
    let project = current_project(&state)?;
    tokio::select! {
        biased;
        _ = canceled.changed() => Ok(Vec::new()),
        results = read_face_thumbnail_batch(project, requests, cache_only) => results,
    }
}

async fn read_face_thumbnail_batch(
    project: Project,
    requests: Vec<FaceThumbnailRequest>,
    cache_only: bool,
) -> AppResult<Vec<FaceThumbnailResult>> {
    let mut results = vec![FaceThumbnailResult::default(); requests.len()];
    let mut tasks = tokio::task::JoinSet::new();
    for (index, request) in requests.into_iter().enumerate() {
        let project = project.clone();
        tasks.spawn(async move {
            let result = match request {
                FaceThumbnailRequest::Cluster { id, use_person_avatar } =>
                    cluster_face_thumbnail(project, id, use_person_avatar, cache_only).await,
                FaceThumbnailRequest::Face { id } => face_thumbnail(project, id, cache_only).await,
            };
            (index, result)
        });
    }
    while let Some(task) = tasks.join_next().await {
        let (index, result) = task.map_err(|error| AppError::Internal(format!("头像批次中断：{error}")))?;
        results[index] = match result {
            Ok(url) => FaceThumbnailResult { url, error: None },
            Err(error) => FaceThumbnailResult { url: None, error: Some(error.to_string()) },
        };
    }
    Ok(results)
}

async fn cluster_face_thumbnail(
    project: Project,
    cluster_id: i64,
    use_person_avatar: bool,
    cache_only: bool,
) -> AppResult<Option<String>> {
    let cache_dir = project
        .faces_cache_path()
        .parent()
        .unwrap()
        .join("face_thumbnails");
    let preferred = if use_person_avatar {
        read_project_db(project.clone(), move |conn| {
            face_dao::person_avatar_face_id(conn, cluster_id)?
                .map(|id| face_dao::get_face_by_id(conn, id))
                .transpose()
        }).await?
    } else {
        None
    };
    if let Some(face) = preferred {
        if let Ok(url) = individual_face_thumbnail(project.clone(), face, 160, cache_only).await {
            return Ok(url);
        }
    }
    let cache_path = cache_dir.join(format!("cluster_{cluster_id}_{FACE_THUMBNAIL_CACHE_VERSION}.jpg"));
    cached_face_thumbnail(project, cache_path, 160, cache_only, move |conn| {
        face_dao::get_faces_for_person(conn, cluster_id, 3)
    })
    .await
}

async fn cached_face_thumbnail(
    project: crate::models::Project,
    cache_path: std::path::PathBuf,
    size: u32,
    cache_only: bool,
    faces: impl FnOnce(&rusqlite::Connection) -> AppResult<Vec<FaceDetection>> + Send + 'static,
) -> AppResult<Option<String>> {
    use base64::Engine;
    use rusqlite::OptionalExtension;
    use std::io::Write;

    let data_url = |bytes: &[u8]| {
        format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    };
    if let Ok(bytes) = tokio::fs::read(&cache_path).await {
        if !bytes.is_empty() {
            return Ok(Some(data_url(&bytes)));
        }
    }

    if cache_only {
        return Ok(None);
    }

    static SLOTS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    let slots = SLOTS.get_or_init(|| {
        let cores = std::thread::available_parallelism().map_or(4, |value| value.get());
        tokio::sync::Semaphore::new((cores / 2).clamp(4, 6))
    });
    let permit = slots
        .acquire()
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if let Ok(bytes) = std::fs::read(&cache_path) {
            if !bytes.is_empty() {
                return Ok(Some(data_url(&bytes)));
            }
        }
        let candidates = {
            let conn = crate::db::connection::open_read_db(&project.db_path())?;
            faces(&conn)?
                .into_iter()
                .map(|face| {
                    let path = conn.query_row(
                        "SELECT path FROM photos WHERE id = ?1 AND deleted = 0",
                        [face.photo_id],
                        |row| row.get::<_, String>(0),
                    ).optional()?;
                    Ok(path.map(|path| (face, path)))
                })
                .collect::<AppResult<Vec<_>>>()?
        };
        let mut last_error = AppError::NotFound("没有可用的人脸照片".into());
        for (face, path) in candidates.into_iter().flatten() {
            match generator::generate_face_thumbnail(
                std::path::Path::new(&path),
                face.bbox_x.max(0) as u32,
                face.bbox_y.max(0) as u32,
                face.bbox_w.max(1) as u32,
                face.bbox_h.max(1) as u32,
                size,
            ) {
                Ok(bytes) => {
                    let directory = cache_path.parent().unwrap();
                    std::fs::create_dir_all(directory)?;
                    let mut temp = tempfile::NamedTempFile::new_in(directory)?;
                    temp.write_all(&bytes)?;
                    temp.persist(cache_path).map_err(|error| error.error)?;
                    return Ok(Some(data_url(&bytes)));
                }
                Err(error) => last_error = error,
            }
        }
        Err(last_error)
    })
    .await
    .map_err(|error| AppError::Internal(format!("人脸缩略图任务中断：{error}")))?
}

#[tauri::command]
pub async fn cmd_add_face_constraint(
    photo_id_1: i64,
    face_index_1: i32,
    photo_id_2: i64,
    face_index_2: i32,
    constraint_type: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let conn = get_conn(state)?;
    crate::db::constraint_dao::add_constraint(
        &conn,
        photo_id_1,
        face_index_1,
        photo_id_2,
        face_index_2,
        &constraint_type,
    )?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_remove_face_constraint(
    constraint_id: i64,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let conn = get_conn(state)?;
    crate::db::constraint_dao::remove_constraint(&conn, constraint_id)?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_get_person_detail(
    person_id: i64,
    state: State<'_, AppState>,
) -> AppResult<crate::models::PersonDetail> {
    let conn = get_conn(state)?;
    face_dao::get_person_details(&conn, person_id)?
        .ok_or_else(|| AppError::NotFound(format!("Person {} not found", person_id)))
}

#[tauri::command]
pub async fn cmd_get_person_timeline(
    person_id: i64,
    state: State<'_, AppState>,
) -> AppResult<Vec<(String, i64)>> {
    let conn = get_conn(state)?;
    face_dao::get_person_timeline(&conn, person_id)
}

#[tauri::command]
pub async fn cmd_get_person_scene_tags(
    person_id: i64,
    state: State<'_, AppState>,
) -> AppResult<Vec<(String, i64)>> {
    let conn = get_conn(state)?;
    face_dao::get_person_scene_tags(&conn, person_id)
}

#[tauri::command]
pub async fn cmd_split_person(
    person_id: i64,
    face_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> AppResult<i64> {
    let conn = get_conn(state)?;
    face_dao::split_person(&conn, person_id, &face_ids)
}

/// Get total face detection count (including unclustered faces).
#[tauri::command]
pub async fn cmd_get_face_detection_count(state: State<'_, AppState>) -> AppResult<i64> {
    read_project_db(current_project(&state)?, face_dao::get_face_detection_count).await
}

/// Get count of faces detected but not yet assigned to a person.
#[tauri::command]
pub async fn cmd_get_unassigned_face_count(state: State<'_, AppState>) -> AppResult<i64> {
    read_project_db(current_project(&state)?, face_dao::get_unassigned_face_count).await
}

#[tauri::command]
pub fn cmd_get_suspected_faces(
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> AppResult<Vec<face_dao::SuspectedFace>> {
    let conn = get_conn(state)?;
    face_dao::get_suspected_faces(&conn, limit.unwrap_or(200).clamp(1, 500))
}

#[tauri::command]
pub async fn cmd_get_suspected_face_count(state: State<'_, AppState>) -> AppResult<i64> {
    read_project_db(current_project(&state)?, face_dao::get_suspected_face_count).await
}

#[tauri::command]
pub async fn cmd_ignore_face_clusters(
    cluster_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let project = current_project(&state)?;
    tokio::task::spawn_blocking(move || {
        let conn = crate::db::connection::init_db(&project.db_path())?;
        let (groups, faces) = face_dao::ignore_automatic_clusters(&conn, &cluster_ids)?;
        let cache_dir = project.faces_cache_path().parent().unwrap().join("face_thumbnails");
        for id in cluster_ids {
            let _ = std::fs::remove_file(cache_dir.join(format!("cluster_{id}_{FACE_THUMBNAIL_CACHE_VERSION}.jpg")));
        }
        Ok(format!(
            "已取消识别 {groups} 个人物分组、{faces} 张人脸。原始照片保留，可从人物操作菜单恢复。"
        ))
    }).await.map_err(|error| AppError::Internal(format!("取消识别中断：{error}")))?
}

#[tauri::command]
pub async fn cmd_get_ignored_face_count(state: State<'_, AppState>) -> AppResult<i64> {
    read_project_db(current_project(&state)?, face_dao::get_ignored_face_count).await
}

#[tauri::command]
pub fn cmd_restore_all_ignored_faces(state: State<'_, AppState>) -> AppResult<String> {
    let conn = get_conn(state)?;
    let restored = face_dao::restore_all_ignored_faces(&conn)?;
    Ok(format!(
        "已恢复 {} 张人脸，它们将在下次人物整理时重新分组。",
        restored
    ))
}

#[tauri::command]
pub fn cmd_keep_suspected_face(face_id: i64, state: State<'_, AppState>) -> AppResult<()> {
    let conn = get_conn(state)?;
    face_dao::keep_suspected_face(&conn, face_id)
}

#[tauri::command]
pub fn cmd_delete_all_suspected_faces(state: State<'_, AppState>) -> AppResult<usize> {
    let conn = get_conn(state)?;
    face_dao::delete_all_suspected_faces(&conn)
}

#[tauri::command]
pub async fn cmd_get_face_thumbnail(face_id: i64, state: State<'_, AppState>) -> AppResult<String> {
    face_thumbnail(current_project(&state)?, face_id, false)
        .await?
        .ok_or_else(|| AppError::NotFound("头像缩略图不可用".into()))
}

async fn face_thumbnail(project: Project, face_id: i64, cache_only: bool) -> AppResult<Option<String>> {
    let face = read_project_db(project.clone(), move |conn| face_dao::get_face_by_id(conn, face_id)).await?;
    individual_face_thumbnail(project, face, 128, cache_only).await
}

async fn individual_face_thumbnail(project: Project, face: FaceDetection, size: u32, cache_only: bool) -> AppResult<Option<String>> {
    // A deleted face's SQLite row ID can be reused, and reanalysis can change a crop.
    let key = format!("face_{}_{}_{}_{}_{}_{}_{}_{size}_{FACE_THUMBNAIL_CACHE_VERSION}.jpg",
        face.id.unwrap_or_default(), face.photo_id, face.created_at, face.bbox_x, face.bbox_y, face.bbox_w, face.bbox_h);
    let cache_path = project.faces_cache_path().join("thumbnails").join(key);
    cached_face_thumbnail(project, cache_path, size, cache_only, move |_| Ok(vec![face])).await
}

#[tauri::command]
pub async fn cmd_get_face_ai_version_status(state: State<'_, AppState>) -> AppResult<FaceAiVersionStatus> {
    read_project_db(current_project(&state)?, |conn| {
        let stored = face_dao::get_ai_model_version(conn, "face_pipeline")?;
        let face_count = face_dao::get_face_detection_count(conn)?;
        Ok(FaceAiVersionStatus {
            upgrade_available: face_count > 0
                && stored.as_deref() != Some(crate::commands::ai::FACE_PIPELINE_VERSION),
            current_version: crate::commands::ai::FACE_PIPELINE_VERSION.into(),
            stored_version: stored,
        })
    }).await
}

#[tauri::command]
pub async fn cmd_prepare_face_ai_reanalysis(
    state: State<'_, AppState>,
    worker_state: State<'_, AiWorkerState>,
) -> AppResult<String> {
    let project = current_project(&state)?;
    let _lease = crate::commands::ai::AiPipelineLease::acquire(&worker_state.pipeline_running)?;
    crate::commands::ai::cmd_start_ai_worker(worker_state.port, None, worker_state.clone()).await?;
    let conn = crate::db::connection::init_db(&project.db_path())?;
    let removed = face_dao::prepare_face_reanalysis(&conn)?;
    let cache_dir = project
        .faces_cache_path()
        .parent()
        .unwrap()
        .join("face_thumbnails");
    let _ = std::fs::remove_dir_all(cache_dir);
    Ok(format!(
        "已保留所有已命名人物，并将 {} 个自动检测结果加入重新分析队列。",
        removed
    ))
}

#[cfg(test)]
mod face_thumbnail_batch_tests {
    use super::*;

    #[tokio::test]
    async fn cancels_a_batch_before_or_after_native_registration() {
        let mut registry = FaceThumbnailBatches::default();
        registry.cancel("early".into());
        assert!(registry.start("early").is_none());
        let mut active = registry.start("active").unwrap();
        let next = registry.start("next").unwrap();
        registry.cancel("active".into());
        active.changed().await.unwrap();
        assert!(*active.borrow_and_update());
        assert!(!*next.borrow());
    }

    #[tokio::test]
    async fn returns_cached_and_generated_avatars_in_input_order() {
        let dir = tempfile::tempdir().unwrap();
        let project = Project::new("fixture".into(), dir.path().to_string_lossy().into());
        let source = dir.path().join("portrait.png");
        image::RgbImage::from_pixel(80, 80, image::Rgb([40, 50, 200])).save(&source).unwrap();
        let conn = crate::db::connection::init_db(&project.db_path()).unwrap();
        conn.execute(
            "INSERT INTO photos (id, path, filename, file_size, file_mtime, imported_at) VALUES (1, ?1, 'portrait.png', 1, 1, 1)",
            [source.to_string_lossy().as_ref()],
        ).unwrap();
        conn.execute_batch(
            "INSERT INTO face_clusters (id, face_count, created_at) VALUES (1, 1, 1);
             INSERT INTO face_detections (id, photo_id, person_id, bbox_x, bbox_y, bbox_w, bbox_h, created_at)
             VALUES (8, 1, 1, 10, 10, 40, 40, 1);",
        ).unwrap();
        let batch = || vec![
            FaceThumbnailRequest::Cluster { id: 1, use_person_avatar: false },
            FaceThumbnailRequest::Face { id: 8 },
            FaceThumbnailRequest::Cluster { id: 999, use_person_avatar: false },
        ];
        let cold = read_face_thumbnail_batch(project.clone(), batch(), true).await.unwrap();
        assert!(cold.iter().all(|result| result.url.is_none() && result.error.is_none()));
        let generated = read_face_thumbnail_batch(project.clone(), batch(), false).await.unwrap();
        assert!(generated[..2].iter().all(|result| result.url.as_deref().unwrap().starts_with("data:image/jpeg;base64,")));
        assert!(generated[2].error.is_some());
        std::fs::remove_file(source).unwrap();
        let warm = read_face_thumbnail_batch(project, batch(), true).await.unwrap();
        assert_eq!(warm[0].url, generated[0].url);
        assert_eq!(warm[1].url, generated[1].url);
        assert!(warm[2].url.is_none() && warm[2].error.is_none());
    }
}
