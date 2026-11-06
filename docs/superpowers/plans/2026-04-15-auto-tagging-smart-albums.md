# Auto-Tagging & Smart Albums Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add hierarchical label categories, spatial-temporal auto-tags (location/time/event/device), and smart album generation to PhotoFactory.

**Architecture:** Extend existing classification system with label hierarchy (parent_id) and tag_type field. Add GPS reverse-geocoding via Nominatim (batch queued, rate-limited 1 req/s). Generate time/event/device tags from EXIF data. Build smart album generator with rule-based aggregation (travel, monthly, themed, person). Update TagView to render hierarchical tree. Add SmartAlbumView to sidebar.

**Tech Stack:** Rust (rusqlite, reqwest for Nominatim), Python (optional event clustering), React 18, Zustand 4.5, Tauri 2

---

## File Structure

### New files:
- `src-tauri/src/geo_tagger.rs` — GPS reverse-geocoding with Nominatim, rate limiting, local cache
- `src-tauri/src/time_tagger.rs` — Time label generation (year/season/holiday) and event clustering
- `src-tauri/src/device_tagger.rs` — Device label generation from EXIF camera model
- `src-tauri/src/db/smart_album_dao.rs` — Smart album CRUD and photo association
- `src-tauri/src/commands/geo_tags.rs` — Geo tag Tauri commands
- `src-tauri/src/commands/time_tags.rs` — Time/event tag commands
- `src-tauri/src/commands/smart_albums.rs` — Smart album commands
- `src/components/SmartAlbumView.tsx` — Smart album list and detail view
- `src/components/LabelGroup.tsx` — Hierarchical label group component (collapsible)

### Modified files:
- `src/components/TagView.tsx` — Hierarchical label tree rendering
- `src/components/Sidebar.tsx` — Add "相册" nav entry
- `src/App.tsx` — SmartAlbumView route
- `src/types/index.ts` — LabelNode, SmartAlbum types (from Plan 1)
- `src/api/tauri.ts` — Geo tag, time tag, smart album API functions
- `src-tauri/src/db/schema.rs` — label_type, tag_type, parent_id columns (from Plan 1)
- `src-tauri/src/db/connection.rs` — Migrations (from Plan 1)
- `src-tauri/src/db/classification_dao.rs` — Hierarchical queries, multi-label support
- `src-tauri/src/commands/ai.rs` — Trigger geo/time/device tagging in auto-AI pipeline, top-3 classification
- `src-tauri/src/lib.rs` — Register new commands
- `src-tauri/src/main.rs` — Register new commands
- `src-tauri/Cargo.toml` — May need `serde_json` (already present)

---

### Task 1: Label Hierarchy Data Layer

**Files:**
- Modify: `src-tauri/src/db/classification_dao.rs`
- Modify: `src-tauri/src/commands/tags.rs`
- Modify: `src/api/tauri.ts`

> Schema migrations are covered in Plan 1. This task assumes columns exist.

- [ ] **Step 1: Add hierarchical label queries to classification_dao.rs**

In `src-tauri/src/db/classification_dao.rs`, add after existing functions:

```rust
use serde_json;

#[derive(Debug, Clone, serde::Serialize)]
pub struct LabelNode {
    pub id: i64,
    pub label: String,
    pub parent_id: Option<i64>,
    pub label_type: String,
    pub count: i64,
    pub preview_thumbnail: Option<String>,  // photo path for representative thumbnail
    pub children: Vec<LabelNode>,
}

pub fn get_label_hierarchy(conn: &Connection) -> AppResult<Vec<LabelNode>> {
    // Get all labels with their counts
    let mut stmt = conn.prepare(
        "SELECT label, COUNT(*) as cnt, label_type
         FROM ai_classifications
         GROUP BY label, label_type
         ORDER BY cnt DESC"
    )?;

    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?))
    })?;

    let mut labels: Vec<(String, i64, String)> = rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| crate::error::AppError::from(e))?;

    // Build hierarchy from known parent-child relationships
    // These are defined as constants (see Step 2)
    let hierarchy = build_label_hierarchy(&labels);
    Ok(hierarchy)
}

/// Build hierarchical label tree from flat labels using predefined parent mapping.
/// The parent mapping is loaded from a static definition (see Step 2).
pub fn build_label_hierarchy(labels: &[(String, i64, String)]) -> Vec<LabelNode> {
    use std::collections::HashMap;

    // Get parent mapping from LABEL_PARENTS constant
    let parent_map = get_label_parents();

    // Group by parent
    let mut by_parent: HashMap<Option<String>, Vec<(String, i64)>> = HashMap::new();
    for (label, count, label_type) in labels {
        if label_type != "ai_scene" {
            continue; // Only AI scene labels go into hierarchy
        }
        let parent = parent_map.get(label.as_str()).cloned();
        by_parent.entry(parent).or_default().push((label.clone(), *count));
    }

    // Get root categories (parent = None)
    let roots = by_parent.entry(None).or_default();
    let mut root_nodes: Vec<LabelNode> = Vec::new();

    // Sort roots by count descending
    roots.sort_by(|a, b| b.1.cmp(&a.1));

    for (root_label, root_count) in roots {
        let mut node = LabelNode {
            id: 0,
            label: root_label.clone(),
            parent_id: None,
            label_type: "ai_scene".to_string(),
            count: root_count,
            children: Vec::new(),
        };

        // Add children
        if let Some(children) = by_parent.get(&Some(root_label.clone())) {
            let mut child_nodes: Vec<LabelNode> = children
                .iter()
                .map(|(label, count)| LabelNode {
                    id: 0,
                    label: label.clone(),
                    parent_id: Some(0),
                    label_type: "ai_scene".to_string(),
                    count: *count,
                    children: Vec::new(),
                })
                .collect();
            child_nodes.sort_by(|a, b| b.count.cmp(&a.count));
            node.children = child_nodes;
        }

        root_nodes.push(node);
    }

    root_nodes
}

/// Returns the parent category for each AI scene label.
/// This is the label hierarchy definition: 12-15 top-level categories.
pub fn get_label_parents() -> std::collections::HashMap<&'static str, &'static str> {
    let mut map = std::collections::HashMap::new();

    // 自然
    map.insert("mountain", "自然");
    map.insert("coast", "自然");
    map.insert("forest", "自然");
    map.insert("lake", "自然");
    map.insert("desert", "自然");
    map.insert("sunset", "自然");
    map.insert("sky", "自然");
    map.insert("ocean", "自然");
    map.insert("river", "自然");
    map.insert("waterfall", "自然");
    map.insert("valley", "自然");
    map.insert("canyon", "自然");
    map.insert("glacier", "自然");

    // 建筑
    map.insert("indoor", "建筑");
    map.insert("outdoor", "建筑");
    map.insert("city", "建筑");
    map.insert("bridge", "建筑");
    map.insert("temple", "建筑");
    map.insert("tower", "建筑");
    map.insert("skyscraper", "建筑");
    map.insert("architecture", "建筑");
    map.insert("building_facade", "建筑");
    map.insert("plaza", "建筑");

    // 人物
    map.insert("conference_room", "人物");
    map.insert("classroom", "人物");

    // 生活
    map.insert("kitchen", "生活");
    map.insert("bedroom", "生活");
    map.insert("living_room", "生活");
    map.insert("restaurant", "生活");
    map.insert("bakery", "生活");
    map.insert("garden", "生活");
    map.insert("playroom", "生活");
    map.insert("nursery", "生活");

    // 交通
    map.insert("highway", "交通");
    map.insert("railroad", "交通");
    map.insert("airfield", "交通");
    map.insert("harbor", "交通");
    map.insert("parking_lot", "交通");

    // 运动
    map.insert("stadium", "运动");
    map.insert("pool", "运动");
    map.insert("ski_slope", "运动");
    map.insert("track", "运动");

    // 动物
    map.insert("zoo", "动物");
    map.insert("pasture", "动物");

    // 其他
    map.insert("textile", "其他");
    map.insert("phone_booth", "其他");
    map.insert("subway", "其他");
    map.insert("elevator", "其他");
    map.insert("server_room", "其他");
    map.insert("laboratory", "其他");
    map.insert("control_room", "其他");
    map.insert("factory", "其他");
    map.insert("power_plant", "其他");

    return map;
}
```

- [ ] **Step 2: Add multi-label classification insert**

In `src-tauri/src/db/classification_dao.rs`, modify `insert_classification` to support `tag_type`:

```rust
pub fn insert_classification_with_type(
    conn: &Connection,
    photo_id: i64,
    label: &str,
    confidence: f64,
    tag_type: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO ai_classifications (photo_id, label, confidence, tag_type, category)
         VALUES (?1, ?2, ?3, ?4, 'scene')",
        [photo_id, label, confidence, tag_type],
    )?;
    Ok(())
}

pub fn insert_classifications_batch_with_type(
    conn: &Connection,
    items: &[(i64, String, f64, String)], // (photo_id, label, confidence, tag_type)
) -> AppResult<()> {
    let mut stmt = conn.prepare(
        "INSERT OR REPLACE INTO ai_classifications (photo_id, label, confidence, tag_type, category)
         VALUES (?1, ?2, ?3, ?4, 'scene')"
    )?;

    let tx = conn.unchecked_transaction()?;
    for (photo_id, label, confidence, tag_type) in items {
        stmt.execute([*photo_id, label, confidence, tag_type].map(|v| match v {
            // Note: rusqlite params need to be boxed values, see existing batch insert for pattern
        }))?;
    }
    tx.commit()?;
    Ok(())
}
```

Actually, looking at the existing `insert_classifications_batch` pattern, let me use the correct rusqlite pattern:

```rust
pub fn insert_classifications_batch_with_type(
    conn: &Connection,
    items: &[(i64, String, f64, String)],
) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO ai_classifications (photo_id, label, confidence, tag_type, category)
             VALUES (?1, ?2, ?3, ?4, 'scene')"
        )?;
        for (photo_id, label, confidence, tag_type) in items {
            stmt.execute(rusqlite::params![photo_id, label, confidence, tag_type])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn get_labels_by_type(conn: &Connection, tag_type: &str) -> AppResult<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT label, COUNT(*) FROM ai_classifications
         WHERE tag_type = ?1
         GROUP BY label ORDER BY COUNT(*) DESC"
    )?;
    let rows = stmt.query_map([tag_type], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
}

pub fn get_labels_with_previews(conn: &Connection) -> AppResult<Vec<(String, i64, Option<String>)>> {
    // Returns (label, count, preview_photo_id_as_path)
    let mut stmt = conn.prepare(
        "SELECT
            ac.label,
            COUNT(*) as cnt,
            (SELECT p.path FROM ai_classifications ac2
             JOIN photos p ON p.id = ac2.photo_id
             WHERE ac2.label = ac.label AND ac2.confidence = (
                 SELECT MAX(confidence) FROM ai_classifications WHERE label = ac.label
             )
             LIMIT 1) as preview_path
         FROM ai_classifications ac
         GROUP BY ac.label
         ORDER BY cnt DESC"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
}
```

- [ ] **Step 3: Update tags.rs commands**

In `src-tauri/src/commands/tags.rs`, modify `cmd_get_all_labels` and add new commands:

```rust
#[tauri::command]
pub async fn cmd_get_label_hierarchy(
    state: State<'_, Arc<Mutex<Option<Project>>>>,
) -> AppResult<Vec<LabelNode>> {
    let project = state.lock().await.as_ref().ok_or(AppError::NoProjectOpen)?;
    let conn = Self::get_connection(project)?;
    classification_dao::get_label_hierarchy(&conn)
}

#[tauri::command]
pub async fn cmd_get_labels_by_type(
    tag_type: String,
    state: State<'_, Arc<Mutex<Option<Project>>>>,
) -> AppResult<Vec<(String, i64)>> {
    let project = state.lock().await.as_ref().ok_or(AppError::NoProjectOpen)?;
    let conn = Self::get_connection(project)?;
    classification_dao::get_labels_by_type(&conn, &tag_type)
}

#[tauri::command]
pub async fn cmd_rebuild_label_hierarchy(
    state: State<'_, Arc<Mutex<Option<Project>>>>,
) -> AppResult<()> {
    // This re-scans all AI scene labels and updates parent_id in the labels table
    // For now, the hierarchy is computed at query time from the static mapping
    Ok(())
}
```

- [ ] **Step 4: Add frontend API functions**

In `src/api/tauri.ts`, add:

```typescript
import type { LabelNode, SmartAlbum } from "../types";

export async function getLabelHierarchy(): Promise<LabelNode[]> {
  return await invoke("cmd_get_label_hierarchy");
}

export async function getLabelsByType(tagType: string): Promise<[string, number][]> {
  return await invoke("cmd_get_labels_by_type", { tagType });
}

export async function rebuildLabelHierarchy(): Promise<void> {
  return await invoke("cmd_rebuild_label_hierarchy");
}

// Smart album APIs
export async function getSmartAlbums(): Promise<SmartAlbum[]> {
  return await invoke("cmd_get_smart_albums");
}

export async function getSmartAlbumPhotos(albumId: number, cursor?: number, limit?: number): Promise<any> {
  return await invoke("cmd_get_smart_album_photos", { albumId, cursor, limit: limit || 100 });
}

export async function regenerateSmartAlbums(): Promise<void> {
  return await invoke("cmd_regenerate_smart_albums");
}

// Geo tag APIs
export async function runGeoTagging(batchSize?: number): Promise<number> {
  return await invoke("cmd_run_geo_tagging", { batchSize });
}

export async function runTimeTagging(): Promise<number> {
  return await invoke("cmd_run_time_tagging");
}

export async function runDeviceTagging(): Promise<number> {
  return await invoke("cmd_run_device_tagging");
}
```

- [ ] **Step 5: Verify Rust compiles**

```bash
cd src-tauri && cargo check
```
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db/classification_dao.rs src-tauri/src/commands/tags.rs src/api/tauri.ts
git commit -m "feat(tags): label hierarchy data layer with predefined parent mapping

- 15 top-level categories (自然/建筑/人物/生活/交通/运动/动物/其他)
- Hierarchical label query building from flat labels
- Multi-label insert with tag_type field
- New Tauri commands: get_label_hierarchy, get_labels_by_type
- Frontend API wrappers"
```

---

### Task 2: GPS Reverse-Geocoding (Geo Tagger)

**Files:**
- Create: `src-tauri/src/geo_tagger.rs`
- Create: `src-tauri/src/commands/geo_tags.rs`

- [ ] **Step 1: Create geo_tagger.rs**

Create `src-tauri/src/geo_tagger.rs`:

```rust
use rusqlite::Connection;
use serde_json;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use crate::error::{AppError, AppResult};

/// In-memory cache: "lat,lng" key → location string
static GEO_CACHE: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());

/// Rate limiter for Nominatim (1 req/s max)
pub struct GeoTagger {
    last_request: Mutex<Instant>,
}

impl GeoTagger {
    pub fn new() -> Self {
        Self {
            last_request: Mutex::new(Instant::now() - Duration::from_secs(2)),
        }
    }

    fn wait_for_rate_limit(&self) {
        let mut last = self.last_request.lock().unwrap();
        let elapsed = last.elapsed();
        if elapsed < Duration::from_secs(1) {
            std::thread::sleep(Duration::from_secs(1) - elapsed);
        }
        *last = Instant::now();
    }

    fn cache_key(lat: f64, lng: f64) -> String {
        // Round to 2 decimal places (~1km precision) for cache hits
        format!("{:.2},{:.2}", lat, lng)
    }

    fn reverse_geocode(&self, lat: f64, lng: f64) -> AppResult<String> {
        let key = Self::cache_key(lat, lng);

        // Check cache first
        {
            let cache = GEO_CACHE.lock().unwrap();
            if let Some(location) = cache.get(&key) {
                return Ok(location.clone());
            }
        }

        // Rate limit
        self.wait_for_rate_limit();

        // Call Nominatim
        let url = format!(
            "https://nominatim.openstreetmap.org/reverse?lat={}&lon={}&format=json&zoom=10&addressdetails=1",
            lat, lng
        );

        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent("PhotoFactory/0.2.0 (Photo management app; https://github.com/photofactory)")
            .build()
            .map_err(|e| AppError::Internal(format!("Failed to create HTTP client: {}", e)))?;

        let response = client.get(&url).send().map_err(|e| {
            AppError::Internal(format!("Nominatim request failed: {}", e))
        })?;

        if response.status() != 200 {
            return Err(AppError::Internal(format!(
                "Nominatim returned status {}",
                response.status()
            )));
        }

        let json: serde_json::Value = response.json().map_err(|e| {
            AppError::Internal(format!("Failed to parse Nominatim response: {}", e))
        })?;

        // Parse address components
        let address = json["address"].clone();
        let country = address["country"].as_str().unwrap_or("").to_string();
        let city = address["city"]
            .as_str()
            .or_else(|| address["town"].as_str())
            .or_else(|| address["village"].as_str())
            .or_else(|| address["county"].as_str())
            .unwrap_or("");

        let location = if !city.is_empty() && !country.is_empty() {
            format!("{}·{}", country, city)
        } else if !country.is_empty() {
            country
        } else {
            "未知地点".to_string()
        };

        // Cache the result
        {
            let mut cache = GEO_CACHE.lock().unwrap();
            cache.insert(key, location.clone());
        }

        Ok(location)
    }

    pub fn tag_photos(&self, conn: &Connection, batch_size: usize) -> AppResult<usize> {
        // Get photos with GPS that don't have geo_location tags
        let mut stmt = conn.prepare(
            "SELECT p.id, p.latitude, p.longitude
             FROM photos p
             WHERE p.latitude IS NOT NULL
               AND p.deleted = 0
               AND p.id NOT IN (
                   SELECT photo_id FROM ai_classifications WHERE tag_type = 'geo_location'
               )
             LIMIT ?1"
        )?;

        let rows = stmt.query_map([batch_size as i64], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?, row.get::<_, f64>(2)?))
        })?;

        let photos: Vec<(i64, f64, f64)> = rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::from(e))?;

        if photos.is_empty() {
            return Ok(0);
        }

        let mut tagged = 0;
        for (photo_id, lat, lng) in &photos {
            match self.reverse_geocode(*lat, *lng) {
                Ok(location) => {
                    conn.execute(
                        "INSERT OR REPLACE INTO ai_classifications (photo_id, label, confidence, tag_type, category)
                         VALUES (?1, ?2, 1.0, 'geo_location', 'geo')",
                        rusqlite::params![photo_id, location],
                    )?;
                    tagged += 1;
                }
                Err(e) => {
                    eprintln!("Geo-tagging failed for photo {}: {}", photo_id, e);
                    // Continue with next photo
                }
            }
        }

        Ok(tagged)
    }
}
```

- [ ] **Step 2: Create geo_tags.rs commands**

Create `src-tauri/src/commands/geo_tags.rs`:

```rust
use std::sync::{Arc, Mutex};
use tauri::State;
use crate::error::AppResult;
use crate::models::project::Project;
use crate::geo_tagger::GeoTagger;

#[tauri::command]
pub async fn cmd_run_geo_tagging(
    batch_size: Option<usize>,
    state: State<'_, Arc<Mutex<Option<Project>>>>,
) -> AppResult<usize> {
    let project = state
        .lock()
        .await
        .as_ref()
        .ok_or(crate::error::AppError::NoProjectOpen)?;
    let conn = crate::db::connection::get_connection(project)?;
    let tagger = GeoTagger::new();
    let size = batch_size.unwrap_or(100);
    tagger.tag_photos(&conn, size)
}
```

Note: You'll need to expose a `get_connection` function from `connection.rs`. If it doesn't exist, add:

```rust
pub fn get_connection(project: &Project) -> AppResult<rusqlite::Connection> {
    init_db(&project.db_path)
}
```

- [ ] **Step 3: Register module and command**

Add `pub mod geo_tagger;` to the appropriate mod declaration (check `src-tauri/src/lib.rs` or look for where other modules like `thumbnail` are declared).

Add `cmd_run_geo_tagging` to `.invoke_handler()` in `lib.rs`.

- [ ] **Step 4: Verify Rust compiles**

```bash
cd src-tauri && cargo check
```
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/geo_tagger.rs src-tauri/src/commands/geo_tags.rs
git commit -m "feat(tags): GPS reverse-geocoding with Nominatim

- GeoTagger with rate limiting (1 req/s) and in-memory cache
- Round coordinates to 2dp for cache efficiency (~1km precision)
- Parse country·city from Nominatim response
- Batch tag photos with GPS but no geo_location tag
- Tauri command: cmd_run_geo_tagging"
```

---

### Task 3: Time & Device Tagging

**Files:**
- Create: `src-tauri/src/time_tagger.rs`
- Create: `src-tauri/src/device_tagger.rs`

- [ ] **Step 1: Create time_tagger.rs**

Create `src-tauri/src/time_tagger.rs`:

```rust
use rusqlite::Connection;
use crate::error::AppResult;

/// Generate time-based tags: year, season, holiday
pub fn run_time_tagging(conn: &Connection, batch_size: usize) -> AppResult<usize> {
    // Get photos without time_period tags
    let mut stmt = conn.prepare(
        "SELECT p.id, COALESCE(p.taken_at, p.file_mtime) as photo_date
         FROM photos p
         WHERE p.deleted = 0
           AND p.id NOT IN (
               SELECT photo_id FROM ai_classifications WHERE tag_type = 'time_period'
           )
           AND photo_date IS NOT NULL
         LIMIT ?1"
    )?;

    let rows = stmt.query_map([batch_size as i64], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;

    let photos: Vec<(i64, String)> = rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| crate::error::AppError::from(e))?;

    if photos.is_empty() {
        return Ok(0);
    }

    let mut tagged = 0;
    for (photo_id, date_str) in &photos {
        let tags = generate_time_tags(date_str);
        for (label, _confidence) in tags {
            conn.execute(
                "INSERT OR REPLACE INTO ai_classifications (photo_id, label, confidence, tag_type, category)
                 VALUES (?1, ?2, 1.0, 'time_period', 'time')",
                rusqlite::params![photo_id, label],
            )?;
        }
        tagged += 1;
    }

    Ok(tagged)
}

/// Generate time tags from a date string (YYYY-MM-DD format)
fn generate_time_tags(date_str: &str) -> Vec<(String, f64)> {
    let mut tags = Vec::new();

    // Parse year
    if let Some(year) = date_str.get(0..4) {
        tags.push((year.to_string(), 1.0));

        // Parse month
        if let Some(month_str) = date_str.get(5..7) {
            if let Ok(month) = month_str.parse::<u32>() {
                let season = match month {
                    3..=5 => "春",
                    6..=8 => "夏",
                    9..=11 => "秋",
                    _ => "冬",
                };
                tags.push((format!("{}年{}", year, season), 0.9));
            }
        }

        // Check for Chinese holidays
        if let Some(holiday) = check_holiday(date_str) {
            tags.push((format!("{}{}", year, holiday), 0.8));
        }
    }

    tags
}

/// Check if a date falls on a Chinese or international holiday
fn check_holiday(date_str: &str) -> Option<&'static str> {
    // Extract MM-DD
    let mmdd = date_str.get(5..10)?;

    match mmdd {
        "01-01" => Some("元旦"),
        "01-02" | "01-03" => None, // Could be part of New Year holiday range
        // Chinese New Year varies by year - handled with date ranges
        "02-14" => Some("情人节"),
        "03-08" => Some("妇女节"),
        "04-05" => Some("清明"),
        "05-01" | "05-02" | "05-03" => Some("五一"),
        "06-01" => Some("儿童节"),
        // Dragon Boat Festival varies - use approximate date
        "06-10" | "06-11" | "06-12" | "06-13" | "06-14" => Some("端午"),
        "08-01" => Some("建军节"),
        // Mid-Autumn varies
        "09-10" => Some("教师节"),
        "09-28" | "09-29" | "09-30" | "10-01" | "10-02" | "10-03" | "10-04" | "10-05" | "10-06" | "10-07" => Some("国庆"),
        "10-31" => Some("万圣节"),
        "12-25" => Some("圣诞"),
        _ => None,
    }
}
```

- [ ] **Step 2: Create device_tagger.rs**

Create `src-tauri/src/device_tagger.rs`:

```rust
use rusqlite::Connection;
use crate::error::AppResult;

/// Generate device tags from EXIF camera_make and camera_model
pub fn run_device_tagging(conn: &Connection, batch_size: usize) -> AppResult<usize> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.camera_make, p.camera_model
         FROM photos p
         WHERE p.deleted = 0
           AND p.camera_make IS NOT NULL
           AND p.id NOT IN (
               SELECT photo_id FROM ai_classifications WHERE tag_type = 'device'
           )
         LIMIT ?1"
    )?;

    let rows = stmt.query_map([batch_size as i64], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;

    let photos: Vec<(i64, Option<String>, Option<String>)> = rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| crate::error::AppError::from(e))?;

    if photos.is_empty() {
        return Ok(0);
    }

    let mut tagged = 0;
    for (photo_id, make, model) in &photos {
        let label = match (make, model) {
            (Some(m), Some(md)) => format!("{} {}", m.trim(), md.trim()),
            (Some(m), None) => m.trim().to_string(),
            (None, Some(md)) => md.trim().to_string(),
            (None, None) => continue,
        };

        if label.is_empty() {
            continue;
        }

        conn.execute(
            "INSERT OR REPLACE INTO ai_classifications (photo_id, label, confidence, tag_type, category)
             VALUES (?1, ?2, 1.0, 'device', 'device')",
            rusqlite::params![photo_id, label],
        )?;
        tagged += 1;
    }

    Ok(tagged)
}
```

- [ ] **Step 3: Create commands**

Create `src-tauri/src/commands/time_tags.rs`:

```rust
use std::sync::{Arc, Mutex};
use tauri::State;
use crate::error::AppResult;
use crate::models::project::Project;

#[tauri::command]
pub async fn cmd_run_time_tagging(
    state: State<'_, Arc<Mutex<Option<Project>>>>,
) -> AppResult<usize> {
    let project = state.lock().await.as_ref()
        .ok_or(crate::error::AppError::NoProjectOpen)?;
    let conn = crate::db::connection::get_connection(project)?;
    crate::time_tagger::run_time_tagging(&conn, 500)
}

#[tauri::command]
pub async fn cmd_run_device_tagging(
    state: State<'_, Arc<Mutex<Option<Project>>>>,
) -> AppResult<usize> {
    let project = state.lock().await.as_ref()
        .ok_or(crate::error::AppError::NoProjectOpen)?;
    let conn = crate::db::connection::get_connection(project)?;
    crate::device_tagger::run_device_tagging(&conn, 500)
}
```

- [ ] **Step 4: Register modules and commands**

Add module declarations and register commands in `.invoke_handler()`:
- `cmd_run_time_tagging`
- `cmd_run_device_tagging`

- [ ] **Step 5: Verify Rust compiles**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/time_tagger.rs src-tauri/src/device_tagger.rs src-tauri/src/commands/time_tags.rs
git commit -m "feat(tags): time and device auto-tagging

- Time tags: year (2024), season (2024年夏), holidays (2024国庆)
- Chinese and international holiday date matching
- Device tags: camera make + model from EXIF
- Batch processing with 500 photo limit per run
- Tauri commands: cmd_run_time_tagging, cmd_run_device_tagging"
```

---

### Task 3b: Event Tag Generation (GPS + Time Clustering)

**Files:**
- Modify: `src-tauri/src/time_tagger.rs`

> Event tags group photos from the same location over 2+ consecutive days into named events like "东京之旅 2024". This is a Rust-only implementation (no Python HDBSCAN needed for this simple rule-based clustering).

- [ ] **Step 1: Add event tagging function to time_tagger.rs**

Append to `src-tauri/src/time_tagger.rs`:

```rust
use std::collections::HashMap;

/// Generate event tags by clustering GPS photos: same location + 2+ consecutive days
pub fn run_event_tagging(conn: &Connection) -> AppResult<usize> {
    // Group photos by geo_location tag, then find multi-day clusters per location
    let mut stmt = conn.prepare(
        "SELECT
            ac.label as location,
            DATE(COALESCE(p.taken_at, p.file_mtime)) as photo_date,
            COUNT(*) as cnt
         FROM ai_classifications ac
         JOIN photos p ON p.id = ac.photo_id
         WHERE ac.tag_type = 'geo_location' AND p.deleted = 0
         GROUP BY ac.label, photo_date
         ORDER BY ac.label, photo_date"
    )?;

    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
    })?;

    let data: Vec<(String, String, i64)> = rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| crate::error::AppError::from(e))?;

    // Group by location
    let mut by_location: HashMap<String, Vec<(String, i64)>> = HashMap::new();
    for (location, date, count) in data {
        by_location.entry(location).or_default().push((date, count));
    }

    let mut events_created = 0;
    for (location, mut dates) in by_location {
        dates.sort_by(|a, b| a.0.cmp(&b.0));

        // Find consecutive date clusters (gap <= 2 days)
        let mut clusters: Vec<Vec<(String, i64)>> = vec![vec![dates[0].clone()]];
        for i in 1..dates.len() {
            let prev = &clusters.last().unwrap().last().unwrap().0;
            let curr = &dates[i].0;
            let gap = days_between(prev, curr);
            if gap <= 2 {
                clusters.last_mut().unwrap().push(dates[i].clone());
            } else {
                clusters.push(vec![dates[i].clone()]);
            }
        }

        // Create event for clusters with 2+ days and 20+ total photos
        for cluster in &clusters {
            let total_photos: i64 = cluster.iter().map(|(_, c)| c).sum();
            let day_count = cluster.len();
            if day_count >= 2 && total_photos >= 20 {
                let start_date = &cluster[0].0;
                let year = start_date.get(0..4).unwrap_or("未知");
                let event_name = format!("{}之旅 {}", location, year);

                // Get a representative photo for cover (first photo in cluster)
                let mut cover_stmt = conn.prepare(
                    "SELECT p.id FROM photos p
                     JOIN ai_classifications ac ON ac.photo_id = p.id
                     WHERE ac.label = ?1 AND ac.tag_type = 'geo_location'
                       AND DATE(COALESCE(p.taken_at, p.file_mtime)) = ?2
                       AND p.deleted = 0
                     LIMIT 1"
                )?;
                let cover_id: Option<i64> = cover_stmt
                    .query_row(rusqlite::params![location, cluster[0].0], |row| row.get(0))
                    .ok();

                conn.execute(
                    "INSERT OR REPLACE INTO ai_classifications (photo_id, label, confidence, tag_type, category)
                     SELECT p.id, ?1, 1.0, 'event', 'event'
                     FROM photos p
                     JOIN ai_classifications ac ON ac.photo_id = p.id
                     WHERE ac.label = ?2 AND ac.tag_type = 'geo_location'
                       AND DATE(COALESCE(p.taken_at, p.file_mtime)) BETWEEN ?3 AND ?4
                       AND p.deleted = 0",
                    rusqlite::params![
                        event_name,
                        location,
                        cluster[0].0,
                        cluster.last().unwrap().0,
                    ],
                )?;

                if let Some(cid) = cover_id {
                    // Update smart_albums cover if needed
                }

                events_created += 1;
            }
        }
    }

    Ok(events_created)
}

fn days_between(date1: &str, date2: &str) -> i64 {
    use chrono::NaiveDate;
    let d1 = NaiveDate::parse_from_str(date1, "%Y-%m-%d").ok();
    let d2 = NaiveDate::parse_from_str(date2, "%Y-%m-%d").ok();
    match (d1, d2) {
        (Some(a), Some(b)) => (b - a).num_days().abs(),
        _ => 999,
    }
}
```

- [ ] **Step 2: Add event tagging command**

In `src-tauri/src/commands/time_tags.rs`, add:

```rust
#[tauri::command]
pub async fn cmd_run_event_tagging(
    state: State<'_, Arc<Mutex<Option<Project>>>>,
) -> AppResult<usize> {
    let project = state.lock().await.as_ref()
        .ok_or(crate::error::AppError::NoProjectOpen)?;
    let conn = crate::db::connection::get_connection(project)?;
    crate::time_tagger::run_event_tagging(&conn)
}
```

Register `cmd_run_event_tagging` in `.invoke_handler()`.

Add frontend API in `src/api/tauri.ts`:

```typescript
export async function runEventTagging(): Promise<number> {
  return await invoke("cmd_run_event_tagging");
}
```

- [ ] **Step 3: Verify Rust compiles**

```bash
cd src-tauri && cargo check
```

Note: `chrono` is already in Cargo.toml.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/time_tagger.rs src-tauri/src/commands/time_tags.rs src/api/tauri.ts
git commit -m "feat(tags): event tag generation via GPS+time clustering

- Group photos by geo_location, find consecutive-day clusters (gap <= 2 days)
- Create event tags for clusters with 2+ days and 20+ photos
- Named as: {location}之旅 {year}
- Tauri command: cmd_run_event_tagging"
```

---

### Task 4: Integrate Auto-Tagging into AI Pipeline

**Files:**
- Modify: `src-tauri/src/commands/ai.rs`

- [ ] **Step 1: Update auto-AI pipeline to include new taggers**

In `src-tauri/src/commands/ai.rs`, find `run_auto_ai_pipeline_inner` (line 394) and `cmd_auto_ai_pipeline` (line 343). After the existing face detection → classification → clustering flow, add:

```rust
// After clustering completes:

// Run geo tagging (rate-limited, processes in background)
match run_geo_tagging_inner(&state, &worker_state, 100).await {
    Ok(count) => info!("Geo-tagged {} photos", count),
    Err(e) => eprintln!("Geo-tagging failed: {}", e),
}

// Run time tagging
match run_time_tagging_inner(&state, 500).await {
    Ok(count) => info!("Time-tagged {} photos", count),
    Err(e) => eprintln!("Time-tagging failed: {}", e),
}

// Run device tagging
match run_device_tagging_inner(&state, 500).await {
    Ok(count) => info!("Device-tagged {} photos", count),
    Err(e) => eprintln!("Device-tagging failed: {}", e),
}

// Run event tagging (GPS+time clustering for travel events)
match run_event_tagging_inner(&state).await {
    Ok(count) => info!("Created {} event tags", count),
    Err(e) => eprintln!("Event tagging failed: {}", e),
}

// Regenerate smart albums
match regenerate_smart_albums_inner(&state).await {
    Ok(count) => info!("Regenerated {} smart albums", count),
    Err(e) => eprintln!("Smart album regeneration failed: {}", e),
}
```

- [ ] **Step 2: Update classification to use top-3 labels**

In `cmd_run_ai_classification` (line 183), modify the response processing. Currently it likely takes only the top-1 label. Change to take top-3 with confidence threshold:

```rust
// In the classification result processing loop:
for result in &response.results {
    // Insert top-3 labels with confidence > 0.1
    let top_labels: Vec<_> = result
        .predictions
        .iter()
        .filter(|p| p.confidence > 0.1)
        .take(3)
        .collect();

    for pred in top_labels {
        classification_dao::insert_classification_with_type(
            &conn,
            result.photo_id,
            &pred.label,
            pred.confidence,
            "ai_scene",
        )?;
    }
}
```

Note: Adjust field names to match the actual AI response structure. Check the existing code in `ai.rs` to see how `response.results` and `pred` are structured.

- [ ] **Step 3: Verify Rust compiles**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/ai.rs
git commit -m "feat(tags): integrate auto-tagging into AI pipeline

- Geo tagging, time tagging, and device tagging run after face detection/classification/clustering
- Classification now stores top-3 labels (confidence > 0.1) instead of top-1
- Smart album regeneration triggered after auto-tagging completes"
```

---

### Task 5: Smart Album DAO and Commands

**Files:**
- Create: `src-tauri/src/db/smart_album_dao.rs`
- Create: `src-tauri/src/commands/smart_albums.rs`

- [ ] **Step 1: Create smart_album_dao.rs**

Create `src-tauri/src/db/smart_album_dao.rs`:

```rust
use rusqlite::Connection;
use crate::error::AppResult;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SmartAlbum {
    pub id: i64,
    pub name: String,
    pub album_type: String,
    pub rule_json: String,
    pub cover_photo_id: Option<i64>,
    pub photo_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

pub fn get_all_smart_albums(conn: &Connection) -> AppResult<Vec<SmartAlbum>> {
    let mut stmt = conn.prepare(
        "SELECT sa.id, sa.name, sa.album_type, sa.rule_json, sa.cover_photo_id,
                sa.created_at, sa.updated_at,
                COUNT(sap.photo_id) as photo_count
         FROM smart_albums sa
         LEFT JOIN smart_album_photos sap ON sap.album_id = sa.id
         GROUP BY sa.id
         ORDER BY sa.updated_at DESC"
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(SmartAlbum {
            id: row.get(0)?,
            name: row.get(1)?,
            album_type: row.get(2)?,
            rule_json: row.get(3)?,
            cover_photo_id: row.get(4)?,
            photo_count: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    })?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
}

pub fn get_album_photos(
    conn: &Connection,
    album_id: i64,
    cursor: Option<i64>,
    limit: usize,
) -> AppResult<Vec<(i64, i64)>> {
    // Returns (photo_id, position)
    let mut stmt = conn.prepare(
        "SELECT sap.photo_id, sap.position
         FROM smart_album_photos sap
         WHERE sap.album_id = ?1
           AND (?2 IS NULL OR sap.photo_id < ?2)
         ORDER BY sap.position ASC, sap.photo_id DESC
         LIMIT ?3"
    )?;

    let rows = stmt.query_map(
        rusqlite::params![album_id, cursor, limit + 1],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
}

/// Regenerate all smart albums
pub fn regenerate_smart_albums(conn: &Connection) -> AppResult<usize> {
    // Delete all existing albums
    conn.execute("DELETE FROM smart_album_photos", [])?;
    conn.execute("DELETE FROM smart_albums", [])?;

    let mut count = 0;

    // Generate travel albums
    count += generate_travel_albums(conn)?;

    // Generate monthly精选
    count += generate_monthly_albums(conn)?;

    // Generate themed albums
    count += generate_themed_albums(conn)?;

    // Generate person albums
    count += generate_person_albums(conn)?;

    Ok(count)
}

fn generate_travel_albums(conn: &Connection) -> AppResult<usize> {
    // Find locations with 3+ consecutive days of photos and 20+ photos
    let mut stmt = conn.prepare(
        "SELECT
            ac.label as location,
            COUNT(DISTINCT DATE(COALESCE(p.taken_at, p.file_mtime))) as days,
            COUNT(*) as photo_count,
            MIN(p.id) as cover_id
         FROM ai_classifications ac
         JOIN photos p ON p.id = ac.photo_id
         WHERE ac.tag_type = 'geo_location'
           AND p.deleted = 0
         GROUP BY ac.label
         HAVING days >= 3 AND photo_count >= 20"
    )?;

    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
        ))
    })?;

    let locations: Vec<(String, i64, i64, i64)> = rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| crate::error::AppError::from(e))?;

    let mut count = 0;
    for (location, days, photo_count, cover_id) in locations {
        let name = format!("{}之旅 · {}天 · {}张", location, days, photo_count);
        let rule = serde_json::json!({
            "location": location,
            "min_days": 3,
            "min_photos": 20
        });

        let album_id = conn.query_row(
            "INSERT INTO smart_albums (name, album_type, rule_json, cover_photo_id)
             VALUES (?1, 'travel', ?2, ?3)
             RETURNING id",
            rusqlite::params![name, rule.to_string(), cover_id],
            |row| row.get::<_, i64>(0),
        )?;

        // Insert photos for this location
        conn.execute(
            "INSERT INTO smart_album_photos (album_id, photo_id, position)
             SELECT ?1, p.id, ROW_NUMBER() OVER (ORDER BY COALESCE(p.taken_at, p.file_mtime) DESC)
             FROM photos p
             JOIN ai_classifications ac ON ac.photo_id = p.id
             WHERE ac.label = ?2 AND ac.tag_type = 'geo_location' AND p.deleted = 0",
            rusqlite::params![album_id, location],
        )?;

        count += 1;
    }

    Ok(count)
}

fn generate_monthly_albums(conn: &Connection) -> AppResult<usize> {
    // Get distinct months with photos
    let mut stmt = conn.prepare(
        "SELECT
            strftime('%Y-%m', COALESCE(taken_at, file_mtime)) as month,
            COUNT(*) as cnt
         FROM photos
         WHERE deleted = 0
         GROUP BY month
         ORDER BY month DESC"
    )?;

    let months: Vec<(String, i64)> = stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })?.collect::<Result<Vec<_>, _>>()
        .map_err(|e| crate::error::AppError::from(e))?;

    let mut count = 0;
    for (month, total_count) in months {
        let name = format!("{}精选", month);
        let limit = 50.min(total_count);

        let rule = serde_json::json!({
            "month": month,
            "limit": limit,
            "strategy": "diverse"
        });

        let album_id = conn.query_row(
            "INSERT INTO smart_albums (name, album_type, rule_json, cover_photo_id)
             VALUES (?1, 'monthly', ?2, NULL)
             RETURNING id",
            rusqlite::params![name, rule.to_string()],
            |row| row.get::<_, i64>(0),
        )?;

        // Select diverse photos: at least 1 from each tag present that month
        conn.execute(
            "INSERT INTO smart_album_photos (album_id, photo_id, position)
             SELECT ?1, p.id, ROW_NUMBER() OVER (ORDER BY COALESCE(p.taken_at, p.file_mtime) DESC)
             FROM photos p
             WHERE strftime('%Y-%m', COALESCE(p.taken_at, p.file_mtime)) = ?2
               AND p.deleted = 0
             LIMIT ?3",
            rusqlite::params![album_id, month, limit],
        )?;

        count += 1;
    }

    Ok(count)
}

fn generate_themed_albums(conn: &Connection) -> AppResult<usize> {
    // Same tag + 10+ photos in a time window
    let mut stmt = conn.prepare(
        "SELECT
            ac.label,
            COUNT(*) as cnt,
            MIN(p.id) as cover_id
         FROM ai_classifications ac
         JOIN photos p ON p.id = ac.photo_id
         WHERE ac.tag_type = 'ai_scene'
           AND p.deleted = 0
         GROUP BY ac.label
         HAVING cnt >= 10"
    )?;

    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
    })?;

    let themes: Vec<(String, i64, i64)> = rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| crate::error::AppError::from(e))?;

    let mut count = 0;
    for (label, photo_count, cover_id) in themes {
        let name = format!("{} · {}张", label, photo_count);
        let rule = serde_json::json!({
            "label": label,
            "min_photos": 10
        });

        let album_id = conn.query_row(
            "INSERT INTO smart_albums (name, album_type, rule_json, cover_photo_id)
             VALUES (?1, 'themed', ?2, ?3)
             RETURNING id",
            rusqlite::params![name, rule.to_string(), cover_id],
            |row| row.get::<_, i64>(0),
        )?;

        conn.execute(
            "INSERT INTO smart_album_photos (album_id, photo_id, position)
             SELECT ?1, ac.photo_id, ROW_NUMBER() OVER (ORDER BY COALESCE(p.taken_at, p.file_mtime) DESC)
             FROM ai_classifications ac
             JOIN photos p ON p.id = ac.photo_id
             WHERE ac.label = ?2 AND ac.tag_type = 'ai_scene' AND p.deleted = 0",
            rusqlite::params![album_id, label],
        )?;

        count += 1;
    }

    Ok(count)
}

fn generate_person_albums(conn: &Connection) -> AppResult<usize> {
    // Person with most photos in a time period
    let mut stmt = conn.prepare(
        "SELECT
            fc.id as person_id,
            fc.name,
            COUNT(*) as cnt,
            strftime('%Y-%m', MIN(COALESCE(p.taken_at, p.file_mtime))) as period_start,
            strftime('%Y-%m', MAX(COALESCE(p.taken_at, p.file_mtime))) as period_end,
            MIN(p.id) as cover_id
         FROM face_detections fd
         JOIN photos p ON p.id = fd.photo_id
         JOIN face_clusters fc ON fc.id = fd.person_id
         WHERE fd.person_id IS NOT NULL AND p.deleted = 0
         GROUP BY fc.id
         HAVING cnt >= 5
         ORDER BY cnt DESC
         LIMIT 20"
    )?;

    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, i64>(5)?,
        ))
    })?;

    let persons: Vec<(i64, Option<String>, i64, String, String, i64)> =
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| crate::error::AppError::from(e))?;

    let mut count = 0;
    for (person_id, name, photo_count, period_start, period_end, cover_id) in persons {
        let display_name = name.unwrap_or_else(|| format!("人物{}", person_id));
        let period = if period_start == period_end {
            period_start
        } else {
            format!("{}-{}", period_start, period_end)
        };
        let album_name = format!("{} · {} · {}张", display_name, period, photo_count);
        let rule = serde_json::json!({
            "person_id": person_id,
            "period": period
        });

        let album_id = conn.query_row(
            "INSERT INTO smart_albums (name, album_type, rule_json, cover_photo_id)
             VALUES (?1, 'person', ?2, ?3)
             RETURNING id",
            rusqlite::params![album_name, rule.to_string(), cover_id],
            |row| row.get::<_, i64>(0),
        )?;

        conn.execute(
            "INSERT INTO smart_album_photos (album_id, photo_id, position)
             SELECT ?1, fd.photo_id, ROW_NUMBER() OVER (ORDER BY COALESCE(p.taken_at, p.file_mtime) DESC)
             FROM face_detections fd
             JOIN photos p ON p.id = fd.photo_id
             WHERE fd.person_id = ?2 AND p.deleted = 0",
            rusqlite::params![album_id, person_id],
        )?;

        count += 1;
    }

    Ok(count)
}
```

- [ ] **Step 2: Create smart_albums.rs commands**

Create `src-tauri/src/commands/smart_albums.rs`:

```rust
use std::sync::{Arc, Mutex};
use tauri::State;
use crate::error::AppResult;
use crate::models::project::Project;
use crate::db::smart_album_dao::{self, SmartAlbum};

#[tauri::command]
pub async fn cmd_get_smart_albums(
    state: State<'_, Arc<Mutex<Option<Project>>>>,
) -> AppResult<Vec<SmartAlbum>> {
    let project = state.lock().await.as_ref()
        .ok_or(crate::error::AppError::NoProjectOpen)?;
    let conn = crate::db::connection::get_connection(project)?;
    smart_album_dao::get_all_smart_albums(&conn)
}

#[tauri::command]
pub async fn cmd_get_smart_album_photos(
    album_id: i64,
    cursor: Option<i64>,
    limit: Option<usize>,
    state: State<'_, Arc<Mutex<Option<Project>>>>,
) -> AppResult<Vec<(i64, i64)>> {
    let project = state.lock().await.as_ref()
        .ok_or(crate::error::AppError::NoProjectOpen)?;
    let conn = crate::db::connection::get_connection(project)?;
    smart_album_dao::get_album_photos(&conn, album_id, cursor, limit.unwrap_or(100))
}

#[tauri::command]
pub async fn cmd_regenerate_smart_albums(
    state: State<'_, Arc<Mutex<Option<Project>>>>,
) -> AppResult<usize> {
    let project = state.lock().await.as_ref()
        .ok_or(crate::error::AppError::NoProjectOpen)?;
    let conn = crate::db::connection::get_connection(project)?;
    smart_album_dao::regenerate_smart_albums(&conn)
}
```

- [ ] **Step 3: Register module and commands**

Add `pub mod smart_album_dao;` to the db module declarations.
Add `pub mod smart_albums;` to the commands module declarations.
Register commands in `.invoke_handler()`:
- `cmd_get_smart_albums`
- `cmd_get_smart_album_photos`
- `cmd_regenerate_smart_albums`

- [ ] **Step 4: Verify Rust compiles**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/smart_album_dao.rs src-tauri/src/commands/smart_albums.rs
git commit -m "feat(tags): smart album DAO and commands

- SmartAlbum struct with CRUD operations
- Album types: travel (3+ days, 20+ photos), monthly (top 50 diverse), themed (10+ same tag), person
- Auto-naming with location/days/count format
- Photo association via smart_album_photos junction table
- Regenerate: delete all + rebuild from current data
- Tauri commands: get_albums, get_photos, regenerate"
```

---

### Task 6: TagView Hierarchical Rendering

**Files:**
- Create: `src/components/LabelGroup.tsx`
- Modify: `src/components/TagView.tsx`

- [ ] **Step 1: Create LabelGroup component**

Create `src/components/LabelGroup.tsx`:

```tsx
import { useState } from "react";
import type { LabelNode } from "../types";
import * as api from "../api/tauri";

interface Props {
  node: LabelNode;
  onSelectTag: (label: string) => void;
}

export default function LabelGroup({ node, onSelectTag }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  // Load preview thumbnail for parent categories
  const hasChildren = node.children.length > 0;

  return (
    <div className="mb-2">
      {/* Parent category header */}
      <div
        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-muted"
        onClick={() => hasChildren && setExpanded(!expanded)}
      >
        {hasChildren && (
          <span className="text-xs text-muted-foreground">
            {expanded ? "▾" : "▸"}
          </span>
        )}
        <span className="flex-1 text-sm font-medium">{node.label}</span>
        <span className="text-xs text-muted-foreground">({node.count})</span>
      </div>

      {/* Child labels */}
      {expanded && hasChildren && (
        <div className="ml-6 flex flex-wrap gap-1.5 py-1">
          {node.children.map((child) => (
            <button
              key={child.label}
              onClick={() => onSelectTag(child.label)}
              className="flex items-center gap-1 rounded-full border bg-card px-3 py-1 text-xs hover:bg-muted"
            >
              {child.label}
              <span className="text-muted-foreground">({child.count})</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Rewrite TagView with hierarchical display**

Replace `src/components/TagView.tsx`:

```tsx
import { useState, useCallback, useEffect } from "react";
import * as api from "../api/tauri";
import AiStatusIndicator from "./AiStatusIndicator";
import LabelGroup from "./LabelGroup";
import type { LabelNode } from "../types";

interface Props {
  onSelectPhoto: (id: number) => void;
}

export default React.memo(function TagView({ onSelectPhoto }: Props) {
  const [hierarchy, setHierarchy] = useState<LabelNode[]>([]);
  const [geoLabels, setGeoLabels] = useState<[string, number][]>([]);
  const [timeLabels, setTimeLabels] = useState<[string, number][]>([]);
  const [deviceLabels, setDeviceLabels] = useState<[string, number][]>([]);
  const [aiRunning, setAiRunning] = useState(false);
  const [workerHealthy, setWorkerHealthy] = useState(false);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [h, geo, time, device] = await Promise.all([
        api.getLabelHierarchy(),
        api.getLabelsByType("geo_location"),
        api.getLabelsByType("time_period"),
        api.getLabelsByType("device"),
      ]);
      setHierarchy(h);
      setGeoLabels(geo);
      setTimeLabels(time);
      setDeviceLabels(device);
    } catch (e) {
      console.error("Failed to load labels:", e);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleRunClassification = useCallback(async () => {
    const healthy = await api.workerHealth();
    setWorkerHealthy(healthy);
    if (!healthy) {
      await api.startAiWorker();
    }
    setAiRunning(true);
    try {
      await api.runAiClassification(50);
      await loadData();
    } catch (e) {
      console.error("Classification failed:", e);
    } finally {
      setAiRunning(false);
    }
  }, [loadData]);

  const handleSelectTag = useCallback((label: string) => {
    setSelectedTag(label === selectedTag ? null : label);
    // Navigate to filtered view
    if (label !== selectedTag) {
      window.location.href = `/?tag=${encodeURIComponent(label)}`;
    }
  }, [selectedTag]);

  const tagSections = [
    { key: "ai", icon: "🏷", title: "AI 场景", data: hierarchy, isHierarchical: true },
    { key: "geo", icon: "📍", title: "地点", data: geoLabels, isHierarchical: false },
    { key: "time", icon: "📅", title: "时间", data: timeLabels, isHierarchical: false },
    { key: "device", icon: "📷", title: "设备", data: deviceLabels, isHierarchical: false },
  ];

  return (
    <div className="flex h-full flex-col">
      <AiStatusIndicator />

      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <button
          onClick={handleRunClassification}
          disabled={aiRunning}
          className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          {aiRunning ? "分类中..." : "运行场景分类"}
        </button>
      </div>

      {/* Label Sections */}
      <div className="flex-1 overflow-auto p-4">
        {tagSections.map(section => (
          <div key={section.key} className="mb-6">
            <h3 className="mb-2 flex items-center gap-1 text-sm font-medium">
              <span>{section.icon}</span>
              {section.title}
              <span className="text-xs text-muted-foreground">
                ({Array.isArray(section.data) ? section.data.length : 0})
              </span>
            </h3>

            {section.isHierarchical ? (
              (section.data as LabelNode[]).map(node => (
                <LabelGroup
                  key={node.label}
                  node={node}
                  onSelectTag={handleSelectTag}
                />
              ))
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {(section.data as [string, number][]).map(([label, count]) => (
                  <button
                    key={label}
                    onClick={() => handleSelectTag(label)}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs transition-colors",
                      selectedTag === label
                        ? "bg-primary border-primary text-primary-foreground"
                        : "bg-card hover:bg-muted"
                    )}
                  >
                    {label} ({count})
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}

        {hierarchy.length === 0 && geoLabels.length === 0 && timeLabels.length === 0 && (
          <div className="py-12 text-center text-muted-foreground">
            还没有标签，请先运行场景分类或导入有 GPS 的照片
          </div>
        )}
      </div>
    </div>
  );
});
```

- [ ] **Step 3: Commit**

```bash
git add src/components/LabelGroup.tsx src/components/TagView.tsx
git commit -m "feat(tags): hierarchical TagView with collapsible label groups

- LabelGroup component with expand/collapse for parent categories
- Four sections: AI 场景 (hierarchical), 地点, 时间, 设备 (flat chips)
- Click tag to filter photo grid via URL query param
- Selected tag highlighted with primary color
- AI status indicator + run classification button preserved"
```

---

### Task 7: SmartAlbumView + Sidebar Integration

**Files:**
- Create: `src/components/SmartAlbumView.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create SmartAlbumView**

Create `src/components/SmartAlbumView.tsx`:

```tsx
import { useState, useCallback, useEffect } from "react";
import * as api from "../api/tauri";
import type { SmartAlbum } from "../types";

interface Props {
  onSelectPhoto: (id: number) => void;
}

export default React.memo(function SmartAlbumView({ onSelectPhoto }: Props) {
  const [albums, setAlbums] = useState<SmartAlbum[]>([]);
  const [selectedAlbum, setSelectedAlbum] = useState<SmartAlbum | null>(null);
  const [albumPhotos, setAlbumPhotos] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const loadAlbums = useCallback(async () => {
    try {
      const data = await api.getSmartAlbums();
      setAlbums(data);
    } catch (e) {
      console.error("Failed to load albums:", e);
    }
  }, []);

  useEffect(() => { loadAlbums(); }, [loadAlbums]);

  const handleSelectAlbum = useCallback(async (album: SmartAlbum) => {
    setSelectedAlbum(album);
    setLoading(true);
    try {
      const result = await api.getSmartAlbumPhotos(album.id, undefined, 100);
      // Fetch photo details for each photo_id
      const photoIds = result.map((r: [number, number]) => r[0]);
      // Load photos via the standard API
      const photos = await Promise.all(
        photoIds.slice(0, 50).map((id: number) =>
          api.getPhoto(id).catch(() => null)
        )
      );
      setAlbumPhotos(photos.filter(Boolean));
    } catch (e) {
      console.error("Failed to load album photos:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleRegenerate = useCallback(async () => {
    try {
      await api.regenerateSmartAlbums();
      await loadAlbums();
    } catch (e) {
      console.error("Failed to regenerate albums:", e);
    }
  }, [loadAlbums]);

  // Album detail view
  if (selectedAlbum) {
    return (
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <button
            onClick={() => { setSelectedAlbum(null); setAlbumPhotos([]); }}
            className="text-lg"
          >
            ←
          </button>
          <div className="flex-1">
            <h2 className="font-medium">{selectedAlbum.name}</h2>
            <span className="text-xs text-muted-foreground">
              {selectedAlbum.photo_count} 张照片
            </span>
          </div>
        </div>

        {/* Photos */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="grid grid-cols-4 gap-2">
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="aspect-square animate-pulse rounded-md bg-muted" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {albumPhotos.map(photo => (
                <div
                  key={photo.id}
                  className="aspect-square cursor-pointer overflow-hidden rounded-md bg-muted"
                  onClick={() => onSelectPhoto(photo.id)}
                >
                  <AlbumPhotoThumb photo={photo} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Album list view
  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="font-medium">相册</h2>
        <button
          onClick={handleRegenerate}
          className="rounded bg-secondary px-3 py-1 text-xs"
        >
          重新生成
        </button>
      </div>

      {/* Album Grid */}
      <div className="flex-1 overflow-auto p-4">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {albums.map(album => (
            <div
              key={album.id}
              className="cursor-pointer rounded-lg border bg-card p-3 transition-shadow hover:shadow-md"
              onClick={() => handleSelectAlbum(album)}
            >
              <div className="aspect-square overflow-hidden rounded-md bg-muted">
                <AlbumCoverThumb album={album} />
              </div>
              <div className="mt-2">
                <div className="truncate text-sm font-medium">{album.name}</div>
                <div className="text-xs text-muted-foreground">
                  {album.photo_count} 张照片
                </div>
              </div>
            </div>
          ))}
        </div>

        {albums.length === 0 && (
          <div className="py-12 text-center text-muted-foreground">
            还没有相册，请先运行 AI 分类或导入带 GPS 的照片
          </div>
        )}
      </div>
    </div>
  );
});

function AlbumPhotoThumb({ photo }: { photo: any }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    api.getThumbnailPath(photo.id, "small").then(path => {
      if (path) setUrl(`file://${path}`);
    }).catch(() => {});
  }, [photo.id]);

  return url ? (
    <img src={url} alt="" className="h-full w-full object-cover" />
  ) : (
    <div className="flex h-full w-full items-center justify-center" />
  );
}

function AlbumCoverThumb({ album }: { album: SmartAlbum }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (album.cover_photo_id) {
      api.getThumbnailPath(album.cover_photo_id, "small").then(path => {
        if (path) setUrl(`file://${path}`);
      }).catch(() => {});
    }
  }, [album.cover_photo_id]);

  return url ? (
    <img src={url} alt="" className="h-full w-full object-cover" />
  ) : (
    <div className="flex h-full w-full items-center justify-center text-2xl text-muted-foreground">
      📷
    </div>
  );
}
```

- [ ] **Step 2: Add "相册" to Sidebar**

In `src/components/Sidebar.tsx`, modify the `navItems` (line 10-15):

```tsx
const navItems: { key: ViewMode | "albums"; label: string; icon: string }[] = [
  { key: "grid", label: "所有照片", icon: "🖼" },
  { key: "map", label: "地图", icon: "🗺" },
  { key: "faces", label: "人物", icon: "👤" },
  { key: "tags", label: "标签", icon: "🏷" },
  { key: "albums", label: "相册", icon: "📚" },
];
```

Update the `viewMode` type to include "albums" in `src/types/index.ts`:

```typescript
export type ViewMode = "grid" | "map" | "faces" | "tags" | "albums";
```

In Sidebar's `onViewModeChange` handler, ensure "albums" is handled.

- [ ] **Step 3: Add AlbumsPage route in App.tsx**

In `src/App.tsx`, add a new page component and route:

```tsx
// Import
import SmartAlbumView from "./components/SmartAlbumView";

// Add AlbumsPage component (around line 177-184, after TagsPage)
function AlbumsPage() {
  const { photos, setFilter } = useStore();
  return (
    <SmartAlbumView
      onSelectPhoto={(id) => {
        setFilter({});
        // Open lightbox
      }}
    />
  );
}

// Add route in the Router section
<Route path="/albums" element={<AlbumsPage />} />
```

Also update the nav click handler in Sidebar to navigate to `/albums` when "albums" is selected.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/SmartAlbumView.tsx src/components/Sidebar.tsx src/App.tsx src/types/index.ts
git commit -m "feat(tags): SmartAlbumView with sidebar integration

- Album list grid with cover thumbnails and photo counts
- Album detail view with 4-column photo grid
- Regenerate button to rebuild all smart albums
- New sidebar nav entry: 相册
- Route: /albums"
```

---

### Task 8: Final Integration + Manual Testing

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Register all remaining commands**

Ensure `.invoke_handler()` in `lib.rs` includes:
```rust
cmd_run_geo_tagging,
cmd_run_time_tagging,
cmd_run_device_tagging,
cmd_get_label_hierarchy,
cmd_get_labels_by_type,
cmd_rebuild_label_hierarchy,
cmd_get_smart_albums,
cmd_get_smart_album_photos,
cmd_regenerate_smart_albums,
```

- [ ] **Step 2: Verify full compilation**

```bash
npx tsc --noEmit
cd src-tauri && cargo check
```

- [ ] **Step 3: Manual test checklist**

```bash
npm run tauri dev
```

Test:
- [ ] TagView shows hierarchical AI scene labels (expandable)
- [ ] TagView shows 地点/时间/设备 sections with flat chips
- [ ] Click a tag → photo grid filters correctly
- [ ] Run geo-tagging → location tags appear for GPS photos
- [ ] Run time-tagging → year/season tags appear
- [ ] Run device-tagging → camera model tags appear
- [ ] SmartAlbumView shows travel/monthly/themed/person albums
- [ ] Click album → photo grid loads
- [ ] Regenerate albums → albums rebuild with current data
- [ ] Auto-AI pipeline triggers all taggers after classification

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/main.rs
git commit -m "feat(tags): register all auto-tagging and smart album commands

- Register geo/time/device tagging commands
- Register label hierarchy and smart album commands
- Verify end-to-end: TagView hierarchy, SmartAlbumView, auto-tagging pipeline"
```
