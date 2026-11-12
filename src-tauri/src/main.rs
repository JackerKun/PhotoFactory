#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{atomic::AtomicBool, Arc, Mutex};
use std::time::Duration;

use photofactory::commands::ai::AiWorkerState;
use photofactory::commands::project::{self, try_load_last_project, AppState};
use photofactory::commands::{
    ai, diagnostics, faces, geo_tags, library, map, memory_video, photos, shell, smart_albums, tag_rules, tags,
    time_tags, updates,
};
use photofactory::thumbnail::processor::ThumbnailProcessor;
use tauri::{Listener, Manager};

fn main() {
    let initial_project = try_load_last_project();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            project: Mutex::new(initial_project),
            thumbnail_processor: Arc::new(ThumbnailProcessor::new(50).with_saved_performance()),
        })
        .manage(AiWorkerState {
            client: Mutex::new(None),
            port: 9876,
            process: Mutex::new(None),
            pipeline_running: AtomicBool::new(false),
        })
        .manage(memory_video::MemoryVideoState::default())
        .setup(|app| {
            if let Some(project) = app.state::<AppState>().project.lock().unwrap().as_ref() {
                if let Err(error) = project::allow_project_assets(app.handle(), project) {
                    eprintln!("Could not restore photo directory access: {error}");
                }
            }
            let handle = app.handle().clone();
            app.listen("tauri://close-requested", move |_event| {
                if let Some(state) = handle.try_state::<AiWorkerState>() {
                    shutdown_ai_worker(&state);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            updates::cmd_check_for_update,
            project::cmd_create_project,
            project::cmd_open_project,
            project::cmd_scan_project,
            project::cmd_get_project,
            project::cmd_incremental_scan,
            photos::cmd_get_photos,
            photos::cmd_get_photo_timeline,
            photos::cmd_get_photo_filter_options,
            photos::cmd_update_photos_rating,
            photos::cmd_get_photo,
            photos::cmd_get_lightbox_photos,
            photos::cmd_get_photo_classifications,
            photos::cmd_get_photo_attributes,
            photos::cmd_set_photo_attribute,
            photos::cmd_get_thumbnail_path,
            photos::cmd_get_photo_data_url,
            photos::cmd_start_thumbnail_batch,
            photos::cmd_get_thumbnail_processing_status,
            photos::cmd_get_thumbnail_performance,
            photos::cmd_set_thumbnail_performance,
            photos::cmd_rebuild_thumbnail_cache,
            photos::cmd_toggle_photo_favorite,
            photos::cmd_update_photo_gps,
            photos::cmd_update_photos_gps,
            photos::cmd_update_photos_gps_individual,
            faces::cmd_get_photo_faces,
            faces::cmd_get_clusters,
            faces::cmd_get_cluster_page,
            faces::cmd_rename_cluster,
            faces::cmd_confirm_face_cluster,
            faces::cmd_reassign_photo_face,
            faces::cmd_create_named_person_for_face,
            faces::cmd_delete_photo_face,
            faces::cmd_merge_clusters,
            faces::cmd_merge_clusters_batch,
            faces::cmd_run_face_clustering,
            faces::cmd_rebuild_face_clusters,
            faces::cmd_auto_merge_unnamed_faces,
            faces::cmd_preview_auto_merge_unnamed_faces,
            faces::cmd_apply_auto_merge_unnamed_faces,
            faces::cmd_reject_auto_merge_candidate,
            faces::cmd_undo_last_automatic_face_merge,
            faces::cmd_has_automatic_face_merge_to_undo,
            faces::cmd_get_cluster_face_thumbnail,
            faces::cmd_add_face_constraint,
            faces::cmd_remove_face_constraint,
            faces::cmd_get_person_detail,
            faces::cmd_get_person_timeline,
            faces::cmd_get_person_scene_tags,
            faces::cmd_split_person,
            faces::cmd_get_face_detection_count,
            faces::cmd_get_unassigned_face_count,
            faces::cmd_get_suspected_faces,
            faces::cmd_get_suspected_face_count,
            faces::cmd_ignore_face_clusters,
            faces::cmd_get_ignored_face_count,
            faces::cmd_restore_all_ignored_faces,
            faces::cmd_keep_suspected_face,
            faces::cmd_delete_all_suspected_faces,
            faces::cmd_get_face_thumbnail,
            faces::cmd_get_face_ai_version_status,
            faces::cmd_prepare_face_ai_reanalysis,
            tags::cmd_get_all_labels,
            tags::cmd_rename_classification_label,
            tags::cmd_get_label_preview,
            tags::cmd_get_label_hierarchy,
            tags::cmd_get_labels_by_type,
            tags::cmd_rebuild_label_hierarchy,
            tags::cmd_get_label_photo_count,
            tags::cmd_get_manual_tags,
            tags::cmd_get_ai_tag_groups,
            tags::cmd_get_photo_manual_tags,
            tags::cmd_create_manual_tag,
            tags::cmd_update_manual_tag,
            tags::cmd_delete_manual_tag,
            tags::cmd_set_photo_manual_tags,
            map::cmd_get_photos_with_gps,
            map::cmd_get_track_photos,
            map::cmd_list_photo_tracks,
            map::cmd_save_photo_track,
            map::cmd_delete_photo_track,
            map::cmd_get_photo_directories,
            map::cmd_list_offline_maps,
            map::cmd_import_offline_map,
            map::cmd_export_offline_map,
            map::cmd_get_map_tile,
            map::cmd_get_map_tile_status,
            map::cmd_has_map_tile,
            map::cmd_search_map_location,
            ai::cmd_start_ai_worker,
            ai::cmd_run_ai_classification,
            ai::cmd_run_face_detection,
            ai::cmd_worker_health,
            ai::cmd_get_ai_runtime,
            ai::cmd_get_ai_pipeline_status,
            ai::cmd_get_task_errors,
            ai::cmd_get_task_error_photos,
            ai::cmd_get_ignored_task_photos,
            ai::cmd_ignore_task_error_photos,
            ai::cmd_restore_task_photo,
            ai::cmd_auto_ai_pipeline,
            diagnostics::cmd_run_diagnostics,
            diagnostics::cmd_check_integrity,
            diagnostics::cmd_rebuild_indexes,
            diagnostics::cmd_cleanup_orphans,
            project::cmd_save_last_project_path,
            project::cmd_get_last_project_path,
            project::cmd_add_recent_project,
            project::cmd_get_recent_projects,
            project::cmd_remove_recent_project,
            project::cmd_close_project,
            project::cmd_update_extensions,
            project::cmd_trigger_auto_ai,
            project::cmd_control_ai_pipeline,
            project::cmd_recalculate_ai_tags,
            shell::cmd_reveal_in_file_manager,
            geo_tags::cmd_run_geo_tagging,
            time_tags::cmd_run_time_tagging,
            time_tags::cmd_run_device_tagging,
            time_tags::cmd_run_event_tagging,
            smart_albums::cmd_get_smart_albums,
            smart_albums::cmd_get_photo_memories,
            smart_albums::cmd_set_photo_memory_preferences,
            memory_video::cmd_begin_memory_video,
            memory_video::cmd_append_memory_video,
            memory_video::cmd_finish_memory_video,
            smart_albums::cmd_get_group_photos,
            smart_albums::cmd_get_named_photo_groups,
            smart_albums::cmd_create_person_combination,
            smart_albums::cmd_get_smart_album_photos,
            smart_albums::cmd_regenerate_smart_albums,
            smart_albums::cmd_create_manual_album,
            smart_albums::cmd_rename_album,
            smart_albums::cmd_delete_album,
            smart_albums::cmd_add_photos_to_album,
            smart_albums::cmd_remove_photos_from_album,
            smart_albums::cmd_set_album_cover,
            tag_rules::cmd_run_tag_rules,
            library::cmd_get_library_jobs,
            library::cmd_control_library_job,
            library::cmd_start_library_analysis,
            library::cmd_retry_library_analysis,
            library::cmd_smart_search,
            library::cmd_get_duplicate_groups,
            library::cmd_get_raw_jpeg_stacks,
            library::cmd_get_duplicate_group_photos,
            library::cmd_trash_duplicate_group,
            library::cmd_move_photos_to_trash,
            library::cmd_get_trashed_photos,
            library::cmd_restore_trashed_photos,
            library::cmd_set_photo_privacy,
            library::cmd_get_photo_edit,
            library::cmd_save_photo_edit,
            library::cmd_export_xmp_sidecars,
            library::cmd_generate_story_events,
            library::cmd_get_story_events,
            library::cmd_get_story_photos,
            library::cmd_get_model_plugins,
            library::cmd_set_model_plugin_enabled,
            library::cmd_get_storage_sources,
            library::cmd_add_storage_source,
            library::cmd_scan_storage_source,
            library::cmd_remove_storage_source,
            library::cmd_get_library_settings,
            library::cmd_set_library_setting,
            library::cmd_get_ignored_faces,
            library::cmd_restore_ignored_faces,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PhotoFactory");
}

/// Gracefully shut down the AI worker Python process.
/// Called by commands that need to stop the worker, or on app teardown.
pub fn shutdown_ai_worker(state: &AiWorkerState) {
    let mut guard = state.process.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let pid = child.id();
        eprintln!("Shutting down AI worker (PID: {})...", pid);

        #[cfg(unix)]
        {
            // Send SIGTERM for graceful shutdown
            unsafe { libc::kill(pid as i32, libc::SIGTERM) };

            // Wait up to 5 seconds for the process to exit
            let start = std::time::Instant::now();
            while start.elapsed() < Duration::from_secs(5) {
                match child.try_wait() {
                    Ok(Some(_)) => {
                        eprintln!("AI worker exited gracefully");
                        return;
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                    Err(_) => break,
                }
            }

            // Force kill if it didn't exit
            eprintln!("AI worker did not exit within 5s, force killing");
            let _ = child.kill();
        }

        #[cfg(not(unix))]
        {
            // Windows: try taskkill /T /FI for graceful, then /F for force
            let _ = photofactory::process::background_command("taskkill")
                .args(["/PID", &pid.to_string()])
                .output();
            std::thread::sleep(Duration::from_secs(5));
            let _ = child.kill();
        }
    }
}
