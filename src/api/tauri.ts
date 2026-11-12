import { invoke } from "@tauri-apps/api/core";
import { queueFaceThumbnail } from "../utils/photoRequests";
import type {
  Photo, PhotoPage, PhotoCursor, PhotoFilter, AiClassification,
  FaceDetection, FaceCluster, CustomAttribute, Project,
  ThumbnailProcessingStatus, ThumbnailPerformance, PersonDetail, LabelNode,
  ManualTag, PhotoTimelineBucket, PhotoFilterOptions, ScanResult,
  LibraryJob, LibraryPhoto, DuplicateGroup, StoryEvent, ModelPlugin,
  StorageSource, IgnoredFace, PhotoEdit,
  Paged, PhotoMemory,
} from "../types";

const GITHUB_PROJECT_URL = "https://github.com/JackerKun/PhotoFactory";

export interface UpdateCheck {
  current_version: string;
  latest_release: { tag: string; version: string; is_newer: boolean } | null;
}

export function checkForUpdate(): Promise<UpdateCheck> {
  return invoke("cmd_check_for_update");
}

export function openGitHub(releaseTag?: string): Promise<void> {
  const path = releaseTag ? `${GITHUB_PROJECT_URL}/releases/tag/${encodeURIComponent(releaseTag)}` : GITHUB_PROJECT_URL;
  return invoke("plugin:shell|open", { path });
}

export async function createProject(rootPath: string, name: string): Promise<Project> {
  return invoke<Project>("cmd_create_project", { rootPath, name });
}

export async function openProject(rootPath: string): Promise<Project> {
  return invoke<Project>("cmd_open_project", { rootPath });
}

export async function scanProject(): Promise<number> {
  return invoke<number>("cmd_scan_project");
}

export async function getProject(): Promise<Project | null> {
  return invoke<Project | null>("cmd_get_project");
}

export async function getPhotos(cursor: PhotoCursor | null, limit: number, filter: PhotoFilter): Promise<PhotoPage> {
  return invoke<PhotoPage>("cmd_get_photos", { cursor, limit, filter });
}

export async function getPhotoTimeline(filter: PhotoFilter): Promise<PhotoTimelineBucket[]> {
  return invoke<PhotoTimelineBucket[]>("cmd_get_photo_timeline", { filter });
}

export async function getPhotoFilterOptions(filter: PhotoFilter): Promise<PhotoFilterOptions> {
  return invoke<PhotoFilterOptions>("cmd_get_photo_filter_options", { filter });
}

export async function updatePhotosRating(photoIds: number[], rating: number): Promise<number> {
  return invoke<number>("cmd_update_photos_rating", { photoIds, rating });
}

export async function getPhoto(photoId: number): Promise<Photo> {
  return invoke<Photo>("cmd_get_photo", { photoId });
}

export async function getLightboxPhotos(photoId: number): Promise<Photo[]> {
  return invoke<Photo[]>("cmd_get_lightbox_photos", { photoId });
}

export async function getPhotoClassifications(photoId: number): Promise<AiClassification[]> {
  return invoke<AiClassification[]>("cmd_get_photo_classifications", { photoId });
}

export async function getPhotoAttributes(photoId: number): Promise<CustomAttribute[]> {
  return invoke<CustomAttribute[]>("cmd_get_photo_attributes", { photoId });
}

export async function setPhotoAttribute(photoId: number, key: string, value: string): Promise<void> {
  return invoke("cmd_set_photo_attribute", { photoId, key, value });
}

export async function getThumbnailPath(photoId: number, size: string): Promise<string> {
  return invoke<string>("cmd_get_thumbnail_path", { photoId, size });
}

export async function getPhotoFaces(photoId: number): Promise<FaceDetection[]> {
  return invoke<FaceDetection[]>("cmd_get_photo_faces", { photoId });
}

export async function reassignPhotoFace(faceId: number, personId: number): Promise<void> {
  return invoke("cmd_reassign_photo_face", { faceId, personId });
}

export async function createNamedPersonForFace(faceId: number, name: string): Promise<number> {
  return invoke<number>("cmd_create_named_person_for_face", { faceId, name });
}

export async function deletePhotoFace(faceId: number): Promise<void> {
  return invoke("cmd_delete_photo_face", { faceId });
}

export async function getClusters(): Promise<FaceCluster[]> {
  return invoke<FaceCluster[]>("cmd_get_clusters");
}

export interface FaceClusterPage {
  items: FaceCluster[];
  total: number;
  named_count: number;
  unnamed_count: number;
  review_count: number;
}

export async function getClusterPage(tab: "named" | "unnamed" | "review", offset = 0, limit = 96): Promise<FaceClusterPage> {
  return invoke<FaceClusterPage>("cmd_get_cluster_page", { tab, offset, limit });
}

export async function renameCluster(clusterId: number, name: string): Promise<void> {
  return invoke("cmd_rename_cluster", { clusterId, name });
}

export async function confirmFaceCluster(clusterId: number): Promise<void> {
  return invoke("cmd_confirm_face_cluster", { clusterId });
}

export async function mergeClusters(fromId: number, toId: number): Promise<void> {
  return invoke("cmd_merge_clusters", { fromId, toId });
}

export async function mergeClustersBatch(clusterIds: number[], name?: string, targetClusterId?: number): Promise<number> {
  return invoke<number>("cmd_merge_clusters_batch", {
    clusterIds,
    name: name?.trim() || null,
    targetClusterId: targetClusterId ?? null,
  });
}

export async function getAllLabels(): Promise<[string, number][]> {
  return invoke<[string, number][]>("cmd_get_all_labels");
}

export async function renameClassificationLabel(oldLabel: string, newLabel: string): Promise<void> {
  return invoke("cmd_rename_classification_label", { oldLabel, newLabel });
}

export async function getManualTags(): Promise<ManualTag[]> {
  return invoke<ManualTag[]>("cmd_get_manual_tags");
}

export interface AiTagSummary {
  label: string;
  category: string;
  source: string;
  photo_count: number;
  average_confidence: number;
}

export interface AiTagGroup {
  category: string;
  labels: AiTagSummary[];
}

export async function getAiTagGroups(): Promise<AiTagGroup[]> {
  return invoke<AiTagGroup[]>("cmd_get_ai_tag_groups");
}

export async function getPhotoManualTags(photoId: number): Promise<ManualTag[]> {
  return invoke<ManualTag[]>("cmd_get_photo_manual_tags", { photoId });
}

export async function createManualTag(name: string, color: string): Promise<number> {
  return invoke<number>("cmd_create_manual_tag", { name, color });
}

export async function updateManualTag(tagId: number, name: string, color: string): Promise<void> {
  return invoke("cmd_update_manual_tag", { tagId, name, color });
}

export async function deleteManualTag(tagId: number): Promise<void> {
  return invoke("cmd_delete_manual_tag", { tagId });
}

export async function setPhotoManualTags(photoId: number, tagIds: number[]): Promise<void> {
  return invoke("cmd_set_photo_manual_tags", { photoId, tagIds });
}

export async function getPhotosWithGps(
  minLat: number, maxLat: number, minLng: number, maxLng: number, limit: number
): Promise<Photo[]> {
  return invoke<Photo[]>("cmd_get_photos_with_gps", { minLat, maxLat, minLng, maxLng, limit });
}

export type TrackBounds = [west: number, south: number, east: number, north: number];
export type TrackPhoto = Pick<Photo, "filename"> & {
  id: number;
  taken_at: number;
  latitude: number;
  longitude: number;
};

export function getTrackPhotos(bounds: TrackBounds, startAt: number | null, endBefore: number | null) {
  return invoke<TrackPhoto[]>("cmd_get_track_photos", { bounds, startAt, endBefore });
}

export interface TrackSettings {
  bounds: TrackBounds;
  start_date: string;
  end_date: string;
  joined_gaps: string[];
}

export interface SavedTrack {
  id: number;
  name: string;
  settings: TrackSettings;
}

export function listPhotoTracks() {
  return invoke<SavedTrack[]>("cmd_list_photo_tracks");
}

export function savePhotoTrack(id: number | null, name: string, settings: TrackSettings) {
  return invoke<SavedTrack>("cmd_save_photo_track", { id, name, settings });
}

export function deletePhotoTrack(id: number) {
  return invoke<void>("cmd_delete_photo_track", { id });
}

export type MapLayerStyle = "standard" | "satellite";

export interface OfflineMapPackage {
  id: string;
  name: string;
  layer: MapLayerStyle;
  min_zoom: number;
  max_zoom: number;
  bounds: [west: number, south: number, east: number, north: number] | null;
  attribution: string | null;
  bytes: number;
}

export function listOfflineMaps(): Promise<OfflineMapPackage[]> {
  return invoke("cmd_list_offline_maps");
}

export function importOfflineMap(paths: string[]): Promise<OfflineMapPackage[]> {
  return invoke("cmd_import_offline_map", { paths });
}

export function exportOfflineMap(path: string, layer: MapLayerStyle | "both"): Promise<{ tile_count: number; bytes: number }> {
  return invoke("cmd_export_offline_map", { path, layer });
}

export function getMapTile(z: number, x: number, y: number, layer: MapLayerStyle = "standard"): Promise<string | null> {
  return invoke("cmd_get_map_tile", { z, x, y, layer });
}

export interface MapTileResult { url: string; source: "package" | "cache" | "network" }
export function getMapTileStatus(z: number, x: number, y: number, layer: MapLayerStyle = "standard"): Promise<MapTileResult> {
  return invoke("cmd_get_map_tile_status", { z, x, y, layer });
}

export async function hasMapTile(z: number, x: number, y: number, layer: MapLayerStyle = "standard"): Promise<boolean> {
  return invoke<boolean>("cmd_has_map_tile", { z, x, y, layer });
}

export async function getPhotoDirectories(): Promise<string[]> {
  return invoke<string[]>("cmd_get_photo_directories");
}

export async function startThumbnailBatch(): Promise<string> {
  return invoke<string>("cmd_start_thumbnail_batch");
}

export function getThumbnailPerformance(): Promise<ThumbnailPerformance> {
  return invoke("cmd_get_thumbnail_performance");
}

export function setThumbnailPerformance(mode: ThumbnailPerformance): Promise<void> {
  return invoke("cmd_set_thumbnail_performance", { mode });
}

export async function getThumbnailProcessingStatus(): Promise<ThumbnailProcessingStatus> {
  return invoke<ThumbnailProcessingStatus>("cmd_get_thumbnail_processing_status");
}

export async function rebuildThumbnailCache(): Promise<string> {
  return invoke<string>("cmd_rebuild_thumbnail_cache");
}

export async function getPhotoDataUrl(photoPath: string): Promise<string> {
  return invoke<string>("cmd_get_photo_data_url", { photoPath });
}

export async function togglePhotoFavorite(photoId: number): Promise<boolean> {
  return invoke<boolean>("cmd_toggle_photo_favorite", { photoId });
}

export async function updatePhotoGps(photoId: number, latitude: number | null, longitude: number | null): Promise<void> {
  return invoke("cmd_update_photo_gps", { photoId, latitude, longitude });
}

export async function updatePhotosGps(photoIds: number[], latitude: number | null, longitude: number | null): Promise<number> {
  return invoke<number>("cmd_update_photos_gps", { photoIds, latitude, longitude });
}

export interface PhotoGpsUpdate {
  photoId: number;
  latitude: number | null;
  longitude: number | null;
}

export async function updatePhotosGpsIndividual(updates: PhotoGpsUpdate[]): Promise<number> {
  return invoke<number>("cmd_update_photos_gps_individual", { updates });
}

export async function saveLastProjectPath(rootPath: string): Promise<void> {
  return invoke("cmd_save_last_project_path", { rootPath });
}

export async function getLastProjectPath(): Promise<string | null> {
  return invoke<string | null>("cmd_get_last_project_path");
}

export async function revealInFileManager(path: string): Promise<void> {
  return invoke("cmd_reveal_in_file_manager", { path });
}

export async function workerHealth(): Promise<boolean> {
  return invoke<boolean>("cmd_worker_health");
}

export async function startAiWorker(port?: number): Promise<string> {
  return invoke<string>("cmd_start_ai_worker", { port: port ?? 9876 });
}

export async function runAiClassification(batchSize?: number): Promise<number> {
  return invoke<number>("cmd_run_ai_classification", { batchSize });
}

export async function runAiFaceDetection(batchSize?: number): Promise<number> {
  return invoke<number>("cmd_run_face_detection", { batchSize });
}

export async function autoAiPipeline(): Promise<string> {
  return invoke<string>("cmd_auto_ai_pipeline");
}

export async function runFaceClustering(): Promise<string> {
  return invoke<string>("cmd_run_face_clustering");
}

export async function rebuildFaceClusters(): Promise<string> {
  return invoke<string>("cmd_rebuild_face_clusters");
}

export async function autoMergeUnnamedFaces(threshold: number): Promise<string> {
  return invoke<string>("cmd_auto_merge_unnamed_faces", { threshold });
}

export interface AutomaticFaceMergeCandidate {
  cluster_ids: number[];
  similarity: number;
  face_count: number;
}

export async function previewAutoMergeUnnamedFaces(threshold: number): Promise<AutomaticFaceMergeCandidate[]> {
  return invoke<AutomaticFaceMergeCandidate[]>("cmd_preview_auto_merge_unnamed_faces", { threshold });
}

export async function applyAutoMergeUnnamedFaces(mergeGroups: number[][], threshold: number): Promise<string> {
  return invoke<string>("cmd_apply_auto_merge_unnamed_faces", { mergeGroups, threshold });
}

export async function rejectAutoMergeCandidate(clusterIds: number[]): Promise<void> {
  return invoke("cmd_reject_auto_merge_candidate", { clusterIds });
}

export async function undoLastAutomaticFaceMerge(): Promise<string> {
  return invoke<string>("cmd_undo_last_automatic_face_merge");
}

export async function hasAutomaticFaceMergeToUndo(): Promise<boolean> {
  return invoke<boolean>("cmd_has_automatic_face_merge_to_undo");
}

export async function getClusterFaceThumbnail(clusterId: number, signal?: AbortSignal): Promise<string> {
  return queueFaceThumbnail(() => invoke<string>("cmd_get_cluster_face_thumbnail", { clusterId }), signal);
}

export interface SuspectedFace {
  id: number;
  photo_id: number;
  quality_score: number;
  detection_confidence: number;
}

export async function getSuspectedFaces(limit = 200): Promise<SuspectedFace[]> {
  return invoke<SuspectedFace[]>("cmd_get_suspected_faces", { limit });
}

export async function getSuspectedFaceCount(): Promise<number> {
  return invoke<number>("cmd_get_suspected_face_count");
}

export async function ignoreFaceClusters(clusterIds: number[]): Promise<string> {
  return invoke<string>("cmd_ignore_face_clusters", { clusterIds });
}

export async function getIgnoredFaceCount(): Promise<number> {
  return invoke<number>("cmd_get_ignored_face_count");
}

export async function restoreAllIgnoredFaces(): Promise<string> {
  return invoke<string>("cmd_restore_all_ignored_faces");
}

export async function getFaceThumbnail(faceId: number, signal?: AbortSignal): Promise<string> {
  return queueFaceThumbnail(() => invoke<string>("cmd_get_face_thumbnail", { faceId }), signal);
}

export async function keepSuspectedFace(faceId: number): Promise<void> {
  return invoke("cmd_keep_suspected_face", { faceId });
}

export async function deleteAllSuspectedFaces(): Promise<number> {
  return invoke<number>("cmd_delete_all_suspected_faces");
}

export interface FaceAiVersionStatus {
  current_version: string;
  stored_version: string | null;
  upgrade_available: boolean;
}

export async function getFaceAiVersionStatus(): Promise<FaceAiVersionStatus> {
  return invoke<FaceAiVersionStatus>("cmd_get_face_ai_version_status");
}

export async function prepareFaceAiReanalysis(): Promise<string> {
  return invoke<string>("cmd_prepare_face_ai_reanalysis");
}

export async function getLabelPreview(label: string): Promise<string> {
  return invoke<string>("cmd_get_label_preview", { label });
}

export async function getLabelHierarchy(): Promise<LabelNode[]> {
  return invoke<LabelNode[]>("cmd_get_label_hierarchy");
}

export async function getLabelsByType(tagType: string): Promise<[string, number][]> {
  return invoke<[string, number][]>("cmd_get_labels_by_type", { tagType });
}

export async function rebuildLabelHierarchy(): Promise<void> {
  return invoke("cmd_rebuild_label_hierarchy");
}

export async function getLabelPhotoCount(label: string): Promise<number> {
  return invoke<number>("cmd_get_label_photo_count", { label });
}

export async function closeProject(): Promise<void> {
  return invoke("cmd_close_project");
}

export async function updateExtensions(extensions: string[]): Promise<Project> {
  return invoke<Project>("cmd_update_extensions", { extensions });
}

export async function incrementalScan(): Promise<ScanResult> {
  return invoke<ScanResult>("cmd_incremental_scan");
}

export async function triggerAutoAi(): Promise<string> {
  return invoke<string>("cmd_trigger_auto_ai");
}

export interface AiRuntimeInfo {
  available: string[];
  models: Record<string, string>;
  face_batch: { photos?: number; preview_hits?: number; elapsed_ms?: number; decode_ms?: number; detect_ms?: number; embed_ms?: number };
  cluster_ms?: number | null;
}

export function getAiRuntime(): Promise<AiRuntimeInfo | null> {
  return invoke("cmd_get_ai_runtime");
}

export async function getAiPipelineStatus(): Promise<import("../types").AiProcessingStatus> {
  return invoke<import("../types").AiProcessingStatus>("cmd_get_ai_pipeline_status");
}

export interface TaskErrorGroupKey {
  stage: string;
  reason: string;
  through: number;
}

export interface TaskErrorGroup {
  key: TaskErrorGroupKey;
  message: string;
  occurred_at: number;
  first_occurred_at: number;
  occurrences: number;
}

export interface TaskErrorPage {
  groups: TaskErrorGroup[];
  stages: string[];
  next_before: number | null;
  history_through: number;
  retryable: number;
  failed_faces: number;
  failed_classifications: number;
  ignored_count: number;
  platform: string;
  architecture: string;
  version: string;
}

export interface TaskErrorGroupPhotos {
  photos: {
    photo_id: number | null;
    filename: string;
    path: string;
    attempts: number | null;
    occurred_at: number;
    ignored: boolean;
    can_ignore: boolean;
  }[];
  next_after: string | null;
  total: number;
  can_ignore: number;
}

export interface IgnoredTaskPhotos {
  photos: { photo_id: number; stage: string; filename: string; path: string }[];
  next_offset: number | null;
}

export function getTaskErrors(stage: string | null, before: number | null): Promise<TaskErrorPage> {
  return invoke("cmd_get_task_errors", { stage, before });
}

export function clearTaskErrorHistory(projectPath: string, through: number): Promise<number> {
  return invoke("cmd_clear_task_error_history", { projectPath, through });
}

export function getTaskErrorPhotos(key: TaskErrorGroupKey, after: string | null): Promise<TaskErrorGroupPhotos> {
  return invoke("cmd_get_task_error_photos", { key, after });
}

export function getIgnoredTaskPhotos(offset: number): Promise<IgnoredTaskPhotos> {
  return invoke("cmd_get_ignored_task_photos", { offset });
}

export function ignoreTaskErrorPhotos(projectPath: string, key: TaskErrorGroupKey, photoId: number | null): Promise<number> {
  return invoke("cmd_ignore_task_error_photos", { projectPath, key, photoId });
}

export function restoreTaskPhoto(projectPath: string, stage: string, photoId: number): Promise<number> {
  return invoke("cmd_restore_task_photo", { projectPath, stage, photoId });
}

export async function controlAiPipeline(action: "pause" | "resume" | "cancel" | "retry"): Promise<string> {
  return invoke<string>("cmd_control_ai_pipeline", { action });
}

export async function recalculateAiTags(): Promise<string> {
  return invoke<string>("cmd_recalculate_ai_tags");
}

export interface MapSearchResult {
  lat: number;
  lng: number;
  display_name: string;
}

export async function searchMapLocation(query: string): Promise<MapSearchResult[]> {
  return invoke<MapSearchResult[]>("cmd_search_map_location", { query });
}

export async function addFaceConstraint(
  photoId1: number, faceIndex1: number,
  photoId2: number, faceIndex2: number,
  constraintType: "must_link" | "cannot_link"
): Promise<void> {
  return invoke("cmd_add_face_constraint", {
    photoId1, faceIndex1, photoId2, faceIndex2, constraintType
  });
}

export async function removeFaceConstraint(constraintId: number): Promise<void> {
  return invoke("cmd_remove_face_constraint", { constraintId });
}

export async function getPersonDetail(personId: number): Promise<PersonDetail> {
  return invoke<PersonDetail>("cmd_get_person_detail", { personId });
}

export async function getPersonTimeline(personId: number): Promise<[string, number][]> {
  return invoke<[string, number][]>("cmd_get_person_timeline", { personId });
}

export async function getPersonSceneTags(personId: number): Promise<[string, number][]> {
  return invoke<[string, number][]>("cmd_get_person_scene_tags", { personId });
}

export async function splitPerson(personId: number, faceIds: number[]): Promise<number> {
  return invoke("cmd_split_person", { personId, faceIds });
}

export async function runEventTagging(): Promise<number> {
  return invoke<number>("cmd_run_event_tagging");
}

export async function getSmartAlbums(): Promise<any[]> {
  return await invoke("cmd_get_smart_albums");
}

export async function getPhotoMemories(): Promise<PhotoMemory[]> {
  return invoke<PhotoMemory[]>("cmd_get_photo_memories");
}

export async function setPhotoMemoryPreferences(projectRoot: string, memoryId: number, favorite: boolean, tags: string[]) {
  return invoke<void>("cmd_set_photo_memory_preferences", { projectRoot, memoryId, favorite, tags });
}

export async function beginMemoryVideo(destination: string) {
  return invoke<string>("cmd_begin_memory_video", { destination });
}

export async function appendMemoryVideo(id: string, bytes: ArrayBuffer) {
  return invoke<void>("cmd_append_memory_video", bytes, { headers: { "x-photo-video-id": id } });
}

export async function finishMemoryVideo(id: string, save: boolean) {
  return invoke<void>("cmd_finish_memory_video", { id, save });
}

export async function getSmartAlbumPhotos(albumId: number, cursor?: number, limit?: number): Promise<any[]> {
  return await invoke("cmd_get_smart_album_photos", { albumId, cursor, limit: limit || 100 });
}

export async function regenerateSmartAlbums(): Promise<number> {
  return await invoke("cmd_regenerate_smart_albums");
}

export async function createManualAlbum(name: string): Promise<number> {
  return invoke<number>("cmd_create_manual_album", { name });
}

export async function renameAlbum(albumId: number, name: string): Promise<void> {
  return invoke("cmd_rename_album", { albumId, name });
}

export async function deleteAlbum(albumId: number): Promise<void> {
  return invoke("cmd_delete_album", { albumId });
}

export async function addPhotosToAlbum(albumId: number, photoIds: number[]): Promise<number> {
  return invoke<number>("cmd_add_photos_to_album", { albumId, photoIds });
}

export async function removePhotosFromAlbum(albumId: number, photoIds: number[]): Promise<number> {
  return invoke<number>("cmd_remove_photos_from_album", { albumId, photoIds });
}

export async function setAlbumCover(albumId: number, photoId: number): Promise<void> {
  return invoke("cmd_set_album_cover", { albumId, photoId });
}

export async function getFaceDetectionCount(): Promise<number> {
  return invoke<number>("cmd_get_face_detection_count");
}

export async function getUnassignedFaceCount(): Promise<number> {
  return invoke<number>("cmd_get_unassigned_face_count");
}

export async function runTagRules(): Promise<string> {
  return invoke<string>("cmd_run_tag_rules");
}

export async function getRecentProjects(): Promise<string[]> {
  return invoke<string[]>("cmd_get_recent_projects");
}

export async function addRecentProject(rootPath: string): Promise<void> {
  return invoke("cmd_add_recent_project", { rootPath });
}

export async function removeRecentProject(rootPath: string): Promise<void> {
  return invoke("cmd_remove_recent_project", { rootPath });
}

export const getLibraryJobs = () => invoke<LibraryJob[]>("cmd_get_library_jobs");
export const controlLibraryJob = (jobId:number, action:"pause"|"resume"|"cancel") => invoke<void>("cmd_control_library_job", { jobId, action });
export const startLibraryAnalysis = (withOcr:boolean) => invoke<number>("cmd_start_library_analysis", { withOcr });
export const retryLibraryAnalysis = (jobId: number) => invoke<number>("cmd_retry_library_analysis", { jobId });
export const smartSearch = (query:string, includePrivate=false, offset=0, limit=60) => invoke<Paged<LibraryPhoto>>("cmd_smart_search", { query, includePrivate, offset, limit });
export const getDuplicateGroups = (offset=0, limit=20) => invoke<Paged<DuplicateGroup>>("cmd_get_duplicate_groups", { offset, limit });
export const getRawJpegStacks = (offset=0, limit=20) => invoke<Paged<DuplicateGroup>>("cmd_get_raw_jpeg_stacks", { offset, limit });
export const getDuplicateGroupPhotos = (groupId:string, offset=0, limit=60) => invoke<Paged<LibraryPhoto>>("cmd_get_duplicate_group_photos", { groupId, offset, limit });
export const trashDuplicateGroup = (groupId:string) => invoke<number>("cmd_trash_duplicate_group", { groupId });
export const movePhotosToTrash = (photoIds:number[], reason:string) => invoke<number>("cmd_move_photos_to_trash", { photoIds, reason });
export const getTrashedPhotos = (offset=0, limit=60) => invoke<Paged<LibraryPhoto>>("cmd_get_trashed_photos", { offset, limit });
export const restoreTrashedPhotos = (photoIds:number[]) => invoke<number>("cmd_restore_trashed_photos", { photoIds });
export const setPhotoPrivacy = (photoIds:number[], isPrivate:boolean, isSensitive:boolean) => invoke<number>("cmd_set_photo_privacy", { photoIds, isPrivate, isSensitive });
export const getPhotoEdit = (photoId:number) => invoke<PhotoEdit|null>("cmd_get_photo_edit", { photoId });
export const savePhotoEdit = (edit:PhotoEdit) => invoke<void>("cmd_save_photo_edit", { edit });
export const exportXmpSidecars = (photoIds:number[]) => invoke<number>("cmd_export_xmp_sidecars", { photoIds });
export const generateStoryEvents = () => invoke<number>("cmd_generate_story_events");
export const getStoryEvents = (offset=0, limit=30) => invoke<Paged<StoryEvent>>("cmd_get_story_events", { offset, limit });
export const getStoryPhotos = (eventId:number, offset=0, limit=60) => invoke<Paged<LibraryPhoto>>("cmd_get_story_photos", { eventId, offset, limit });
export const getModelPlugins = () => invoke<ModelPlugin[]>("cmd_get_model_plugins");
export const setModelPluginEnabled = (pluginId:string, enabled:boolean) => invoke<void>("cmd_set_model_plugin_enabled", { pluginId, enabled });
export const getStorageSources = () => invoke<StorageSource[]>("cmd_get_storage_sources");
export const addStorageSource = (path:string, label:string, readOnly:boolean) => invoke<number>("cmd_add_storage_source", { path, label, readOnly });
export const scanStorageSource = (sourceId:number) => invoke<ScanResult>("cmd_scan_storage_source", { sourceId });
export const removeStorageSource = (sourceId:number) => invoke<number>("cmd_remove_storage_source", { sourceId });
export const getLibrarySettings = () => invoke<Record<string,string>>("cmd_get_library_settings");
export const setLibrarySetting = (key:string, value:string) => invoke<void>("cmd_set_library_setting", { key, value });
export const getIgnoredFaces = (offset=0, limit=40) => invoke<Paged<IgnoredFace>>("cmd_get_ignored_faces", { offset, limit });
export const restoreIgnoredFaces = (faceIds:number[]) => invoke<number>("cmd_restore_ignored_faces", { faceIds });


export interface GroupPhotoItem {
  photo: Photo;
  people_count: number;
  unconfirmed_count: number;
}

export interface NamedPhotoGroup {
  person_ids: number[];
  names: string[];
  cover_photo_id: number;
  photo_count: number;
}

export function getNamedPhotoGroups(size: number, personIds: number[], exact: boolean, offset = 0): Promise<NamedPhotoGroup[]> {
  return invoke("cmd_get_named_photo_groups", { size, personIds, exact, offset });
}

export function getGroupPhotos(size: number, personIds: number[], exact: boolean, cursor?: number, namedOnly?: boolean): Promise<GroupPhotoItem[]> {
  return invoke("cmd_get_group_photos", { size, personIds, exact, cursor, namedOnly });
}

export function createPersonCombination(name: string, personIds: number[], exact: boolean): Promise<number> {
  return invoke("cmd_create_person_combination", { name, personIds, exact });
}
