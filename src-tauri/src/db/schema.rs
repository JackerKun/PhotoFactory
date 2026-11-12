pub const CREATE_TABLES: &str = r#"
CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    filename TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    file_mtime INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    format TEXT,
    taken_at INTEGER,
    camera_make TEXT,
    camera_model TEXT,
    latitude REAL,
    longitude REAL,
    orientation INTEGER DEFAULT 1,
    thumbnail_status INTEGER DEFAULT 0,
    ai_status INTEGER DEFAULT 0,
    face_status INTEGER DEFAULT 0,
    classification_status INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0,
    is_favorite INTEGER DEFAULT 0,
    rating INTEGER NOT NULL DEFAULT 0 CHECK(rating BETWEEN 0 AND 5),
    exposure_time TEXT,
    f_number TEXT,
    iso INTEGER,
    storage_source_id INTEGER REFERENCES storage_sources(id),
    imported_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_classifications (
    id INTEGER PRIMARY KEY,
    photo_id INTEGER NOT NULL REFERENCES photos(id),
    category TEXT NOT NULL,
    label TEXT NOT NULL,
    confidence REAL NOT NULL,
    manual_tag_synced INTEGER DEFAULT 0,
    UNIQUE(photo_id, label)
);

CREATE TABLE IF NOT EXISTS face_detections (
    id INTEGER PRIMARY KEY,
    photo_id INTEGER NOT NULL REFERENCES photos(id),
    bbox_x INTEGER,
    bbox_y INTEGER,
    bbox_w INTEGER,
    bbox_h INTEGER,
    embedding_path TEXT,
    person_id INTEGER REFERENCES face_clusters(id),
    quality_score REAL DEFAULT 0.0,
    detection_confidence REAL DEFAULT 0.0,
    landmarks_json TEXT,
    pose_yaw REAL DEFAULT 0.0,
    pose_pitch REAL DEFAULT 0.0,
    pose_roll REAL DEFAULT 0.0,
    alignment_success INTEGER DEFAULT 0,
    review_status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS face_clusters (
    id INTEGER PRIMARY KEY,
    name TEXT,
    face_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_attributes (
    id INTEGER PRIMARY KEY,
    photo_id INTEGER NOT NULL REFERENCES photos(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    UNIQUE(photo_id, key)
);

CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY,
    event_type TEXT NOT NULL,
    path TEXT NOT NULL,
    timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS face_constraints (
    id INTEGER PRIMARY KEY,
    photo_id_1 INTEGER NOT NULL,
    face_index_1 INTEGER NOT NULL,
    photo_id_2 INTEGER NOT NULL,
    face_index_2 INTEGER NOT NULL,
    constraint_type TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (photo_id_1) REFERENCES photos(id),
    FOREIGN KEY (photo_id_2) REFERENCES photos(id)
);

CREATE TABLE IF NOT EXISTS person_metadata (
    person_id INTEGER PRIMARY KEY,
    user_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    confidence TEXT DEFAULT 'medium',
    centroid_cached INTEGER DEFAULT 1,
    FOREIGN KEY (person_id) REFERENCES face_clusters(id)
);

CREATE TABLE IF NOT EXISTS face_merge_operations (
    id INTEGER PRIMARY KEY,
    threshold REAL NOT NULL,
    merged_group_count INTEGER NOT NULL DEFAULT 0,
    removed_cluster_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'applied',
    created_at INTEGER NOT NULL,
    undone_at INTEGER
);

CREATE TABLE IF NOT EXISTS face_merge_history (
    operation_id INTEGER NOT NULL REFERENCES face_merge_operations(id),
    face_id INTEGER NOT NULL,
    original_person_id INTEGER NOT NULL,
    merged_person_id INTEGER NOT NULL,
    PRIMARY KEY (operation_id, face_id)
);

CREATE TABLE IF NOT EXISTS ai_model_state (
    component TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS smart_albums (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    album_type TEXT NOT NULL,
    rule_json TEXT NOT NULL,
    cover_photo_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS smart_album_photos (
    album_id INTEGER NOT NULL,
    photo_id INTEGER NOT NULL,
    position INTEGER DEFAULT 0,
    PRIMARY KEY (album_id, photo_id),
    FOREIGN KEY (album_id) REFERENCES smart_albums(id),
    FOREIGN KEY (photo_id) REFERENCES photos(id)
);

CREATE TABLE IF NOT EXISTS manual_tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color TEXT NOT NULL DEFAULT '#5B8DEF',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS photo_manual_tags (
    photo_id INTEGER NOT NULL REFERENCES photos(id),
    tag_id INTEGER NOT NULL REFERENCES manual_tags(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (photo_id, tag_id)
);

CREATE TABLE IF NOT EXISTS photo_intelligence (
    photo_id INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
    ocr_text TEXT NOT NULL DEFAULT '', perceptual_hash TEXT,
    sharpness REAL NOT NULL DEFAULT 0, quality_score REAL NOT NULL DEFAULT 0,
    duplicate_group TEXT, stack_key TEXT, best_in_group INTEGER NOT NULL DEFAULT 0,
    is_private INTEGER NOT NULL DEFAULT 0, is_sensitive INTEGER NOT NULL DEFAULT 0,
    analyzed_at INTEGER
);
CREATE TABLE IF NOT EXISTS library_jobs (
    id INTEGER PRIMARY KEY, job_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
    progress INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '', error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS photo_trash (
    photo_id INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT '', trashed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS photo_tracks (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    settings TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS photo_edits (
    photo_id INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
    crop_json TEXT NOT NULL DEFAULT '', rotation REAL NOT NULL DEFAULT 0,
    exposure REAL NOT NULL DEFAULT 0, contrast REAL NOT NULL DEFAULT 0,
    temperature REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS story_events (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, start_at INTEGER, end_at INTEGER,
    cover_photo_id INTEGER REFERENCES photos(id), created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS story_event_photos (
    event_id INTEGER NOT NULL REFERENCES story_events(id) ON DELETE CASCADE,
    photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(event_id, photo_id)
);
CREATE TABLE IF NOT EXISTS model_plugins (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, capability TEXT NOT NULL,
    version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'available', config_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS storage_sources (
    id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'local', status TEXT NOT NULL DEFAULT 'online',
    read_only INTEGER NOT NULL DEFAULT 0, last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS library_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_photo_tasks (
    photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    model_version TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    error TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(photo_id, stage)
);
CREATE TABLE IF NOT EXISTS ai_pipeline_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    status TEXT NOT NULL DEFAULT 'idle',
    stage TEXT NOT NULL DEFAULT 'idle',
    total INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER,
    stage_started_at INTEGER,
    stage_base_processed INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);
INSERT OR IGNORE INTO ai_pipeline_state(id,status,stage,updated_at) VALUES(1,'idle','idle',0);

CREATE TABLE IF NOT EXISTS task_error_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    photos_json TEXT NOT NULL,
    occurred_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photos_path ON photos(path);
CREATE INDEX IF NOT EXISTS idx_photos_taken_at ON photos(taken_at);
CREATE INDEX IF NOT EXISTS idx_photos_rating ON photos(rating, deleted);
CREATE INDEX IF NOT EXISTS idx_photos_gps ON photos(latitude, longitude) WHERE latitude IS NOT NULL AND deleted = 0;
CREATE INDEX IF NOT EXISTS idx_ai_classifications_photo ON ai_classifications(photo_id);
CREATE INDEX IF NOT EXISTS idx_ai_classifications_label ON ai_classifications(label);
CREATE INDEX IF NOT EXISTS idx_photos_pending_thumbnails ON photos(id) WHERE thumbnail_status = 0 AND deleted = 0;
CREATE INDEX IF NOT EXISTS idx_face_detections_photo ON face_detections(photo_id);
CREATE INDEX IF NOT EXISTS idx_face_detections_person ON face_detections(person_id);
CREATE INDEX IF NOT EXISTS idx_face_detections_person_photo ON face_detections(person_id, photo_id);
CREATE INDEX IF NOT EXISTS idx_face_clusters_count ON face_clusters(face_count DESC, id);
CREATE INDEX IF NOT EXISTS idx_custom_attrs_photo ON custom_attributes(photo_id);
CREATE INDEX IF NOT EXISTS idx_constraints_pair ON face_constraints(photo_id_1, face_index_1, photo_id_2, face_index_2);
CREATE INDEX IF NOT EXISTS idx_face_merge_history_operation ON face_merge_history(operation_id);
CREATE INDEX IF NOT EXISTS idx_photo_manual_tags_tag ON photo_manual_tags(tag_id, photo_id);
CREATE INDEX IF NOT EXISTS idx_photo_intelligence_duplicate ON photo_intelligence(duplicate_group);
CREATE INDEX IF NOT EXISTS idx_photo_intelligence_stack ON photo_intelligence(stack_key);
CREATE INDEX IF NOT EXISTS idx_library_jobs_status ON library_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_story_event_photos_event ON story_event_photos(event_id, position);
CREATE INDEX IF NOT EXISTS idx_photos_storage_source ON photos(storage_source_id, deleted);
CREATE INDEX IF NOT EXISTS idx_face_detections_ignored_page ON face_detections(review_status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_photo_trash_page ON photo_trash(trashed_at DESC, photo_id DESC);
CREATE INDEX IF NOT EXISTS idx_ai_photo_tasks_queue ON ai_photo_tasks(stage, status, lease_until, photo_id);
CREATE INDEX IF NOT EXISTS idx_ai_photo_tasks_updated ON ai_photo_tasks(updated_at DESC);
"#;

// Individual table constants for migrations on existing databases
pub const FACE_CONSTRAINTS_TABLE: &str = "
CREATE TABLE IF NOT EXISTS face_constraints (
    id INTEGER PRIMARY KEY,
    photo_id_1 INTEGER NOT NULL,
    face_index_1 INTEGER NOT NULL,
    photo_id_2 INTEGER NOT NULL,
    face_index_2 INTEGER NOT NULL,
    constraint_type TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (photo_id_1) REFERENCES photos(id),
    FOREIGN KEY (photo_id_2) REFERENCES photos(id)
)";

pub const PERSON_METADATA_TABLE: &str = "
CREATE TABLE IF NOT EXISTS person_metadata (
    person_id INTEGER PRIMARY KEY,
    user_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    confidence TEXT DEFAULT 'medium',
    centroid_cached INTEGER DEFAULT 1,
    FOREIGN KEY (person_id) REFERENCES face_clusters(id)
)";

pub const SMART_ALBUMS_TABLE: &str = "
CREATE TABLE IF NOT EXISTS smart_albums (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    album_type TEXT NOT NULL,
    rule_json TEXT NOT NULL,
    cover_photo_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)";

pub const SMART_ALBUM_PHOTOS_TABLE: &str = "
CREATE TABLE IF NOT EXISTS smart_album_photos (
    album_id INTEGER NOT NULL,
    photo_id INTEGER NOT NULL,
    position INTEGER DEFAULT 0,
    PRIMARY KEY (album_id, photo_id),
    FOREIGN KEY (album_id) REFERENCES smart_albums(id),
    FOREIGN KEY (photo_id) REFERENCES photos(id)
)";
