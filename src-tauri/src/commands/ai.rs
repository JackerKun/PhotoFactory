// src-tauri/src/commands/ai.rs
use std::fs;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{atomic::AtomicBool, Mutex};
use std::time::Duration;
use tauri::{Emitter, State};

use crate::ai_worker::client::AiWorkerClient;
use crate::commands::project::{get_conn, AppState};
use crate::commands::tag_rules;
use crate::db::{ai_task_dao, classification_dao, face_dao, photo_dao};
use crate::error::{AppError, AppResult};
use crate::models::AiClassification;

pub const FACE_PIPELINE_VERSION: &str = "retinaface055-align2-arcface-multiproto3";
pub const SCENE_PIPELINE_VERSION: &str = "places365-v1+clip-vitb32-int8-v1";

fn bbox_iou(left: &crate::models::FaceDetection, right: &[i32; 4]) -> f64 {
    let ax1 = left.bbox_x as f64;
    let ay1 = left.bbox_y as f64;
    let ax2 = ax1 + left.bbox_w as f64;
    let ay2 = ay1 + left.bbox_h as f64;
    let bx1 = right[0] as f64;
    let by1 = right[1] as f64;
    let bx2 = bx1 + right[2] as f64;
    let by2 = by1 + right[3] as f64;
    let intersection =
        (ax2.min(bx2) - ax1.max(bx1)).max(0.0) * (ay2.min(by2) - ay1.max(by1)).max(0.0);
    let union =
        left.bbox_w as f64 * left.bbox_h as f64 + right[2] as f64 * right[3] as f64 - intersection;
    if union > 0.0 {
        intersection / union
    } else {
        0.0
    }
}

pub struct AiWorkerState {
    pub client: Mutex<Option<AiWorkerClient>>,
    pub port: u16,
    pub process: Mutex<Option<std::process::Child>>,
    pub pipeline_running: AtomicBool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AiPipelineStatus {
    pub status: String,
    pub stage: String,
    pub processed: i64,
    pub total: i64,
    pub failed: i64,
    pub photos_per_second: f64,
    pub eta_seconds: Option<i64>,
    pub last_error: Option<String>,
}

#[tauri::command]
pub fn cmd_get_ai_pipeline_status(state: State<'_, AppState>) -> AppResult<AiPipelineStatus> {
    let conn = get_conn(state)?;
    let (
        status,
        stage,
        processed,
        total,
        failed,
        stage_started_at,
        stage_base_processed,
        last_error,
    ): (
        String,
        String,
        i64,
        i64,
        i64,
        Option<i64>,
        i64,
        Option<String>,
    ) = conn.query_row(
        "SELECT status,stage,processed,total,failed,stage_started_at,stage_base_processed,last_error FROM ai_pipeline_state WHERE id=1",
        [],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?)),
    )?;
    let elapsed = stage_started_at
        .map(|started| (chrono::Utc::now().timestamp() - started).max(1))
        .unwrap_or(1);
    let session_processed = (processed - stage_base_processed).max(0);
    let photos_per_second = if session_processed > 0 {
        session_processed as f64 / elapsed as f64
    } else {
        0.0
    };
    let eta_seconds = if photos_per_second > 0.0 && total > processed {
        Some(((total - processed) as f64 / photos_per_second).ceil() as i64)
    } else {
        None
    };
    Ok(AiPipelineStatus {
        status,
        stage,
        processed,
        total,
        failed,
        photos_per_second,
        eta_seconds,
        last_error,
    })
}

#[tauri::command]
pub async fn cmd_start_ai_worker(port: u16, state: State<'_, AiWorkerState>) -> AppResult<String> {
    // Find either the development Python sources or the bundled standalone worker.
    let ai_worker_dir = find_ai_worker_dir().ok_or_else(|| {
        AppError::AiWorker(
            "The bundled AI service is missing. Please reinstall PhotoFactory.".into(),
        )
    })?;

    let server_py = ai_worker_dir.join("server.py");
    let bundled_worker = if cfg!(windows) {
        ai_worker_dir.join("photofactory-ai.exe")
    } else {
        ai_worker_dir.join("photofactory-ai")
    };

    // Stop the worker we own before replacing it.
    if let Some(mut existing) = state.process.lock().unwrap().take() {
        let _ = existing.kill();
        let _ = existing.wait();
    }
    // Clean up a stale development worker on the same port.
    kill_process_on_port(port)?;
    // Small delay to ensure port is free
    tokio::time::sleep(Duration::from_millis(500)).await;

    let mut command = if bundled_worker.is_file() {
        println!("Starting bundled AI worker: {}", bundled_worker.display());
        Command::new(&bundled_worker)
    } else if server_py.is_file() {
        let python = ai_worker_python(&ai_worker_dir);
        println!("Starting development AI worker with: {}", python.display());
        let mut command = Command::new(&python);
        command.arg(&server_py);
        command
    } else {
        return Err(AppError::AiWorker(format!(
            "AI service executable is missing from {}",
            ai_worker_dir.display()
        )));
    };
    let models_dir = ai_worker_dir.join("models");
    let ai_threads = std::thread::available_parallelism()
        .map(|count| (count.get() / 2).clamp(2, 6))
        .unwrap_or(2)
        .to_string();
    let mut child = command
        .env("AI_WORKER_PORT", port.to_string())
        .env("AI_MODELS_DIR", &models_dir)
        .env("PHOTFACTORY_AI_THREADS", &ai_threads)
        .env("OMP_NUM_THREADS", &ai_threads)
        .env("OPENBLAS_NUM_THREADS", &ai_threads)
        .env("MKL_NUM_THREADS", &ai_threads)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::AiWorker(format!("Failed to start local AI service: {}", e)))?;

    println!(
        "AI worker process spawned (PID: {}), waiting for it on port {}...",
        child.id(),
        port
    );

    // Capture Python stderr in a background thread so we can see tracebacks
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[AI worker stderr] {}", line);
            }
        });
    }
    // Also capture stdout for debug prints
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                println!("[AI worker stdout] {}", line);
            }
        });
    }

    // Store the process
    {
        let mut guard = state.process.lock().unwrap();
        *guard = Some(child);
    }

    // First launch may include macOS verification of bundled native libraries.
    let ready = wait_for_health(port, 120).await;
    if ready {
        *state.client.lock().unwrap() = Some(AiWorkerClient::new(port));
        Ok(format!(
            "AI worker started on port {} (PID: {})",
            port,
            state.process.lock().unwrap().as_ref().unwrap().id()
        ))
    } else {
        // Kill the process since it didn't start
        let mut guard = state.process.lock().unwrap();
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
        }
        Err(AppError::AiWorker(
            "AI worker failed to start. Check that Python dependencies are installed and model files exist.".into()
        ))
    }
}

fn ai_worker_python(ai_worker_dir: &std::path::Path) -> std::path::PathBuf {
    let unix_venv = ai_worker_dir.join(".venv/bin/python");
    if unix_venv.is_file() {
        return unix_venv;
    }
    let windows_venv = ai_worker_dir.join(".venv/Scripts/python.exe");
    if windows_venv.is_file() {
        return windows_venv;
    }
    if cfg!(windows) {
        std::path::PathBuf::from("python")
    } else {
        std::path::PathBuf::from("python3")
    }
}

/// Kill a stale development process listening on the given port (Unix only).
#[cfg(unix)]
fn kill_process_on_port(port: u16) -> AppResult<()> {
    let output = Command::new("lsof")
        .args(["-ti", &format!(":{}", port)])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| AppError::AiWorker(format!("lsof failed: {}", e)))?;
    if output.status.success() {
        let pids = String::from_utf8_lossy(&output.stdout);
        for pid in pids.lines() {
            if let Ok(pid_num) = pid.trim().parse::<i32>() {
                unsafe { libc::kill(pid_num, libc::SIGTERM) };
                println!(
                    "Killed previous process on port {} (PID: {})",
                    port, pid_num
                );
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn kill_process_on_port(_port: u16) -> AppResult<()> {
    // The managed child above covers normal lifecycle on Windows. Avoid relying
    // on Unix-only lsof; a genuinely occupied port is reported by the worker.
    Ok(())
}

/// Find the ai_worker directory by checking common locations
fn find_ai_worker_dir() -> Option<std::path::PathBuf> {
    // Check relative to the binary (for dev: target/debug/photofactory -> ../../.. -> project root)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            // Packaged macOS app: Contents/MacOS/PhotoFactory -> Contents/Resources/ai_worker
            if let Some(contents) = parent.parent() {
                let candidate = contents.join("Resources/ai_worker");
                if candidate.exists() {
                    return Some(candidate);
                }
            }
            // Packaged Windows app resources are placed beside the executable.
            let candidate = parent.join("ai_worker");
            if candidate.exists() {
                return Some(candidate);
            }
            let candidate = parent.join("resources/ai_worker");
            if candidate.exists() {
                return Some(candidate);
            }
            // target/debug/photofactory -> target/debug -> target -> project root
            let candidate = parent
                .parent() // target/debug -> target
                .and_then(|p| p.parent()) // target -> project root
                .map(|p| p.join("ai_worker"));
            if let Some(ref c) = candidate {
                println!("Checking ai_worker at (exe relative): {}", c.display());
                if c.exists() {
                    return candidate;
                }
            }
        }
    }

    // Check CWD and its parent
    if let Ok(cwd) = std::env::current_dir() {
        println!("CWD: {}", cwd.display());
        // Check CWD/ai_worker
        let candidate = cwd.join("ai_worker");
        if candidate.exists() {
            println!("Found ai_worker at: {}", candidate.display());
            return Some(candidate);
        }
        // Check parent/ai_worker (for when CWD is src-tauri/)
        if let Some(parent) = cwd.parent() {
            let candidate = parent.join("ai_worker");
            if candidate.exists() {
                println!("Found ai_worker at (parent): {}", candidate.display());
                return Some(candidate);
            }
        }
    }

    // Check AI_WORKER_DIR env var (for bundled app)
    if let Ok(dir) = std::env::var("AI_WORKER_DIR") {
        let candidate = std::path::PathBuf::from(dir);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    eprintln!("WARNING: Could not find ai_worker directory");
    None
}

/// Poll /health endpoint until ready or timeout
async fn wait_for_health(port: u16, max_retries: usize) -> bool {
    let url = format!("http://127.0.0.1:{}/health", port);
    for i in 0..max_retries {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Ok(resp) = reqwest::get(&url).await {
            if resp.status().is_success() {
                println!("AI worker ready after {} retries", i + 1);
                return true;
            }
        }
    }
    false
}

#[tauri::command]
pub async fn cmd_run_ai_classification(
    batch_size: Option<i64>,
    state: State<'_, AppState>,
    worker_state: State<'_, AiWorkerState>,
) -> AppResult<usize> {
    let conn = get_conn(state.clone())?;
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".into()))?
            .clone()
    };
    let limit = batch_size.unwrap_or(100).clamp(1, 100);
    let claimed = ai_task_dao::claim_tasks(&conn, ai_task_dao::CLASSIFICATION_STAGE, limit)?;
    let pending = claimed
        .iter()
        .filter_map(|id| photo_dao::get_photo_by_id(&conn, *id).ok().flatten())
        .collect::<Vec<_>>();

    if pending.is_empty() {
        return Ok(0);
    }

    // Check if client exists, auto-start if not
    let needs_start = {
        let guard = worker_state.client.lock().unwrap();
        guard.is_none()
    };
    if needs_start {
        cmd_start_ai_worker(worker_state.port, worker_state.clone()).await?;
    }

    let client = {
        let guard = worker_state.client.lock().unwrap();
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| AppError::AiWorker("Worker not started".into()))?
    };

    let model = project.ai_models.scene_classification.clone();

    // Process in batches to avoid HTTP timeout
    let batch_limit = 20usize;
    let mut total_count = 0;

    for chunk in pending.chunks(batch_limit) {
        let paths: Vec<String> = chunk.iter().map(|p| p.path.clone()).collect();
        println!("Classifying batch of {} photos...", paths.len());
        let response = match client.classify(paths, model.clone()).await {
            Ok(response) => response,
            Err(error) => {
                for photo in chunk {
                    ai_task_dao::mark_task_failed(
                        &conn,
                        photo.id.unwrap_or(0),
                        ai_task_dao::CLASSIFICATION_STAGE,
                        &error.to_string(),
                    )?;
                }
                return Err(error);
            }
        };

        for result in &response.results {
            if let Some(photo) = chunk.iter().find(|p| p.path == result.path) {
                let photo_id = photo.id.unwrap_or(0);
                if let Some(error) = &result.error {
                    ai_task_dao::mark_task_failed(
                        &conn,
                        photo_id,
                        ai_task_dao::CLASSIFICATION_STAGE,
                        error,
                    )?;
                    continue;
                }
                let tx = conn.unchecked_transaction()?;
                tx.execute(
                    "DELETE FROM ai_classifications WHERE photo_id=?1 AND COALESCE(tag_type,label_type,'ai_scene') IN ('ai_scene','ai_semantic')",
                    [photo_id],
                )?;
                let mut scene_count = 0usize;
                let mut semantic_count = 0usize;
                for tag in &result.tags {
                    let tag_type = tag.tag_type.as_deref().unwrap_or("ai_scene");
                    let accepted = match tag_type {
                        "ai_scene" if scene_count < 3 && tag.confidence > 0.1 => {
                            scene_count += 1;
                            true
                        }
                        "ai_semantic" if semantic_count < 8 && tag.confidence >= 0.25 => {
                            semantic_count += 1;
                            true
                        }
                        _ => false,
                    };
                    if !accepted {
                        continue;
                    }
                    classification_dao::insert_classification_with_type(
                        &tx,
                        &AiClassification {
                            id: None,
                            photo_id,
                            category: tag.category.clone().unwrap_or_else(|| "场景".into()),
                            label: tag.label.clone(),
                            confidence: tag.confidence,
                        },
                        tag_type,
                    )?;
                }
                photo_dao::update_classification_status(&tx, photo_id, 1)?;
                tx.execute(
                    "UPDATE ai_photo_tasks SET status='done',lease_until=NULL,error=NULL,completed_at=?1,updated_at=?1 WHERE photo_id=?2 AND stage=?3",
                    rusqlite::params![chrono::Utc::now().timestamp(), photo_id, ai_task_dao::CLASSIFICATION_STAGE],
                )?;
                tx.commit()?;
                total_count += 1;
            }
        }
        println!("  Classified {} photos so far...", total_count);
    }

    Ok(total_count)
}

#[tauri::command]
pub async fn cmd_run_face_detection(
    batch_size: Option<i64>,
    state: State<'_, AppState>,
    worker_state: State<'_, AiWorkerState>,
) -> AppResult<usize> {
    let conn = get_conn(state.clone())?;
    let project = {
        let guard = state.project.lock().unwrap();
        guard
            .as_ref()
            .ok_or_else(|| AppError::Project("No project open".into()))?
            .clone()
    };
    let limit = batch_size.unwrap_or(100).clamp(1, 100);
    let claimed = ai_task_dao::claim_tasks(&conn, ai_task_dao::FACE_STAGE, limit)?;
    let pending = claimed
        .iter()
        .filter_map(|id| photo_dao::get_photo_by_id(&conn, *id).ok().flatten())
        .collect::<Vec<_>>();

    if pending.is_empty() {
        face_dao::set_ai_model_version(&conn, "face_pipeline", FACE_PIPELINE_VERSION)?;
        return Ok(0);
    }

    // Check if client exists, auto-start if not
    let needs_start = {
        let guard = worker_state.client.lock().unwrap();
        guard.is_none()
    };
    if needs_start {
        cmd_start_ai_worker(worker_state.port, worker_state.clone()).await?;
    }

    let client = {
        let guard = worker_state.client.lock().unwrap();
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| AppError::AiWorker("Worker not started".into()))?
    };

    let batch_limit = 10usize;
    let mut total_count = 0;
    let now = chrono::Utc::now().timestamp();
    let faces_cache = project.faces_cache_path();
    fs::create_dir_all(&faces_cache)?;
    println!("Faces cache path: {}", faces_cache.display());

    // Create a temp dir for Python to save embeddings
    let temp_dir = std::env::temp_dir().join("photofactory_faces");
    // Clear any leftover files from previous runs
    let _ = fs::remove_dir_all(&temp_dir);
    fs::create_dir_all(&temp_dir)?;
    println!("Temp embedding dir: {}", temp_dir.display());

    for chunk in pending.chunks(batch_limit) {
        let paths: Vec<String> = chunk.iter().map(|p| p.path.clone()).collect();
        println!("Detecting faces in {} photos...", paths.len());
        let response = match client.detect_faces(paths, temp_dir.to_str().unwrap()).await {
            Ok(response) => response,
            Err(error) => {
                for photo in chunk {
                    ai_task_dao::mark_task_failed(
                        &conn,
                        photo.id.unwrap_or(0),
                        ai_task_dao::FACE_STAGE,
                        &error.to_string(),
                    )?;
                }
                return Err(error);
            }
        };

        for (result_idx, result) in response.results.iter().enumerate() {
            if let Some(photo) = chunk.iter().find(|p| p.path == result.path) {
                let photo_id = photo.id.unwrap_or(0);
                if let Some(error) = &result.error {
                    ai_task_dao::mark_task_failed(&conn, photo_id, ai_task_dao::FACE_STAGE, error)?;
                    continue;
                }
                let named_faces = face_dao::get_named_faces_for_photo(&conn, photo_id)?;
                let ignored_faces = face_dao::get_ignored_faces_for_photo(&conn, photo_id)?;
                let mut matched_named = std::collections::HashSet::new();
                let tx = conn.unchecked_transaction()?;
                tx.execute(
                    "DELETE FROM face_detections WHERE photo_id=?1
                     AND COALESCE(review_status,'active')!='ignored'
                     AND (person_id IS NULL OR EXISTS(
                         SELECT 1 FROM face_clusters fc LEFT JOIN person_metadata pm ON pm.person_id=fc.id
                         WHERE fc.id=face_detections.person_id AND TRIM(COALESCE(fc.name,pm.user_name,''))=''))",
                    [photo_id],
                )?;
                for (face_idx, face) in result.faces.iter().enumerate() {
                    // Python saves embeddings as {result_idx_in_batch}_{face_idx}.npy
                    let py_embedding_name = format!("{}_{}.npy", result_idx, face_idx);
                    let src = temp_dir.join(&py_embedding_name);

                    if ignored_faces
                        .iter()
                        .any(|ignored| bbox_iou(ignored, &face.bbox) >= 0.45)
                    {
                        let _ = fs::remove_file(&src);
                        continue;
                    }

                    let embedding_path = format!("{:08x}.npy", (photo_id << 8) | face_idx as i64);
                    let cache_file = faces_cache.join(&embedding_path);

                    if src.exists() {
                        if cache_file.exists() {
                            fs::remove_file(&cache_file)?;
                        }
                        fs::rename(&src, &cache_file).map_err(|e| {
                            println!(
                                "Failed to move embedding: {} -> {}: {}",
                                src.display(),
                                cache_file.display(),
                                e
                            );
                            e
                        })?;
                    }

                    let review_status = if face.quality_score < 0.38 {
                        "suspected_false_positive"
                    } else {
                        "active"
                    };
                    let detection = crate::models::FaceDetection {
                        id: None,
                        photo_id,
                        bbox_x: face.bbox[0],
                        bbox_y: face.bbox[1],
                        bbox_w: face.bbox[2],
                        bbox_h: face.bbox[3],
                        embedding_path: Some(embedding_path),
                        person_id: None,
                        created_at: now,
                    };
                    let metadata = crate::models::FaceDetectionMetadata {
                        confidence: face.confidence,
                        quality_score: face.quality_score,
                        landmarks_json: serde_json::to_string(&face.landmarks).ok(),
                        pose_yaw: face.pose_yaw,
                        pose_pitch: face.pose_pitch,
                        pose_roll: face.pose_roll,
                        alignment_success: face.alignment_success,
                        review_status: review_status.into(),
                    };
                    let named_match = named_faces
                        .iter()
                        .filter(|existing| {
                            existing.id.is_some_and(|id| !matched_named.contains(&id))
                        })
                        .map(|existing| (existing, bbox_iou(existing, &face.bbox)))
                        .filter(|(_, overlap)| *overlap >= 0.45)
                        .max_by(|left, right| left.1.total_cmp(&right.1));
                    if let Some((existing, _)) = named_match {
                        let id = existing.id.unwrap();
                        face_dao::update_named_face_after_reanalysis(
                            &tx, id, &detection, &metadata,
                        )?;
                        matched_named.insert(id);
                    } else {
                        face_dao::insert_face_detection_with_metadata(&tx, &detection, &metadata)?;
                    }
                }
                photo_dao::update_face_status(&tx, photo_id, 1)?;
                tx.execute(
                    "DELETE FROM person_metadata WHERE TRIM(COALESCE(user_name,''))=''
                     AND NOT EXISTS(SELECT 1 FROM face_detections fd WHERE fd.person_id=person_metadata.person_id)",
                    [],
                )?;
                tx.execute(
                    "DELETE FROM face_clusters WHERE TRIM(COALESCE(name,''))=''
                     AND NOT EXISTS(SELECT 1 FROM person_metadata pm WHERE pm.person_id=face_clusters.id AND TRIM(COALESCE(pm.user_name,''))!='')
                     AND NOT EXISTS(SELECT 1 FROM face_detections fd WHERE fd.person_id=face_clusters.id)",
                    [],
                )?;
                tx.execute(
                    "UPDATE ai_photo_tasks SET status='done',lease_until=NULL,error=NULL,completed_at=?1,updated_at=?1 WHERE photo_id=?2 AND stage=?3",
                    rusqlite::params![chrono::Utc::now().timestamp(), photo_id, ai_task_dao::FACE_STAGE],
                )?;
                tx.commit()?;
                total_count += 1;
            }
        }
        println!("  Processed {} photos so far...", total_count);
    }

    let remaining: i64 = conn.query_row(
        "SELECT COUNT(*) FROM photos WHERE face_status = 0 AND deleted = 0",
        [],
        |row| row.get(0),
    )?;
    if remaining == 0 {
        face_dao::set_ai_model_version(&conn, "face_pipeline", FACE_PIPELINE_VERSION)?;
    }

    Ok(total_count)
}

#[tauri::command]
pub async fn cmd_worker_health(worker_state: State<'_, AiWorkerState>) -> AppResult<bool> {
    // Only return true if the client is actually stored in state.
    // A direct HTTP check is insufficient — cmd_run_ai_classification requires a stored client.
    let client = {
        let worker = worker_state.client.lock().unwrap();
        worker.as_ref().cloned()
    };
    match client {
        Some(c) => c.health_check().await,
        None => Ok(false),
    }
}

/// Helper: run geo-tagging on all untagged photos.
async fn run_geo_tagging(state: State<'_, AppState>, batch_size: usize) -> AppResult<usize> {
    let conn = get_conn(state.clone())?;
    let tagger = crate::geo_tagger::GeoTagger::new();
    tagger.tag_photos(&conn, batch_size)
}

/// Helper: run time-tagging on all untagged photos.
async fn run_time_tagging(state: State<'_, AppState>, batch_size: usize) -> AppResult<usize> {
    let conn = get_conn(state.clone())?;
    crate::time_tagger::run_time_tagging(&conn, batch_size)
}

/// Helper: run device-tagging on all untagged photos.
async fn run_device_tagging(state: State<'_, AppState>, batch_size: usize) -> AppResult<usize> {
    let conn = get_conn(state.clone())?;
    crate::device_tagger::run_device_tagging(&conn, batch_size)
}

/// Helper: run event-tagging (GPS+time clustering).
async fn run_event_tagging(state: State<'_, AppState>) -> AppResult<usize> {
    let conn = get_conn(state.clone())?;
    crate::time_tagger::run_event_tagging(&conn)
}

/// Auto-start AI worker and process all pending photos (face detection + scene classification + face clustering).
/// Called after project import/scan.
#[tauri::command]
pub async fn cmd_auto_ai_pipeline(
    state: State<'_, AppState>,
    worker_state: State<'_, AiWorkerState>,
) -> AppResult<String> {
    let mut messages = Vec::new();

    // 1. Ensure AI worker is running
    let healthy = cmd_worker_health(worker_state.clone())
        .await
        .unwrap_or(false);
    if !healthy {
        let port = worker_state.port;
        match cmd_start_ai_worker(port, worker_state.clone()).await {
            Ok(msg) => {
                messages.push(msg);
            }
            Err(e) => {
                return Err(AppError::AiWorker(format!(
                    "Failed to start AI worker: {}",
                    e
                )));
            }
        }
    } else {
        messages.push("AI worker already running".into());
    }

    {
        let conn = get_conn(state.clone())?;
        ai_task_dao::sync_stage_tasks(
            &conn,
            ai_task_dao::FACE_STAGE,
            FACE_PIPELINE_VERSION,
            "face_status",
        )?;
        ai_task_dao::sync_stage_tasks(
            &conn,
            ai_task_dao::CLASSIFICATION_STAGE,
            SCENE_PIPELINE_VERSION,
            "classification_status",
        )?;
    }

    // 2. Repair a previously interrupted run before starting more expensive
    // detection work. Otherwise one unreadable pending photo can leave hundreds
    // of valid face embeddings invisible forever.
    let unassigned_before = {
        let conn = get_conn(state.clone())?;
        face_dao::get_unassigned_face_count(&conn).unwrap_or(0)
    };
    if unassigned_before > 0 {
        match crate::commands::faces::cmd_run_face_clustering_inner(
            state.clone(),
            worker_state.clone(),
        )
        .await
        {
            Ok(msg) => messages.push(format!("Recovered interrupted face clustering: {}", msg)),
            Err(e) => messages.push(format!(
                "Interrupted face clustering recovery failed: {}",
                e
            )),
        }
    }

    // 3. Run face detection on ALL pending photos (loops until done)
    let mut face_count = 0;
    loop {
        let batch = cmd_run_face_detection(Some(25), state.clone(), worker_state.clone()).await?;
        if batch == 0 {
            break;
        }
        face_count += batch;
        println!("Face detection progress: {} total", face_count);
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    messages.push(format!("Face detection: processed {} photos", face_count));

    // 4. Run scene classification on ALL pending photos (loops until done)
    let mut scene_count = 0;
    loop {
        let batch =
            cmd_run_ai_classification(Some(40), state.clone(), worker_state.clone()).await?;
        if batch == 0 {
            break;
        }
        scene_count += batch;
        println!("Scene classification progress: {} total", scene_count);
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    messages.push(format!(
        "Scene classification: processed {} photos",
        scene_count
    ));

    // 5. Group faces created by this run (and retry recovery if it failed above).
    let unassigned_faces = {
        let conn = get_conn(state.clone())?;
        face_dao::get_unassigned_face_count(&conn).unwrap_or(0)
    };
    if unassigned_faces > 0 {
        let cluster_result = crate::commands::faces::cmd_run_face_clustering_inner(
            state.clone(),
            worker_state.clone(),
        )
        .await;
        match cluster_result {
            Ok(msg) => messages.push(format!("Face clustering: {}", msg)),
            Err(e) => messages.push(format!("Face clustering failed: {}", e)),
        }
    }

    // 6. Geo tagging
    match run_geo_tagging(state.clone(), 100).await {
        Ok(count) => messages.push(format!("Geo-tagged {} photos", count)),
        Err(e) => messages.push(format!("Geo-tagging failed: {}", e)),
    }

    // 7. Time tagging
    match run_time_tagging(state.clone(), 500).await {
        Ok(count) => messages.push(format!("Time-tagged {} photos", count)),
        Err(e) => messages.push(format!("Time-tagging failed: {}", e)),
    }

    // 8. Device tagging
    match run_device_tagging(state.clone(), 500).await {
        Ok(count) => messages.push(format!("Device-tagged {} photos", count)),
        Err(e) => messages.push(format!("Device-tagging failed: {}", e)),
    }

    // 9. Event tagging (GPS+time clustering)
    match run_event_tagging(state.clone()).await {
        Ok(count) => messages.push(format!("Created {} event tags", count)),
        Err(e) => messages.push(format!("Event tagging failed: {}", e)),
    }

    // 10. Rule-based tagging
    match tag_rules::cmd_run_tag_rules(state.clone()).await {
        Ok(msg) => messages.push(format!("Rule tags: {}", msg)),
        Err(e) => messages.push(format!("Rule tagging failed: {}", e)),
    }

    // 11. Publish every generated classification through the single editable tag catalog.
    if let Ok(conn) = get_conn(state.clone()) {
        match crate::db::manual_tag_dao::sync_generated_tags(&conn) {
            Ok(count) => messages.push(format!("Updated {} tag assignments", count)),
            Err(e) => messages.push(format!("Tag catalog update failed: {}", e)),
        }
    }

    Ok(messages.join("\n"))
}

#[allow(clippy::too_many_arguments)]
fn publish_ai_progress(
    conn: &rusqlite::Connection,
    app_handle: &tauri::AppHandle,
    status: &str,
    stage: &str,
    total: i64,
    processed: i64,
    failed: i64,
    error: Option<&str>,
) -> Result<(), String> {
    ai_task_dao::set_pipeline_state(conn, status, stage, total, processed, failed, error)
        .map_err(|value| value.to_string())?;
    app_handle
        .emit(
            "ai_status_changed",
            serde_json::json!({
                "status": status,
                "stage": stage,
                "processed": processed,
                "total": total,
                "failed": failed
            }),
        )
        .map_err(|value| value.to_string())
}

async fn wait_for_pipeline_permission(
    db_path: &std::path::Path,
    app_handle: &tauri::AppHandle,
) -> Result<bool, String> {
    loop {
        let conn = crate::db::connection::init_db(db_path).map_err(|value| value.to_string())?;
        match ai_task_dao::pipeline_control_status(&conn)
            .map_err(|value| value.to_string())?
            .as_str()
        {
            "paused" => {
                conn.execute(
                    "UPDATE ai_pipeline_state SET status='paused',updated_at=?1 WHERE id=1",
                    [chrono::Utc::now().timestamp()],
                )
                .map_err(|value| value.to_string())?;
                let _ = app_handle.emit(
                    "ai_status_changed",
                    serde_json::json!({"status":"paused","stage":"paused","processed":0,"total":0}),
                );
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            "canceled" => {
                conn.execute(
                    "UPDATE ai_pipeline_state SET status='canceled',updated_at=?1 WHERE id=1",
                    [chrono::Utc::now().timestamp()],
                )
                .map_err(|value| value.to_string())?;
                conn.execute(
                    "UPDATE ai_photo_tasks SET status='pending',lease_until=NULL,updated_at=?1 WHERE status='running'",
                    [chrono::Utc::now().timestamp()],
                )
                .map_err(|value| value.to_string())?;
                let _ = app_handle.emit(
                    "ai_status_changed",
                    serde_json::json!({"status":"canceled","stage":"canceled","processed":0,"total":0}),
                );
                return Ok(false);
            }
            _ => return Ok(true),
        }
    }
}

/// Internal: run AI pipeline with progress events emitted to frontend.
pub async fn run_auto_ai_pipeline_inner(
    state: State<'_, AppState>,
    worker_state: State<'_, AiWorkerState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    use crate::db::connection::init_db;

    // Helper to emit progress events
    let emit = |stage: &str, processed: u64, total: u64| {
        let _ = app_handle.emit(
            "ai_status_changed",
            serde_json::json!({
                "stage": stage,
                "processed": processed,
                "total": total
            }),
        );
    };

    // 1. Ensure the stored client still points at a live worker. Merely having a
    // client object is insufficient after an interrupted/abnormal shutdown.
    let healthy = cmd_worker_health(worker_state.clone())
        .await
        .unwrap_or(false);
    if !healthy {
        let port = worker_state.port;
        if let Err(e) = cmd_start_ai_worker(port, worker_state.clone()).await {
            emit("error", 0, 0);
            return Err(format!("Failed to start AI worker: {}", e));
        }
    }

    // 2. Get total pending count
    let project = {
        let guard = state.project.lock().unwrap();
        guard.as_ref().cloned()
    };
    let project = match project {
        Some(p) => p,
        None => {
            emit("done", 0, 0);
            return Ok(());
        }
    };

    let conn = match init_db(&project.db_path()) {
        Ok(c) => c,
        Err(e) => {
            emit("error", 0, 0);
            return Err(e.to_string());
        }
    };
    ai_task_dao::sync_stage_tasks(
        &conn,
        ai_task_dao::FACE_STAGE,
        FACE_PIPELINE_VERSION,
        "face_status",
    )
    .map_err(|value| value.to_string())?;
    ai_task_dao::sync_stage_tasks(
        &conn,
        ai_task_dao::CLASSIFICATION_STAGE,
        SCENE_PIPELINE_VERSION,
        "classification_status",
    )
    .map_err(|value| value.to_string())?;
    // This process owns the single pipeline lock. Any persisted running lease
    // therefore belongs to a previous app process and is safe to reclaim now.
    conn.execute(
        "UPDATE ai_photo_tasks SET status='pending',lease_until=NULL,updated_at=?1 WHERE status='running'",
        [chrono::Utc::now().timestamp()],
    )
    .map_err(|value| value.to_string())?;
    let (face_total, face_done, face_failed) =
        ai_task_dao::stage_counts(&conn, ai_task_dao::FACE_STAGE)
            .map_err(|value| value.to_string())?;
    let (classification_total, classification_done, classification_failed) =
        ai_task_dao::stage_counts(&conn, ai_task_dao::CLASSIFICATION_STAGE)
            .map_err(|value| value.to_string())?;
    let total_pending = (face_total - face_done - face_failed)
        + (classification_total - classification_done - classification_failed);
    let unassigned_before = face_dao::get_unassigned_face_count(&conn).unwrap_or(0) as u64;

    if total_pending == 0 && unassigned_before == 0 {
        let _ = publish_ai_progress(&conn, &app_handle, "done", "done", 0, 0, 0, None);
        return Ok(());
    }

    // 3. First recover valid embeddings left by an interrupted run. This is fast
    // and makes existing people visible even if a later photo cannot be decoded.
    if unassigned_before > 0 {
        emit("recovering_faces", 0, unassigned_before);
        match crate::commands::faces::cmd_run_face_clustering_inner(
            state.clone(),
            worker_state.clone(),
        )
        .await
        {
            Ok(message) => {
                println!("Recovered interrupted face clustering: {}", message);
                emit("clustering_done", unassigned_before, unassigned_before);
            }
            Err(error) => {
                eprintln!("Interrupted face clustering recovery failed: {}", error);
                emit("clustering_error", 0, unassigned_before);
            }
        }
    }

    if total_pending == 0 {
        let remaining_unassigned = face_dao::get_unassigned_face_count(&conn).unwrap_or(0);
        if remaining_unassigned == 0 {
            let _ = publish_ai_progress(&conn, &app_handle, "done", "done", 0, 0, 0, None);
            return Ok(());
        }
    }

    // 4. Face detection
    publish_ai_progress(
        &conn,
        &app_handle,
        "running",
        "face_detection",
        face_total,
        face_done,
        face_failed,
        None,
    )?;
    let mut since_cluster: u64 = 0;
    loop {
        if !wait_for_pipeline_permission(&project.db_path(), &app_handle).await? {
            return Ok(());
        }
        match cmd_run_face_detection(Some(25), state.clone(), worker_state.clone()).await {
            Ok(batch) => {
                if batch == 0 {
                    break;
                }
                since_cluster += batch as u64;
            }
            Err(e) => {
                if let Ok(error_conn) = init_db(&project.db_path()) {
                    let (total, done, failed) =
                        ai_task_dao::stage_counts(&error_conn, ai_task_dao::FACE_STAGE)
                            .unwrap_or((0, 0, 0));
                    let _ = publish_ai_progress(
                        &error_conn,
                        &app_handle,
                        "error",
                        "face_detection",
                        total,
                        done,
                        failed,
                        Some(&e.to_string()),
                    );
                }
                emit("error", 0, 0);
                return Err(e.to_string());
            }
        }
        let progress_conn = init_db(&project.db_path()).map_err(|value| value.to_string())?;
        let (total, done, failed) =
            ai_task_dao::stage_counts(&progress_conn, ai_task_dao::FACE_STAGE)
                .map_err(|value| value.to_string())?;
        publish_ai_progress(
            &progress_conn,
            &app_handle,
            "running",
            "face_detection",
            total,
            done,
            failed,
            None,
        )?;
        if since_cluster >= 500 {
            let _ = crate::commands::faces::cmd_run_face_clustering_inner(
                state.clone(),
                worker_state.clone(),
            )
            .await;
            since_cluster = 0;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    // 5. Scene classification — recount remaining
    let conn2 = match init_db(&project.db_path()) {
        Ok(c) => c,
        Err(_) => {
            emit("done", 0, 0);
            return Ok(());
        }
    };
    let (classification_total, classification_done, classification_failed) =
        ai_task_dao::stage_counts(&conn2, ai_task_dao::CLASSIFICATION_STAGE)
            .map_err(|value| value.to_string())?;
    publish_ai_progress(
        &conn2,
        &app_handle,
        "running",
        "classification",
        classification_total,
        classification_done,
        classification_failed,
        None,
    )?;
    loop {
        if !wait_for_pipeline_permission(&project.db_path(), &app_handle).await? {
            return Ok(());
        }
        match cmd_run_ai_classification(Some(40), state.clone(), worker_state.clone()).await {
            Ok(batch) => {
                if batch == 0 {
                    break;
                }
            }
            Err(error) => {
                if let Ok(error_conn) = init_db(&project.db_path()) {
                    let (total, done, failed) =
                        ai_task_dao::stage_counts(&error_conn, ai_task_dao::CLASSIFICATION_STAGE)
                            .unwrap_or((0, 0, 0));
                    let _ = publish_ai_progress(
                        &error_conn,
                        &app_handle,
                        "error",
                        "classification",
                        total,
                        done,
                        failed,
                        Some(&error.to_string()),
                    );
                }
                emit("error", 0, 0);
                return Err(error.to_string());
            }
        }
        let progress_conn = init_db(&project.db_path()).map_err(|value| value.to_string())?;
        let (total, done, failed) =
            ai_task_dao::stage_counts(&progress_conn, ai_task_dao::CLASSIFICATION_STAGE)
                .map_err(|value| value.to_string())?;
        publish_ai_progress(
            &progress_conn,
            &app_handle,
            "running",
            "classification",
            total,
            done,
            failed,
            None,
        )?;
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    // 6. Group only the faces that remain unassigned after detection. Recounting
    // avoids an unnecessary full clustering pass when recovery already handled all
    // existing embeddings and this run found no new faces.
    let unassigned_after = init_db(&project.db_path())
        .ok()
        .and_then(|conn| face_dao::get_unassigned_face_count(&conn).ok())
        .unwrap_or(0) as u64;
    if unassigned_after > 0 {
        let mut previous = unassigned_after;
        loop {
            if !wait_for_pipeline_permission(&project.db_path(), &app_handle).await? {
                return Ok(());
            }
            let clustering_conn = init_db(&project.db_path()).map_err(|value| value.to_string())?;
            publish_ai_progress(
                &clustering_conn,
                &app_handle,
                "running",
                "clustering",
                unassigned_after as i64,
                (unassigned_after - previous) as i64,
                0,
                None,
            )?;
            match crate::commands::faces::cmd_run_face_clustering_inner(
                state.clone(),
                worker_state.clone(),
            )
            .await
            {
                Ok(message) => println!("Face clustering batch complete: {}", message),
                Err(error) => {
                    eprintln!("Face clustering failed: {}", error);
                    emit("clustering_error", 0, unassigned_after);
                    break;
                }
            }
            let remaining = init_db(&project.db_path())
                .ok()
                .and_then(|connection| face_dao::get_unassigned_face_count(&connection).ok())
                .unwrap_or(0) as u64;
            if remaining == 0 || remaining >= previous {
                break;
            }
            previous = remaining;
        }
        emit("clustering_done", unassigned_after, unassigned_after);
    }

    // 7. Geo tagging (rate-limited, may fail gracefully)
    emit("geo_tagging", 0, 0);
    match run_geo_tagging(state.clone(), 100).await {
        Ok(count) => {
            println!("Geo-tagged {} photos", count);
            emit("geo_tagging", count as u64, 0);
        }
        Err(e) => eprintln!("Geo-tagging failed: {}", e),
    }

    // 8. Time tagging
    match run_time_tagging(state.clone(), 500).await {
        Ok(count) => println!("Time-tagged {} photos", count),
        Err(e) => eprintln!("Time-tagging failed: {}", e),
    }

    // 9. Device tagging
    match run_device_tagging(state.clone(), 500).await {
        Ok(count) => println!("Device-tagged {} photos", count),
        Err(e) => eprintln!("Device-tagging failed: {}", e),
    }

    // 10. Event tagging (GPS+time clustering)
    match run_event_tagging(state.clone()).await {
        Ok(count) => println!("Created {} event tags", count),
        Err(e) => eprintln!("Event tagging failed: {}", e),
    }

    // 11. Merge all generated results into the same user-editable tag catalog.
    if let Ok(conn) = init_db(&project.db_path()) {
        if let Err(e) = crate::db::manual_tag_dao::sync_generated_tags(&conn) {
            eprintln!("Tag catalog update failed: {}", e);
        }
    }

    // 12. Done
    if let Ok(done_conn) = init_db(&project.db_path()) {
        let failed = ai_task_dao::stage_counts(&done_conn, ai_task_dao::FACE_STAGE)
            .map(|(_, _, failed)| failed)
            .unwrap_or(0)
            + ai_task_dao::stage_counts(&done_conn, ai_task_dao::CLASSIFICATION_STAGE)
                .map(|(_, _, failed)| failed)
                .unwrap_or(0);
        let _ = publish_ai_progress(&done_conn, &app_handle, "done", "done", 0, 0, failed, None);
    }
    Ok(())
}
