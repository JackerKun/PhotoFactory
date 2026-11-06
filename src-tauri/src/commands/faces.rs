// src-tauri/src/commands/faces.rs
use std::collections::HashMap;
use tauri::State;

use crate::commands::ai::AiWorkerState;
use crate::commands::project::{get_conn, AppState};
use crate::db::face_dao;
use crate::db::photo_dao;
use crate::error::{AppError, AppResult};
use crate::models::{FaceCluster, FaceClusterPage, FaceDetection};
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
    let conn = get_conn(state.clone())?;
    face_dao::get_faces_for_photo(&conn, photo_id)
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
    state: State<'_, AppState>,
) -> AppResult<FaceClusterPage> {
    let conn = get_conn(state)?;
    face_dao::get_cluster_page(&conn, &tab, offset, limit)
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
    let conn = get_conn(state.clone())?;
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| crate::error::AppError::Project("No project open".into()))?
            .clone()
    };

    // Get existing clusters
    let clusters = face_dao::get_all_clusters(&conn)?;

    // One query instead of one query per cluster (the old N+1 path also silently
    // capped each person at 1000 faces, weakening centroids for large libraries).
    let existing: HashMap<String, i64> = face_dao::get_embedding_cluster_prototypes(&conn, 3)?
        .into_iter()
        .collect();
    let known_assigned_cluster_ids: std::collections::HashSet<i64> =
        existing.values().copied().collect();

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
    if unassigned.is_empty() && existing.is_empty() {
        return Ok("No faces to cluster".into());
    }

    // Load constraints
    let must_links = crate::db::constraint_dao::get_must_links(&conn)?;
    let cannot_links = crate::db::constraint_dao::get_cannot_links(&conn)?;

    // Get AI worker client
    let client = {
        let worker = worker_state.client.lock().unwrap();
        worker
            .as_ref()
            .ok_or_else(|| crate::error::AppError::AiWorker("AI worker not connected".into()))?
            .clone()
    };

    // Call v2 clustering endpoint with constraints
    let req = crate::models::ClusterFaceV2Request {
        embeddings_dir: project.faces_cache_path().to_string_lossy().to_string(),
        existing_clusters: Some(existing),
        threshold: Some(0.6),
        must_links: Some(must_links),
        cannot_links: Some(cannot_links),
        candidate_files: Some(face_id_by_path.keys().cloned().collect()),
    };

    let response = client.cluster_faces_v2(&req).await?;

    let mut assigned_count = 0;

    // Ensure all cluster IDs from the response exist in the database.
    // The Python worker assigns new IDs (e.g., 0, 1, 2...) but doesn't
    // create rows in face_clusters, so we must upsert them here.
    let existing_ids: std::collections::HashSet<i64> =
        clusters.iter().filter_map(|c| c.id).collect();
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
    for (embedding_file, cluster_id) in &response.clusters {
        if let Some(&face_id) = face_id_by_path.get(embedding_file) {
            let resolved_cluster_id = collision_remap
                .get(cluster_id)
                .copied()
                .unwrap_or(*cluster_id);
            assignments.push((face_id, resolved_cluster_id));
            assigned_count += 1;
        }
    }
    let new_ids: Vec<i64> = new_ids.into_iter().collect();
    face_dao::apply_cluster_assignments(&conn, &new_ids, &assignments)?;
    Ok(format!(
        "Clustered {} faces into {} clusters",
        assigned_count,
        response.clusters.len()
    ))
}

/// The Tauri command wrapper — calls the inner implementation
#[tauri::command]
pub async fn cmd_run_face_clustering(
    state: State<'_, AppState>,
    worker_state: State<'_, AiWorkerState>,
) -> AppResult<String> {
    let mut total = 0i64;
    loop {
        let before = face_dao::get_unassigned_face_count(&get_conn(state.clone())?)?;
        if before == 0 {
            break;
        }
        cmd_run_face_clustering_inner(state.clone(), worker_state.clone()).await?;
        let after = face_dao::get_unassigned_face_count(&get_conn(state.clone())?)?;
        total += before - after;
        if after == 0 || after >= before {
            break;
        }
    }
    Ok(format!("Clustered {total} pending faces incrementally"))
}

/// Rebuild automatic groups while preserving every user-named person.
#[tauri::command]
pub async fn cmd_rebuild_face_clusters(
    state: State<'_, AppState>,
    worker_state: State<'_, AiWorkerState>,
) -> AppResult<String> {
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".into()))?
            .clone()
    };
    let reset_count = {
        let conn = get_conn(state.clone())?;
        face_dao::reset_automatic_clusters(&conn)?
    };

    // Cluster ids can be reused, so old cached crops must not survive a rebuild.
    let face_thumbnail_dir = project
        .faces_cache_path()
        .parent()
        .unwrap()
        .join("face_thumbnails");
    match std::fs::remove_dir_all(&face_thumbnail_dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    let result = cmd_run_face_clustering_inner(state, worker_state).await?;
    Ok(format!(
        "Reset {} automatic face assignments. {}",
        reset_count, result
    ))
}

async fn preview_automatic_merges(
    threshold: f64,
    state: State<'_, AppState>,
    worker_state: State<'_, AiWorkerState>,
) -> AppResult<Vec<crate::models::AutomaticFaceMergeCandidate>> {
    if !threshold.is_finite() || !(0.60..=0.90).contains(&threshold) {
        return Err(AppError::Project(
            "Automatic merge threshold must be between 0.60 and 0.90".into(),
        ));
    }

    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".into()))?
            .clone()
    };
    let unnamed: HashMap<String, i64> = {
        let conn = get_conn(state.clone())?;
        face_dao::get_unnamed_embedding_cluster_assignments(&conn)?
            .into_iter()
            .collect()
    };
    if unnamed.len() < 2 {
        return Ok(Vec::new());
    }

    let client = {
        let worker = worker_state.client.lock().unwrap();
        worker
            .as_ref()
            .ok_or_else(|| AppError::AiWorker("AI worker not connected".into()))?
            .clone()
    };
    let response = client
        .plan_automatic_face_merges(&crate::models::AutomaticFaceMergeRequest {
            embeddings_dir: project.faces_cache_path().to_string_lossy().to_string(),
            unnamed_clusters: unnamed,
            threshold,
            cannot_links: {
                let conn = get_conn(state.clone())?;
                crate::db::constraint_dao::get_cannot_links(&conn)?
            },
        })
        .await?;
    Ok(response.candidates)
}

#[tauri::command]
pub async fn cmd_preview_auto_merge_unnamed_faces(
    threshold: f64,
    state: State<'_, AppState>,
    worker_state: State<'_, AiWorkerState>,
) -> AppResult<Vec<crate::models::AutomaticFaceMergeCandidate>> {
    preview_automatic_merges(threshold, state, worker_state).await
}

#[tauri::command]
pub fn cmd_apply_auto_merge_unnamed_faces(
    merge_groups: Vec<Vec<i64>>,
    threshold: f64,
    state: State<'_, AppState>,
) -> AppResult<String> {
    if !threshold.is_finite() || !(0.60..=0.90).contains(&threshold) {
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
    let (_operation_id, merged_groups, removed_groups) =
        face_dao::apply_automatic_merge_groups(&conn, &merge_groups, threshold)?;

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
    Ok(format!(
        "自动合并了 {} 组相似人物，减少 {} 个未命名分组。可从菜单撤销本次操作。",
        merged_groups, removed_groups
    ))
}

/// Backwards-compatible one-click path. The UI uses preview + reviewed apply.
#[tauri::command]
pub async fn cmd_auto_merge_unnamed_faces(
    threshold: f64,
    state: State<'_, AppState>,
    worker_state: State<'_, AiWorkerState>,
) -> AppResult<String> {
    let candidates = preview_automatic_merges(threshold, state.clone(), worker_state).await?;
    let groups = candidates
        .into_iter()
        .map(|candidate| candidate.cluster_ids)
        .collect();
    cmd_apply_auto_merge_unnamed_faces(groups, threshold, state)
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
pub fn cmd_has_automatic_face_merge_to_undo(state: State<'_, AppState>) -> AppResult<bool> {
    let conn = get_conn(state)?;
    face_dao::has_automatic_merge_to_undo(&conn)
}

/// Get a face thumbnail for a cluster, caching the JPEG to disk.
/// Returns base64-encoded JPEG data URL so the frontend can display it directly.
#[tauri::command]
pub async fn cmd_get_cluster_face_thumbnail(
    cluster_id: i64,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let conn = get_conn(state.clone())?;
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".into()))?
            .clone()
    };

    // Get the first face assigned to this cluster
    let faces = face_dao::get_faces_for_person(&conn, cluster_id, 1)?;
    let face = faces
        .into_iter()
        .next()
        .ok_or_else(|| AppError::NotFound("No faces in this cluster".into()))?;

    // Get the photo path
    let photo = photo_dao::get_photo_by_id(&conn, face.photo_id)?
        .ok_or_else(|| AppError::NotFound(format!("Photo {} not found", face.photo_id)))?;

    // Build cache path: .pf/ai_cache/face_thumbnails/
    let cache_dir = project
        .faces_cache_path()
        .parent()
        .unwrap()
        .join("face_thumbnails");
    std::fs::create_dir_all(&cache_dir)?;
    let thumb_path = cache_dir.join(format!(
        "cluster_{}_{}.jpg",
        cluster_id, FACE_THUMBNAIL_CACHE_VERSION
    ));

    // Try to read cached file first
    if thumb_path.exists() {
        let data = std::fs::read(&thumb_path)?;
        println!(
            "Face thumb: cluster {} returning cached thumb ({} bytes)",
            cluster_id,
            data.len()
        );
        return Ok(format!(
            "data:image/jpeg;base64,{}",
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &data)
        ));
    }

    // Generate and save
    let photo_path = std::path::Path::new(&photo.path);
    println!(
        "Face thumb: cluster={} photo_id={} photo_path={:?} bbox=({},{},{},{}) img_size=({}x{})",
        cluster_id,
        face.photo_id,
        photo.path,
        face.bbox_x,
        face.bbox_y,
        face.bbox_w,
        face.bbox_h,
        photo.width.unwrap_or(0),
        photo.height.unwrap_or(0)
    );

    let jpeg_bytes = generator::generate_face_thumbnail(
        photo_path,
        face.bbox_x as u32,
        face.bbox_y as u32,
        face.bbox_w as u32,
        face.bbox_h as u32,
        160,
    );

    match jpeg_bytes {
        Ok(bytes) => {
            println!(
                "Face thumb: cluster {} generated {} bytes",
                cluster_id,
                bytes.len()
            );
            std::fs::write(&thumb_path, &bytes)?;
            Ok(format!(
                "data:image/jpeg;base64,{}",
                base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes)
            ))
        }
        Err(e) => {
            eprintln!(
                "Face thumb generation FAILED for cluster {}: {}",
                cluster_id, e
            );
            Err(e)
        }
    }
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
    let conn = get_conn(state)?;
    face_dao::get_face_detection_count(&conn)
}

/// Get count of faces detected but not yet assigned to a person.
#[tauri::command]
pub async fn cmd_get_unassigned_face_count(state: State<'_, AppState>) -> AppResult<i64> {
    let conn = get_conn(state)?;
    face_dao::get_unassigned_face_count(&conn)
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
pub fn cmd_get_suspected_face_count(state: State<'_, AppState>) -> AppResult<i64> {
    let conn = get_conn(state)?;
    face_dao::get_suspected_face_count(&conn)
}

#[tauri::command]
pub fn cmd_ignore_face_clusters(
    cluster_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".into()))?
            .clone()
    };
    let conn = get_conn(state)?;
    let (groups, faces) = face_dao::ignore_automatic_clusters(&conn, &cluster_ids)?;
    let cache_dir = project
        .faces_cache_path()
        .parent()
        .unwrap()
        .join("face_thumbnails");
    let _ = std::fs::remove_dir_all(cache_dir);
    Ok(format!(
        "已忽略 {} 个人物分组、{} 张人脸；原始照片未删除，后续 AI 整理不会再次标记。",
        groups, faces
    ))
}

#[tauri::command]
pub fn cmd_get_ignored_face_count(state: State<'_, AppState>) -> AppResult<i64> {
    let conn = get_conn(state)?;
    face_dao::get_ignored_face_count(&conn)
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
pub fn cmd_get_face_thumbnail(face_id: i64, state: State<'_, AppState>) -> AppResult<String> {
    let project = state
        .project
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| AppError::Project("No project open".into()))?;
    let cache_dir = project.faces_cache_path().join("thumbnails");
    let cache_path = cache_dir.join(format!("face_{face_id}_{FACE_THUMBNAIL_CACHE_VERSION}.jpg"));
    if let Ok(bytes) = std::fs::read(&cache_path) {
        return Ok(format!(
            "data:image/jpeg;base64,{}",
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)
        ));
    }
    let conn = get_conn(state)?;
    let face = face_dao::get_face_by_id(&conn, face_id)?;
    let photo = photo_dao::get_photo_by_id(&conn, face.photo_id)?
        .ok_or_else(|| AppError::NotFound(format!("Photo {} not found", face.photo_id)))?;
    let bytes = generator::generate_face_thumbnail(
        std::path::Path::new(&photo.path),
        face.bbox_x.max(0) as u32,
        face.bbox_y.max(0) as u32,
        face.bbox_w.max(1) as u32,
        face.bbox_h.max(1) as u32,
        128,
    )?;
    std::fs::create_dir_all(&cache_dir)?;
    std::fs::write(cache_path, &bytes)?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes)
    ))
}

#[tauri::command]
pub fn cmd_get_face_ai_version_status(
    state: State<'_, AppState>,
) -> AppResult<FaceAiVersionStatus> {
    let conn = get_conn(state)?;
    let stored = face_dao::get_ai_model_version(&conn, "face_pipeline")?;
    let face_count = face_dao::get_face_detection_count(&conn)?;
    Ok(FaceAiVersionStatus {
        upgrade_available: face_count > 0
            && stored.as_deref() != Some(crate::commands::ai::FACE_PIPELINE_VERSION),
        current_version: crate::commands::ai::FACE_PIPELINE_VERSION.into(),
        stored_version: stored,
    })
}

#[tauri::command]
pub fn cmd_prepare_face_ai_reanalysis(state: State<'_, AppState>) -> AppResult<String> {
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".into()))?
            .clone()
    };
    let conn = get_conn(state)?;
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
