export interface Photo {
  id: number | null;
  path: string;
  filename: string;
  file_size: number;
  file_mtime: number;
  width: number | null;
  height: number | null;
  format: string | null;
  taken_at: number | null;
  camera_make: string | null;
  camera_model: string | null;
  exposure_time: string | null;
  f_number: string | null;
  iso: number | null;
  latitude: number | null;
  longitude: number | null;
  orientation: number;
  thumbnail_status: number;
  ai_status: number;
  deleted: boolean;
  is_favorite: boolean;
  rating: number;
  imported_at: number;
}

export interface PhotoPage {
  photos: Photo[];
  next_cursor: PhotoCursor | null;
  has_more: boolean;
  total_count: number;
}

export interface PhotoTimelineBucket {
  year: number;
  month: number;
  count: number;
}

export interface PhotoCursor {
  id: number;
  sort_value: number;
  sort_text?: string | null;
}

export type PhotoSortBy = "capture_date" | "created_date" | "modified_date" | "name";
export type SortDirection = "asc" | "desc";

export interface PhotoFilter {
  directory?: string;
  tag?: string;
  person_id?: number;
  has_gps?: boolean;
  has_favorite?: boolean;
  year?: number;
  month?: number;
  keyword?: string;
  format?: string;
  camera?: string;
  iso_min?: number;
  iso_max?: number;
  aperture_min?: number;
  aperture_max?: number;
  exposure_time?: string;
  orientation_kind?: "landscape" | "portrait" | "square";
  rating_min?: number;
  rating_max?: number;
  sort_by?: PhotoSortBy;
  sort_direction?: SortDirection;
}

export interface PhotoFilterFacet {
  value: string;
  count: number;
}

export interface PhotoFilterOptions {
  formats: PhotoFilterFacet[];
  cameras: PhotoFilterFacet[];
  exposure_times: PhotoFilterFacet[];
  iso_min: number | null;
  iso_max: number | null;
  aperture_min: number | null;
  aperture_max: number | null;
}

export interface AiClassification {
  id: number | null;
  photo_id: number;
  category: string;
  label: string;
  confidence: number;
}

export interface FaceDetection {
  id: number | null;
  photo_id: number;
  bbox_x: number;
  bbox_y: number;
  bbox_w: number;
  bbox_h: number;
  embedding_path: string | null;
  person_id: number | null;
  created_at: number;
}

export interface FaceCluster {
  id: number | null;
  name: string | null;
  face_count: number;
  photo_count: number;
  confidence: "low" | "medium" | "high";
  created_at: number;
}

export interface ScanResult {
  added: number;
  updated: number;
  restored: number;
  deleted: number;
  unchanged: number;
}

export interface CustomAttribute {
  id: number | null;
  photo_id: number;
  key: string;
  value: string;
}

export interface ManualTag {
  id: number;
  name: string;
  color: string;
  photo_count: number;
}

export interface Project {
  name: string;
  root_path: string;
  created_at: string;
  last_scan: string | null;
  total_photos: number;
  thumbnail_threshold_mb: number;
  ai_models: {
    face_detection: string;
    face_recognition: string;
    scene_classification: string;
  };
  enabled_extensions: string[];
}

export type ViewMode = "grid" | "map" | "faces" | "tags" | "albums" | "library";

export interface LibraryJob { id:number; job_type:string; status:string; progress:number; total:number; message:string; error:string|null; created_at:number; updated_at:number }
export interface Paged<T> { items:T[]; total:number; offset:number; has_more:boolean }
export interface LibraryPhoto { id:number; path:string; filename:string; rating:number; is_favorite:boolean; taken_at:number|null; ocr_text:string; quality_score:number; duplicate_group:string|null; stack_key:string|null; best_in_group:boolean; is_private:boolean; is_sensitive:boolean; trashed_at:number|null }
export interface DuplicateGroup { group_id:string; count:number; best_photo_id:number|null; photo_ids:number[] }
export interface StoryEvent { id:number; name:string; start_at:number|null; end_at:number|null; cover_photo_id:number|null; photo_count:number }
export interface ModelPlugin { id:string; name:string; capability:string; version:string; enabled:boolean; status:string }
export interface StorageSource { id:number; path:string; label:string; kind:string; status:string; read_only:boolean; last_seen:number|null; photo_count:number; is_primary:boolean }
export interface IgnoredFace { id:number; photo_id:number; ignored_at:number }
export interface PhotoEdit { photo_id:number; crop_json:string; rotation:number; exposure:number; contrast:number; temperature:number; updated_at:number }

export interface ThumbnailProcessingStatus {
  running: boolean;
  batch_size: number;
  total_pending: number;
  processed: number;
  succeeded: number;
  failed: number;
  current_file: string | null;
  last_error: string | null;
}

export interface AiProcessingStatus {
  status?: "idle" | "running" | "paused" | "canceled" | "done" | "error";
  stage: "starting" | "recovering_faces" | "face_detection" | "classification" | "clustering" | "clustering_done" | "clustering_error" | "paused" | "canceled" | "done" | "error" | "idle" | null;
  processed: number;
  total: number;
  failed?: number;
  photos_per_second?: number;
  eta_seconds?: number | null;
  last_error?: string | null;
}

// Layered thumbnail types
export type ThumbnailSize = "small" | "medium" | "large";
export type ThumbnailState = "placeholder" | "loading" | "loaded" | "upgrading";

export interface ThumbnailInfo {
  smallUrl: string | null;
  mediumUrl: string | null;
  state: ThumbnailState;
}

// Face constraint types
export interface FaceConstraint {
  id: number;
  photo_id_1: number;
  face_index_1: number;
  photo_id_2: number;
  face_index_2: number;
  constraint_type: "must_link" | "cannot_link";
  created_at: string;
}

// Person metadata
export interface PersonDetail {
  person_id: number;
  user_name: string | null;
  face_count: number;
  confidence: "high" | "medium" | "low";
  first_seen: string | null;
  last_seen: string | null;
  cover_photo_id: number | null;
}

// Label hierarchy
export interface LabelNode {
  id: number;
  label: string;
  parent_id: number | null;
  label_type: "ai_scene" | "geo_location" | "time_period" | "event" | "device";
  count: number;
  preview_thumbnail: string | null;
  children: LabelNode[];
}

// Smart album types
export interface SmartAlbum {
  id: number;
  name: string;
  album_type: "travel" | "monthly" | "themed" | "person" | "manual";
  rule_json: string;
  cover_photo_id: number | null;
  photo_count: number;
  created_at: string;
  updated_at: string;
}
