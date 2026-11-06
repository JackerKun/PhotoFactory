# Performance Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade PhotoFactory loading performance to near-system-album level with virtualized proportional mode, layered thumbnails, async generation, preload queue, and map clustering.

**Architecture:** Replace CSS columns with dynamic virtual scroller for proportional mode. Split thumbnail generation into non-blocking async pipeline with small/medium size layers. Add scroll-direction-aware preload queue. Integrate leaflet.markercluster for GPS markers.

**Tech Stack:** React 18, @tanstack/react-virtual 3.10 (dynamicSize), Tauri 2, Rust (rusqlite, image), Zustand 4.5, leaflet.markercluster

---

## File Structure

### New files:
- `src/components/ProportionalVirtualGrid.tsx` — Virtualized proportional (masonry-style) grid component
- `src/components/PersonDrawer.tsx` — Person detail drawer (for Plan 2)
- `src/components/SmartAlbumView.tsx` — Smart albums view (for Plan 3)
- `src/components/AiStatusIndicator.tsx` — Already exists, keep
- `src-tauri/src/thumbnail/lru_cache.rs` — LRU cache for in-memory thumbnail tracking
- `src-tauri/src/commands/thumbnail_async.rs` — Async thumbnail generation commands
- `ai_worker/geo_tagger.py` — GPS reverse-geocoding and time tag generation
- `src-tauri/src/commands/geo_tags.rs` — Geo/time tag Rust commands
- `src-tauri/src/db/smart_album_dao.rs` — Smart album DAO
- `src-tauri/src/commands/smart_albums.rs` — Smart album commands
- `src-tauri/src/face_clusterer_v2.rs` — Enhanced face clustering with adaptive eps, constraints

### Modified files:
- `src/components/PhotoGrid.tsx` — Add proportional virtual grid, remove CSS columns
- `src/components/PhotoCard.tsx` — Multi-size thumbnail state machine, hover upgrade
- `src/hooks/usePhotos.ts` — Preload queue, debounced loadMore, filter change cleanup
- `src/hooks/useVirtualGrid.ts` — Dynamic size support for proportional mode
- `src/components/FaceView.tsx` — Tab layout (named/unnamed/review), person cards, drawer trigger
- `src/components/TagView.tsx` — Hierarchical label display with parent/child groups
- `src/components/Sidebar.tsx` — Add "相册" nav item
- `src/components/MapView.tsx` — Marker clustering
- `src/App.tsx` — SmartAlbumView route, person drawer state
- `src/types/index.ts` — New types for layered thumbnails, face constraints, smart albums, label hierarchy
- `src/api/tauri.ts` — New async thumbnail commands, face constraint commands, geo tag commands, smart album commands
- `src-tauri/src/db/schema.rs` — New tables: face_constraints, person_metadata, smart_albums, smart_album_photos; modified columns
- `src-tauri/src/db/connection.rs` — Migration for new columns/tables
- `src-tauri/src/db/photo_dao.rs` — Pagination LIMIT 100→200, preload queries
- `src-tauri/src/db/classification_dao.rs` — Hierarchical label queries, multi-label insert
- `src-tauri/src/db/face_dao.rs` — Constraint loading, quality score, person metadata
- `src-tauri/src/commands/photos.rs` — Async thumbnail endpoint, size parameter
- `src-tauri/src/commands/faces.rs` — Constraint-aware clustering, rename with person_name
- `src-tauri/src/commands/ai.rs` — Multi-label classification (top-3), trigger geo/time tagging
- `src-tauri/src/commands/tags.rs` — Hierarchical label API
- `src-tauri/src/thumbnail/generator.rs` — Medium size thumbnail generation
- `src-tauri/src/thumbnail/processor.rs` — Priority queue for thumbnail generation
- `src-tauri/src/lib.rs` — Register new commands
- `src-tauri/src/main.rs` — Register new commands
- `src-tauri/Cargo.toml` — Add lru crate dependency
- `ai_worker/server.py` — New endpoints: cluster_faces_v2, compute_face_quality
- `ai_worker/face_clusterer.py` — Adaptive eps, must-link/cannot-link support
- `package.json` — Add leaflet.markercluster dependency
- `index.html` — Add leaflet.markercluster CSS link

---

### Task 1: Foundation — Types, Schema, and Migrations

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src-tauri/src/db/schema.rs`
- Modify: `src-tauri/src/db/connection.rs`

- [ ] **Step 1: Add new TypeScript types**

Add to `src/types/index.ts` after existing interfaces:

```typescript
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
  album_type: "travel" | "monthly" | "themed" | "person";
  rule_json: string;
  cover_photo_id: number | null;
  photo_count: number;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 2: Add new Rust tables to schema**

In `src-tauri/src/db/schema.rs`, add after the existing table definitions (before the indexes section around line 70):

```rust
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
```

- [ ] **Step 3: Add new indexes to schema**

Add to the `CREATE_INDEXES` constant in `schema.rs`:

```rust
"CREATE INDEX IF NOT EXISTS idx_constraints_pair ON face_constraints(photo_id_1, face_index_1, photo_id_2, face_index_2);",
"CREATE INDEX IF NOT EXISTS idx_classifications_label_type ON ai_classifications(tag_type, label);",
"CREATE INDEX IF NOT EXISTS idx_classifications_photo_type ON ai_classifications(photo_id, tag_type);",
```

- [ ] **Step 4: Add column migrations to connection.rs**

In `src-tauri/src/db/connection.rs`, add new migrations after the existing ones (after line 29, inside the `init_db` function before the `Ok(conn)` return):

```rust
// Add quality_score and person_name to face_detections
conn.execute_batch(
    "ALTER TABLE face_detections ADD COLUMN quality_score REAL DEFAULT 0.0;
     ALTER TABLE face_detections ADD COLUMN person_name TEXT;",
).ok(); // ignore errors if columns already exist

// Add parent_id and label_type to classification_labels (we use ai_classifications table)
conn.execute_batch(
    "ALTER TABLE ai_classifications ADD COLUMN parent_id INTEGER REFERENCES ai_classifications(id);
     ALTER TABLE ai_classifications ADD COLUMN label_type TEXT DEFAULT 'ai_scene';
     ALTER TABLE ai_classifications ADD COLUMN tag_type TEXT DEFAULT 'ai_scene';",
).ok();

// Create new tables
conn.execute_batch(FACE_CONSTRAINTS_TABLE)?;
conn.execute_batch(PERSON_METADATA_TABLE)?;
conn.execute_batch(SMART_ALBUMS_TABLE)?;
conn.execute_batch(SMART_ALBUM_PHOTOS_TABLE)?;

// Create new indexes
conn.execute_batch("
    CREATE INDEX IF NOT EXISTS idx_constraints_pair ON face_constraints(photo_id_1, face_index_1, photo_id_2, face_index_2);
    CREATE INDEX IF NOT EXISTS idx_classifications_label_type ON ai_classifications(tag_type, label);
    CREATE INDEX IF NOT EXISTS idx_classifications_photo_type ON ai_classifications(photo_id, tag_type);
")?;
```

Also add the new constants to the imports at the top of `connection.rs`:

```rust
use crate::db::schema::{CREATE_TABLES, CREATE_INDEXES, FACE_CONSTRAINTS_TABLE, PERSON_METADATA_TABLE, SMART_ALBUMS_TABLE, SMART_ALBUM_PHOTOS_TABLE};
```

- [ ] **Step 5: Verify migration compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles successfully with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src-tauri/src/db/schema.rs src-tauri/src/db/connection.rs
git commit -m "feat(perf): add database schema migrations for v0.2 features

New tables: face_constraints, person_metadata, smart_albums, smart_album_photos
New columns: quality_score, person_name, parent_id, label_type, tag_type
New indexes for constraint lookups and label type filtering"
```

---

### Task 2: Medium Thumbnail Size + Async Generation Backend

**Files:**
- Modify: `src-tauri/src/thumbnail/generator.rs`
- Modify: `src-tauri/src/thumbnail/processor.rs`
- Modify: `src-tauri/src/commands/photos.rs`
- Modify: `src-tauri/src/models/photo.rs` (if needed for size enum)

- [ ] **Step 1: Add medium thumbnail constant and function**

In `src-tauri/src/thumbnail/generator.rs`, add after line 8:

```rust
const THUMBNAIL_SIZE_MEDIUM: u32 = 512;
```

Add after `generate_large_thumbnail` (around line 104):

```rust
pub fn generate_medium_thumbnail(source_path: &Path, output_dir: &Path) -> AppResult<PathBuf> {
    generate_thumbnail(source_path, output_dir, THUMBNAIL_SIZE_MEDIUM)
}
```

- [ ] **Step 2: Add medium thumbnail directory constant**

In `src-tauri/src/commands/photos.rs`, find where thumbnail directories are defined (around line 57-70 in `cmd_get_thumbnail_path`). Add medium directory:

```rust
let medium_dir = project
    .pf_dir
    .join("thumbnails")
    .join("medium");
std::fs::create_dir_all(&medium_dir)?;
```

- [ ] **Step 3: Update cmd_get_thumbnail_path to support "medium" size**

In `src-tauri/src/commands/photos.rs`, modify `cmd_get_thumbnail_path` (line 57-85). Update the size matching:

```rust
#[tauri::command]
pub async fn cmd_get_thumbnail_path(
    photo_id: i64,
    size: String,
    state: State<'_, Arc<Mutex<Option<Project>>>>,
) -> AppResult<String> {
    let project = state
        .lock()
        .await
        .as_ref()
        .ok_or(AppError::NoProjectOpen)?;

    let (thumb_dir, thumbnail_size) = match size.as_str() {
        "large" => (&project.large_thumbnails_path, 1024u32),
        "medium" => {
            let medium_dir = project.pf_dir.join("thumbnails").join("medium");
            std::fs::create_dir_all(&medium_dir)?;
            (medium_dir, 512u32)
        }
        _ => (&project.small_thumbnails_path, 256u32),
    };

    // Check if thumbnail already exists
    let hash = path_hash_for_photo_id(photo_id); // use existing hash logic
    let thumb_path = thumb_dir.join(format!("{}.webp", hash));

    if thumb_path.exists() {
        return Ok(thumb_path.to_string_lossy().to_string());
    }

    // Return placeholder - will be generated asynchronously
    // Queue the generation in background
    queue_thumbnail_generation(photo_id, &size, &project);

    Ok(String::new()) // Return empty string = placeholder
}
```

Note: You'll need to extract the hash computation into a helper function that works with photo_id. Look at the existing `cmd_get_thumbnail_path` to see how it currently computes the hash from `photo.path`.

- [ ] **Step 4: Add LRU cache for in-memory thumbnail tracking**

Create `src-tauri/src/thumbnail/lru_cache.rs`:

```rust
use lru::LruCache;
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::sync::Mutex;

pub struct ThumbnailLruCache {
    cache: Mutex<LruCache<String, String>>,
}

impl ThumbnailLruCache {
    pub fn new(max_size: usize) -> Self {
        Self {
            cache: Mutex::new(LruCache::new(NonZeroUsize::new(max_size).unwrap())),
        }
    }

    pub fn get(&self, key: &str) -> Option<String> {
        self.cache.lock().unwrap().get(key).cloned()
    }

    pub fn put(&self, key: String, value: String) {
        self.cache.lock().unwrap().put(key, value);
    }

    pub fn evict(&self) -> Option<(String, String)> {
        self.cache.lock().unwrap().pop_lru()
    }
}

// Global cache instance
pub static THUMBNAIL_LRU: once_cell::sync::Lazy<ThumbnailLruCache> =
    once_cell::sync::Lazy::new(|| ThumbnailLruCache::new(500));
```

Add to `src-tauri/Cargo.toml`:
```toml
lru = "0.12"
once_cell = "1.19"
```

Add to `src-tauri/src/thumbnail/mod.rs`:
```rust
pub mod lru_cache;
```

- [ ] **Step 5: Update ThumbnailProcessor with priority queue**

In `src-tauri/src/thumbnail/processor.rs`, modify `process_batch` (line 104). Add priority awareness:

```rust
fn process_batch(&self, project: &Project) -> AppResult<usize> {
    let conn = Self::get_connection(project)?;

    // Get pending thumbnails (prioritize recently requested via LRU tracking)
    let photos = photo_dao::get_pending_thumbnails(&conn, self.batch_size)?;

    if photos.is_empty() {
        return Ok(0);
    }

    let count = photos.len();
    let small_dir = &project.small_thumbnails_path;

    for (i, photo) in photos.iter().enumerate() {
        self.update_progress(i, count, &photo.path);

        match generate_small_thumbnail(Path::new(&photo.path), small_dir) {
            Ok(_) => {
                photo_dao::update_thumbnail_status(&conn, photo.id, 1)?;
                self.increment_succeeded();
            }
            Err(e) => {
                eprintln!("Failed to generate thumbnail for {}: {}", photo.path, e);
                photo_dao::update_thumbnail_status(&conn, photo.id, -1)?;
                self.increment_failed();
                self.set_last_error(&e.to_string());
            }
        }
    }

    // Trigger LRU eviction if cache directory is too large
    eviction::maybe_evict(small_dir)?;

    Ok(count)
}
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/thumbnail/generator.rs src-tauri/src/thumbnail/processor.rs src-tauri/src/thumbnail/lru_cache.rs src-tauri/src/thumbnail/mod.rs src-tauri/src/commands/photos.rs src-tauri/Cargo.toml
git commit -m "feat(perf): add medium thumbnail size and async generation backend

- Add 512px medium thumbnail size between small(256) and large(1024)
- Split cmd_get_thumbnail_path into cache-check + async queue
- Add LRU cache for in-memory thumbnail tracking (max 500 entries)
- Add LRU disk eviction via existing eviction.rs module"
```

---

### Task 3: Proportional Virtual Grid (Frontend)

**Files:**
- Create: `src/components/ProportionalVirtualGrid.tsx`
- Modify: `src/components/PhotoGrid.tsx`
- Modify: `src/hooks/useVirtualGrid.ts`

- [ ] **Step 1: Create ProportionalVirtualGrid component**

Create `src/components/ProportionalVirtualGrid.tsx`:

```tsx
import { useRef, useCallback, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "../hooks/usePhotos";
import PhotoCard from "./PhotoCard";

const COLUMN_GAP = 8;
const ROW_GAP = 8;
const OVERSCAN = 5;

interface Props {
  onSelectPhoto: (id: number) => void;
  onDoubleClickPhoto?: (id: number) => void;
  selectedPhotoId?: number;
}

export default function ProportionalVirtualGrid({
  onSelectPhoto,
  onDoubleClickPhoto,
  selectedPhotoId,
}: Props) {
  const { photos, loadMore, hasNext, loading } = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Measure column count based on container width
  const columnCount = 3; // Start with 3 columns; make dynamic based on width

  // Estimate heights based on known aspect ratios
  // Default estimate: 4:3 aspect ratio photos
  const estimateSize = useCallback(
    () => Math.max(120, (containerRef.current?.clientWidth || 800) / columnCount / 1.3),
    [columnCount]
  );

  const virtualizer = useVirtualizer({
    count: photos.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: OVERSCAN,
    scrollPaddingStart: 20,
    scrollPaddingEnd: 20,
  });

  // Infinite scroll: load more when near bottom
  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const target = e.currentTarget;
      const remaining = target.scrollHeight - target.scrollTop - target.clientHeight;
      if (remaining < 500 && hasNext && !loading) {
        loadMore();
      }
    },
    [hasNext, loading, loadMore]
  );

  // Measure actual rendered item heights and feed back to virtualizer
  useEffect(() => {
    const items = virtualizer.getVirtualItems();
    items.forEach((item) => {
      const el = scrollRef.current?.querySelector(`[data-index="${item.index}"]`);
      if (el) {
        const measuredHeight = el.getBoundingClientRect().height;
        if (measuredHeight > 0) {
          virtualizer.measureItem(item.index, measuredHeight);
        }
      }
    });
  });

  return (
    <div ref={containerRef} className="w-full h-full">
      <div
        ref={scrollRef}
        className="w-full h-full overflow-auto"
        onScroll={handleScroll}
        style={{
          height: containerRef.current?.clientHeight || "100vh",
        }}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const photo = photos[virtualRow.index];
            if (!photo) return null;

            return (
              <div
                key={photo.id}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: virtualRow.start,
                  width: `calc(${100 / columnCount}% - ${COLUMN_GAP}px)`,
                  padding: `${ROW_GAP / 2}px ${COLUMN_GAP / 2}px`,
                }}
              >
                <PhotoCard
                  photo={photo}
                  onClick={() => onSelectPhoto(photo.id!)}
                  onDoubleClick={onDoubleClickPhoto ? () => onDoubleClickPhoto(photo.id!) : undefined}
                  size={200}
                  height={200}
                  shape="proportional"
                  isSelected={selectedPhotoId === photo.id}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update PhotoGrid to use ProportionalVirtualGrid**

In `src/components/PhotoGrid.tsx`, replace the proportional mode section (lines 39-83, the CSS columns masonry) with:

```tsx
// Replace lines 39-83 (the proportional mode CSS columns) with:
if (thumbnailShape === "proportional") {
  return (
    <div className="relative w-full h-full">
      <ProportionalVirtualGrid
        onSelectPhoto={onSelectPhoto}
        onDoubleClickPhoto={onDoubleClickPhoto}
        selectedPhotoId={selectedPhotoId}
      />
      {photos.length === 0 && !loading && (
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          No photos yet
        </div>
      )}
    </div>
  );
}
```

Add the import at the top:
```tsx
import ProportionalVirtualGrid from "./ProportionalVirtualGrid";
```

- [ ] **Step 3: Update useVirtualGrid for dynamic sizing**

In `src/hooks/useVirtualGrid.ts`, add support for dynamic size measurement. The existing hook already uses `useVirtualizer` from `@tanstack/react-virtual`, so it should work with the proportional grid's measured sizes. No changes needed if the proportional grid manages its own virtualizer (which it does in Step 1).

However, add a `cleanup` helper that the proportional grid can call on filter change:

```typescript
// Add to useVirtualGrid exports
export function useDynamicVirtualGrid({
  itemCount,
  columnCount,
  gap,
  overscan = 5,
}: {
  itemCount: number;
  columnCount: number;
  gap: number;
  overscan?: number;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    if (!parentRef.current) return;
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width);
    });
    observer.observe(parentRef.current);
    return () => observer.disconnect();
  }, []);

  const itemWidth = containerWidth > 0
    ? (containerWidth - (columnCount - 1) * gap) / columnCount
    : 200;

  // Use dynamic size - estimate initially, measure on render
  const virtualizer = useVirtualizer({
    count: itemCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => itemWidth, // square estimate for dynamic
    overscan,
  });

  return { parentRef, virtualizer, itemWidth, columnCount };
}
```

- [ ] **Step 4: Commit**

```bash
git add src/components/ProportionalVirtualGrid.tsx src/components/PhotoGrid.tsx src/hooks/useVirtualGrid.ts
git commit -m "feat(perf): virtualize proportional grid mode

- Replace CSS columns masonry with @tanstack/react-virtual dynamicSize
- DOM elements reduced from 1000 to ~50-80
- Add useDynamicVirtualGrid hook for flexible virtualization
- Infinite scroll preserved with 500px threshold"
```

---

### Task 4: PhotoCard Multi-Size Thumbnail State Machine

**Files:**
- Modify: `src/components/PhotoCard.tsx`
- Modify: `src/api/tauri.ts`

- [ ] **Step 1: Update getThumbnailPath API to pass size parameter**

In `src/api/tauri.ts`, the `getThumbnailPath` function already accepts a `size` parameter (line 44). Verify it passes the string correctly:

```typescript
export async function getThumbnailPath(photoId: number, size: "small" | "medium" | "large"): Promise<string> {
  return await invoke<string>("cmd_get_thumbnail_path", { photoId, size });
}
```

This already exists and works. No changes needed.

- [ ] **Step 2: Update PhotoCard with multi-size state machine**

In `src/components/PhotoCard.tsx`, modify the thumbnail loading logic (lines 22-48):

```tsx
export default React.memo(function PhotoCard({
  photo,
  onClick,
  onDoubleClick,
  size,
  height,
  shape = "square",
  isSelected = false,
}: Props) {
  const [smallUrl, setSmallUrl] = useState<string | null>(null);
  const [mediumUrl, setMediumUrl] = useState<string | null>(null);
  const [thumbState, setThumbState] = useState<"placeholder" | "loading" | "loaded" | "upgrading">("placeholder");
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load small thumbnail when visible
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !smallUrl && thumbState === "placeholder") {
            setThumbState("loading");
            api.getThumbnailPath(photo.id!, "small").then((path) => {
              if (path) {
                setSmallUrl(`file://${path}`);
                setThumbState("loaded");
              } else {
                // No cached thumbnail - queue generation, use fallback
                api.getPhotoDataUrl(photo.path!).then((dataUrl) => {
                  setSmallUrl(dataUrl);
                  setThumbState("loaded");
                }).catch(() => setThumbState("placeholder"));
              }
            });
          }
        }
      },
      { rootMargin: "200px" }
    );

    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [photo.id, photo.path, smallUrl, thumbState]);

  // Load medium thumbnail on hover (after 500ms)
  const handleMouseEnter = useCallback(() => {
    if (!mediumUrl && thumbState === "loaded") {
      hoverTimeoutRef.current = setTimeout(() => {
        setThumbState("upgrading");
        api.getThumbnailPath(photo.id!, "medium").then((path) => {
          if (path) {
            setMediumUrl(`file://${path}`);
          }
          setThumbState("loaded");
        });
      }, 500);
    }
  }, [photo.id, mediumUrl, thumbState]);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  }, []);

  const displayUrl = mediumUrl || smallUrl;

  // ... rest of the existing handlers (handleContextMenu, handleToggleFavorite, handleReveal)

  return (
    <div
      ref={ref}
      className={cn("relative cursor-pointer select-none overflow-hidden rounded-md bg-muted", isSelected && "ring-2 ring-primary")}
      style={{ height: shape === "square" ? size : undefined }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {displayUrl ? (
        <img
          src={displayUrl}
          alt={photo.filename}
          className="h-full w-full object-cover transition-opacity duration-300"
          style={thumbState === "upgrading" ? { opacity: 0.7 } : {}}
          loading="lazy"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )}
      {/* ... existing favorite star, filename bar, context menu ... */}
    </div>
  );
});
```

- [ ] **Step 3: Commit**

```bash
git add src/components/PhotoCard.tsx
git commit -m "feat(perf): multi-size thumbnail state machine in PhotoCard

- Small thumbnail loads on IntersectionObserver (200px margin)
- Medium thumbnail loads on hover after 500ms delay
- State machine: placeholder → loading → loaded → upgrading → loaded
- Fallback to data URL for files under 30MB threshold"
```

---

### Task 5: Preload Queue + Debounced Pagination

**Files:**
- Modify: `src/hooks/usePhotos.ts`
- Modify: `src/components/PhotoGrid.tsx`

- [ ] **Step 1: Update pagination limit to 200 and add debounce**

In `src/hooks/usePhotos.ts`, change lines 58 and 67:

```typescript
// Change from:
const page = await api.getPhotos(cursor, 100, filter);
// To:
const page = await api.getPhotos(cursor, 200, filter);
```

Add debounce to `loadMore`:

```typescript
import { useRef, useCallback } from "react";

// Add to the store interface:
interface AppState {
  // ... existing fields
  loadMore: () => void;
  // Add:
  _loadMoreTimerRef: ReturnType<typeof setTimeout> | null;
}

// Modify loadMore in the store (lines 62-70):
loadMore: () => {
  const state = get();
  if (!state.hasNext || state.loading || state._loadMoreTimerRef) return;

  // Debounce: wait 50ms to avoid rapid-fire calls
  state._loadMoreTimerRef = setTimeout(async () => {
    state._loadMoreTimerRef = null;
    const { cursor, filter, photos } = get();
    try {
      set({ loading: true });
      const page = await api.getPhotos(cursor, 200, filter);
      set({
        photos: [...photos, ...page.photos],
        cursor: page.next_cursor?.id ?? null,
        hasNext: page.has_more,
        loading: false,
      });
    } catch (error) {
      console.error("Failed to load more photos:", error);
      set({ loading: false });
    }
  }, 50);
},
```

- [ ] **Step 2: Add preload queue logic**

Add to the Zustand store interface:

```typescript
interface AppState {
  // ... existing
  preloadQueue: number[];
  queuePreload: (photoIds: number[]) => void;
  clearPreloadQueue: () => void;
}
```

Add implementations:

```typescript
preloadQueue: [],
queuePreload: (photoIds: number[]) => {
  const { preloadQueue } = get();
  const newIds = photoIds.filter((id) => !preloadQueue.includes(id));
  if (newIds.length > 0) {
    set({ preloadQueue: [...preloadQueue, ...newIds] });
    // Trigger async preload
    newIds.forEach((id) => {
      api.getThumbnailPath(id, "small").then(() => {
        // Remove from queue when done
        const { preloadQueue: currentQueue } = get();
        set({ preloadQueue: currentQueue.filter((q) => q !== id) });
      });
    });
  }
},
clearPreloadQueue: () => set({ preloadQueue: [] }),
```

- [ ] **Step 3: Wire preload to scroll direction**

In `src/components/PhotoGrid.tsx`, update `handleScroll` (lines 28-31) to detect scroll direction and trigger preloading:

```tsx
const lastScrollTop = useRef(0);

const handleScroll = useCallback(
  (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const scrollTop = target.scrollTop;
    const scrollingDown = scrollTop > lastScrollTop.current;
    lastScrollTop.current = scrollTop;

    // Preload next 2 pages when scrolling down near bottom
    const remaining = target.scrollHeight - scrollTop - target.clientHeight;
    if (remaining < 800 && hasNext && scrollingDown) {
      // Queue preload of upcoming photos
      const currentIndex = photos.findIndex((p) => p.id === cursor);
      if (currentIndex >= 0) {
        const upcomingPhotos = photos
          .slice(currentIndex, currentIndex + 400)
          .map((p) => p.id!)
          .filter(Boolean);
        queuePreload(upcomingPhotos);
      }
      loadMore();
    }
  },
  [hasNext, loadMore, cursor, photos, queuePreload]
);
```

- [ ] **Step 4: Clear preload queue on filter change**

In `setFilter` (line 43-45 in usePhotos.ts), add:

```typescript
setFilter: (filter) => {
  set((state) => ({
    filter: { ...state.filter, ...filter },
    photos: [],
    cursor: null,
    hasNext: true,
    preloadQueue: [],
  }));
},
```

- [ ] **Step 5: Commit**

```bash
git add src/hooks/usePhotos.ts src/components/PhotoGrid.tsx
git commit -m "feat(perf): preload queue + debounced pagination

- Pagination limit increased from 100 to 200
- 50ms debounce on loadMore to prevent rapid-fire calls
- Scroll-direction-aware preload queue for next 2 pages
- Clear preload queue on filter change"
```

---

### Task 6: Map Marker Clustering

**Files:**
- Modify: `src/components/MapView.tsx`
- Modify: `package.json`
- Modify: `index.html` (or add CSS import in MapView)

- [ ] **Step 1: Install leaflet.markercluster**

```bash
npm install leaflet.markercluster
npm install -D @types/leaflet.markercluster
```

- [ ] **Step 2: Import markercluster CSS**

Add to `src/components/MapView.tsx` at the top:
```tsx
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
```

- [ ] **Step 3: Add marker clustering to MapView**

In `src/components/MapView.tsx`, modify the map rendering section. Replace the marker rendering with clustering:

```tsx
import { MarkerClusterGroup } from "react-leaflet-markercluster";

// In the MapView component, wrap markers in a cluster group:
<MapContainer ...>
  <TileLayer ... />
  <MarkerClusterGroup>
    {photos.map((photo) => (
      photo.latitude && photo.longitude && (
        <PhotoMarker key={photo.id} photo={photo} />
      )
    ))}
  </MarkerClusterGroup>
  <MapBounds onBoundsChange={handleBoundsChange} />
</MapContainer>
```

You'll need to install `react-leaflet-markercluster`:
```bash
npm install react-leaflet-markercluster
```

- [ ] **Step 4: Commit**

```bash
git add src/components/MapView.tsx package.json package-lock.json
git commit -m "feat(perf): add marker clustering to GPS map view

- Replace individual markers with leaflet.markercluster
- Automatic aggregation of nearby markers for cleaner map display
- Reduces DOM nodes from 1000s to ~50 clusters at zoom-out"
```

---

### Task 7: LRU Cache Eviction Integration + Skeleton Loading

**Files:**
- Modify: `src-tauri/src/thumbnail/processor.rs`
- Modify: `src/components/PhotoGrid.tsx`

- [ ] **Step 1: Integrate LRU eviction into processor**

In `src-tauri/src/thumbnail/processor.rs`, add eviction calls after each batch. The `eviction.rs` module already has `maybe_evict`. Add after the batch loop in `process_batch`:

```rust
// After generating thumbnails, check if medium dir needs eviction
let medium_dir = project.pf_dir.join("thumbnails").join("medium");
if medium_dir.exists() {
    eviction::maybe_evict(&medium_dir)?;
}
eviction::maybe_evict(small_dir)?;
```

- [ ] **Step 2: Add skeleton loading animation**

In `src/components/PhotoGrid.tsx`, add skeleton placeholders while thumbnails are loading. Modify the empty/loading state:

```tsx
{photos.length === 0 && loading && (
  <div className="grid grid-cols-3 gap-2 p-4">
    {Array.from({ length: 12 }).map((_, i) => (
      <div
        key={i}
        className="aspect-square animate-pulse rounded-md bg-muted"
      />
    ))}
  </div>
)}
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/thumbnail/processor.rs src/components/PhotoGrid.tsx
git commit -m "feat(perf): integrate LRU eviction + add skeleton loading

- Auto-evict least-recently-used thumbnails when cache exceeds 1GB
- Skeleton placeholders during initial photo load
- Smooth transition from skeleton to actual thumbnails"
```

---

### Task 8: Register New Commands + Wire Everything Together

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src/App.tsx`

- [ ] **Step 1: Register any new commands in lib.rs and main.rs**

If you created new command modules (e.g., `thumbnail_async.rs`), register them:

In `src-tauri/src/lib.rs`:
```rust
.invoke_handler(tauri::generate_handler![
    // existing commands...
    // Add new ones here
])
```

- [ ] **Step 2: Verify TypeScript types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Verify Rust compiles**

Run: `cd src-tauri && cargo check`
Expected: No errors.

- [ ] **Step 4: Test the app manually**

```bash
npm run tauri dev
```

Test checklist:
- [ ] Square mode: grid loads, scroll is smooth, virtualized
- [ ] Proportional mode: grid loads, scroll is smooth, no lag with 500+ photos
- [ ] Thumbnail hover: medium thumbnail upgrades after 500ms hover
- [ ] Infinite scroll: loads more photos automatically
- [ ] Map view: markers are clustered at zoom-out
- [ ] Filter change: clears photos and preload queue

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/main.rs src/App.tsx
git commit -m "feat(perf): register commands + wire up performance features

- Register all new Tauri commands
- Connect ProportionalVirtualGrid in PhotoGrid
- Verify end-to-end: square mode, proportional mode, map clustering"
```
