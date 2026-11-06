import { invoke } from "@tauri-apps/api/core";
import type {
  Photo, PhotoPage, PhotoCursor, PhotoFilter, AiClassification,
  FaceDetection, FaceCluster, CustomAttribute, Project,
  ThumbnailProcessingStatus, PersonDetail, LabelNode,
  ManualTag, PhotoTimelineBucket, PhotoFilterOptions, ScanResult,
  LibraryJob, LibraryPhoto, DuplicateGroup, StoryEvent, ModelPlugin,
  StorageSource, IgnoredFace, PhotoEdit,
  Paged,
} from "../types";

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

export type MapLayerStyle = "standard" | "satellite";

export async function getMapTile(z: number, x: number, y: number, layer: MapLayerStyle = "standard"): Promise<string> {
  return invoke<string>("cmd_get_map_tile", { z, x, y, layer });
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

export async function getClusterFaceThumbnail(clusterId: number): Promise<string> {
  return invoke<string>("cmd_get_cluster_face_thumbnail", { clusterId });
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

export async function getFaceThumbnail(faceId: number): Promise<string> {
  return invoke<string>("cmd_get_face_thumbnail", { faceId });
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

export async function getAiPipelineStatus(): Promise<import("../types").AiProcessingStatus> {
  return invoke<import("../types").AiProcessingStatus>("cmd_get_ai_pipeline_status");
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
