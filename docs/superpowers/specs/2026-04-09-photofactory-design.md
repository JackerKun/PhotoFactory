# PhotoFactory Design Spec

**Date:** 2026-04-09
**Status:** Draft
**Author:** Claude Code

## 1. Overview

PhotoFactory is a local desktop photo management application, similar to Immich, that imports photo folders without copying files. It provides thumbnail browsing, AI classification (scenes, objects), face recognition and grouping, map-based photo viewing, and custom attributes. All project data is stored in a `.pf` folder within the imported directory for fast subsequent loads.

### Key Requirements
- Import folder by reference (no file copying)
- Thumbnail grid browsing with directory tree navigation
- AI classification: scenes (landscape, food, etc.) and objects
- Face recognition: detect, cluster, group, and name people
- Map view with GPS-based photo pins
- Custom user-defined attributes per photo
- `.pf` project folder for all indexes, database, AI cache, and map tiles
- Incremental re-scan for fast reload
- Support 100k+ photos

### Technical Stack
- **Runtime:** Tauri 2 (Rust + Web frontend)
- **Frontend:** React + Vite + Tailwind CSS
- **Backend:** Rust
- **Database:** SQLite (embedded in .pf/photos.db)
- **Image Processing:** libvips (thumbnail generation)
- **AI Inference:** ONNX Runtime (local models)
- **AI Worker:** Separate Python process with ONNX Runtime, communicates via Unix Socket/HTTP
- **Map:** Leaflet with offline tile caching

## 2. Architecture

### 2.1 High-Level

```
┌─────────────────────────────────────────────────────────┐
│                    PhotoFactory Desktop                  │
├──────────────────┬──────────────────┬───────────────────┤
│  React Frontend  │  Rust Core       │  AI Worker        │
│  (Tauri Window)  │  (Main Process)  │  (Python)         │
│                  │                  │                   │
│  - Photo grid    │  - File scanner  │  - Face detect    │
│  - Directory tree│  - DB manager    │  - Scene classify │
│  - Map view      │  - Thumbnail gen │  - Face clustering│
│  - Attributes    │  - .pf manager   │  - Metadata output│
│  - Custom attrs  │  - Worker IPC    │                   │
│                  │  - HTTP server   │  HTTP client      │
└────────┬─────────┴────────┬─────────┴─────────┬─────────┘
         │                  │                   │
         └──────────┬───────┴───────────────────┘
                    │
         ┌──────────▼──────────┐
         │   .pf/ Project      │
         │  photos.db          │
         │  thumbnails/        │
         │  maps/              │
         │  ai_cache/          │
         │  project.json       │
         └─────────────────────┘
```

### 2.2 Component Responsibilities

**React Frontend:**
- Virtual scrolling grid (tanstack/virtual) for 100k+ photos
- Directory tree sidebar
- Leaflet map with offline tile source
- Photo detail panel with EXIF, tags, faces, custom attributes
- Face management UI (group, name, merge)
- Settings panel

**Rust Core:**
- File system scanner (recursive, skip hidden/unsupported)
- EXIF metadata extraction
- SQLite database management (rusqlite)
- Thumbnail generation via libvips (>10MB only, cached)
- AI Worker communication (HTTP server on localhost)
- Project (.pf) lifecycle management
- Incremental scan logic

**AI Worker (Python):**
- Face detection model (e.g., RetinaFace ONNX)
- Face recognition embedding (e.g., ArcFace ONNX)
- Scene classification model (e.g., ResNet-50 Places365 ONNX)
- Face clustering algorithm (DBSCAN or similar)
- Batch processing with progress reporting

### 2.3 Communication Protocol

Rust starts an HTTP server on a random available localhost port, passes the port to the AI Worker via environment variable or CLI argument.

```
Rust → Worker POST /classify
  { "action": "classify", "paths": ["..."], "model": "scene_v2" }

Worker → Rust SSE/Streaming
  { "status": "progress", "done": 50, "total": 100 }

Worker → Rust Response
  { "results": [{ "path": "...", "tags": [{"label": "landscape", "confidence": 0.95}] }] }

Rust → Worker POST /detect_faces
  { "action": "detect_faces", "paths": ["..."] }

Worker → Rust Response
  { "results": [{ "path": "...", "faces": [{"bbox": [x,y,w,h], "embedding": [f32; 512]}] }] }
```

Worker health: Rust pings `/health` every 5s. If unresponsive, restart worker and requeue pending tasks.

## 3. .pf Project Folder

### 3.1 Structure

```
.pf/
├── project.json          # Project metadata
├── photos.db             # SQLite database
├── thumbnails/
│   ├── small/            # 256x256 grid thumbnails (>10MB originals only)
│   └── large/            # 1024x1024 preview thumbnails
├── maps/
│   └── tiles/            # z/x/y.png offline map tiles
├── ai_cache/
│   ├── faces/            # Face embedding .bin files (path hash → embedding)
│   └── tags/             # Scene classification .json (path hash → tags)
└── worker.lock           # Worker state lock file
```

### 3.2 project.json

```json
{
  "name": "My Photos",
  "root_path": "/path/to/photos",
  "created_at": "2026-04-09T09:00:00Z",
  "last_scan": "2026-04-09T10:30:00Z",
  "total_photos": 52000,
  "thumbnail_threshold_mb": 10,
  "ai_models": {
    "face_detection": "retinaface_v1",
    "face_recognition": "arcface_v1",
    "scene_classification": "resnet50_places365"
  }
}
```

### 3.3 Database Schema (photos.db)

```sql
CREATE TABLE photos (
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    filename TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    file_mtime INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    format TEXT,
    -- EXIF
    taken_at INTEGER,
    camera_make TEXT,
    camera_model TEXT,
    latitude REAL,
    longitude REAL,
    orientation INTEGER DEFAULT 1,
    -- Status
    thumbnail_status INTEGER DEFAULT 0,  -- 0=pending, 1=done, 2=skipped(<10MB), -1=error
    ai_status INTEGER DEFAULT 0,          -- 0=pending, 1=done, -1=error
    deleted INTEGER DEFAULT 0,            -- soft delete flag
    imported_at INTEGER NOT NULL
);

CREATE TABLE ai_classifications (
    id INTEGER PRIMARY KEY,
    photo_id INTEGER NOT NULL REFERENCES photos(id),
    category TEXT NOT NULL,  -- 'scene', 'object', etc.
    label TEXT NOT NULL,
    confidence REAL NOT NULL,
    UNIQUE(photo_id, label)
);

CREATE TABLE face_detections (
    id INTEGER PRIMARY KEY,
    photo_id INTEGER NOT NULL REFERENCES photos(id),
    bbox_x INTEGER,
    bbox_y INTEGER,
    bbox_w INTEGER,
    bbox_h INTEGER,
    embedding_path TEXT,  -- relative to .pf/ai_cache/faces/
    person_id INTEGER REFERENCES face_clusters(id),
    created_at INTEGER NOT NULL
);

CREATE TABLE face_clusters (
    id INTEGER PRIMARY KEY,
    name TEXT,
    face_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE custom_attributes (
    id INTEGER PRIMARY KEY,
    photo_id INTEGER NOT NULL REFERENCES photos(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    UNIQUE(photo_id, key)
);

CREATE TABLE sync_log (
    id INTEGER PRIMARY KEY,
    event_type TEXT NOT NULL,  -- 'add', 'modify', 'delete'
    path TEXT NOT NULL,
    timestamp INTEGER NOT NULL
);

-- Indexes
CREATE INDEX idx_photos_path ON photos(path);
CREATE INDEX idx_photos_taken_at ON photos(taken_at);
CREATE INDEX idx_photos_gps ON photos(latitude, longitude) WHERE latitude IS NOT NULL;
CREATE INDEX idx_ai_classifications_photo ON ai_classifications(photo_id);
CREATE INDEX idx_ai_classifications_label ON ai_classifications(label);
CREATE INDEX idx_face_detections_photo ON face_detections(photo_id);
CREATE INDEX idx_face_detections_person ON face_detections(person_id);
CREATE INDEX idx_custom_attrs_photo ON custom_attributes(photo_id);
```

## 4. Data Flow

### 4.1 Initial Import

1. User selects folder → Rust scans file tree (skip hidden dirs, filter by extension)
2. Read EXIF metadata for each photo, batch insert into photos.db
3. Generate thumbnails in parallel via libvips (only for files >10MB)
4. Send AI batch jobs to Worker (100 photos per batch)
5. Worker returns face detections and scene classifications
6. Store results in ai_cache files and photos.db
7. Update project.json last_scan timestamp

### 4.2 Incremental Re-scan

1. Read project.json last_scan timestamp
2. Scan folder, compare file mtime against db records
3. Process only new/modified files (steps 2-6 above)
4. Mark missing files as soft deleted
5. Update last_scan timestamp

### 4.3 Browse Flow

1. Frontend requests paginated photo list (offset/limit, with filters)
2. Rust queries SQLite, returns metadata + thumbnail paths
3. Frontend loads thumbnails via Tauri asset protocol or base64
4. Photos <=10MB: load original via Object URL with CSS scaling
5. Virtual scrolling recycles DOM nodes for performance

### 4.4 Map View

1. Frontend requests photos with GPS data (bounded by map viewport)
2. Rust queries photos WHERE latitude IS NOT NULL AND bbox overlaps viewport
3. Frontend renders pins on Leaflet map
4. Tile requests go to local Rust HTTP server → checks .pf/maps/tiles/ → downloads if missing → caches

## 5. Error Handling

| Scenario | Behavior |
|----------|----------|
| Corrupt/unreadable file | Mark as error status, skip, continue scan |
| AI Worker crash | Detect connection loss, auto-restart, requeue pending tasks |
| Database corruption | Validate on startup, prompt rebuild index if corrupted |
| Disk space full | Check available space before thumbnail generation, pause if low |
| Missing original files | Soft delete in DB, show broken thumbnail placeholder |
| Worker port conflict | Retry on different random port (up to 3 attempts) |

## 6. Performance Strategy

### For 100k+ Photos

**Database:**
- Photos table indexed by path prefix and taken_at
- EXIF fields in same table (no joins needed for common queries)
- Pagination with cursor (WHERE id > ? LIMIT 100) not offset
- Separate thumbnail_status filter index for pending thumbnail queue

**Thumbnails:**
- LRU eviction: when .pf/thumbnails/ exceeds 1GB, delete oldest
- Only generate for originals >10MB (configurable in project.json)
- <=10MB photos: frontend scales original directly

**AI Processing:**
- Batch size: 100 photos per Worker request
- Worker uses GPU if available, fallback to CPU threads
- Face embeddings stored as binary files (not in DB) to keep DB small
- Face clustering runs periodically (not per-photo), triggered by user or after batch completion

**Frontend:**
- tanstack/virtual for virtual scrolling
- Image lazy loading with IntersectionObserver
- Staggered thumbnail requests (max 10 concurrent)
- React.memo on thumbnail card components
- Debounced search and filter

## 7. Frontend Views

### 7.1 Layout

```
┌──────────────────────────────────────────────────────┐
│  PhotoFactory                          [🔍] [⚙]       │
├──────────┬───────────────────────────────────────────┤
│ Sidebar  │  Main Content Area                        │
│ (250px)  │                                           │
│          │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐         │
│ 📁 Dirs  │  │ 🖼️  │ │ 🖼️  │ │ 🖼️  │ │ 🖼️  │         │
│ 📂 Tree  │  └─────┘ └─────┘ └─────┘ └─────┘         │
│          │                                           │
│ 👥 Faces │  [Timeline/Grid toggle]  [Filter: AI Tag▼]│
│ 🏷️ Tags  │                                           │
│ 🗺️ Map   │                                           │
│ ⚙ Settings                                            │
└──────────┴───────────────────────────────────────────┘
```

### 7.2 Views

- **Grid View:** Thumbnail grid with virtual scrolling, click to open detail panel
- **Timeline View:** Photos grouped by date (year → month → day)
- **Map View:** Offline Leaflet map, photo pins at GPS coordinates
- **Person View:** Face clusters displayed as groups, mergeable, namable
- **Tag View:** Filter by AI classification labels

### 7.3 Detail Panel

When a photo is selected:
- Full size preview (original or large thumbnail)
- EXIF data (date, camera, lens, settings, GPS)
- AI tags with confidence bars
- Detected faces (clickable to add to cluster)
- Custom attributes (key-value editor)
- File path and size info

## 8. Custom Attributes

Users can add arbitrary key-value pairs to any photo:
- Stored in custom_attributes table
- UI: detail panel has "Add Attribute" button
- Supports string, number, boolean, date value types
- Filterable in grid view (e.g., show all photos where "rating" > 4)
