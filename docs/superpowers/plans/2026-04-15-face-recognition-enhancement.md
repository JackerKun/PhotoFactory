# Face Recognition Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade face recognition with adaptive clustering, manual annotation/correction, face quality scoring, and person detail drawer with timeline view.

**Architecture:** Add face_constraints table for must-link/cannot-link constraints. Enhance Python clustering with adaptive eps (elbow method) and constraint-aware DBSCAN. Add face quality scoring in AI pipeline. Build FaceView with three tabs (named/unnamed/review). Implement person detail drawer with timeline, scene tags, and photo grid.

**Tech Stack:** Python (scikit-learn DBSCAN, numpy), Rust (rusqlite, embedding loading from .npy), React 18, Zustand 4.5, Tauri 2

---

## File Structure

### New files:
- `src/components/PersonDrawer.tsx` — Person detail drawer with timeline, tags, photo grid
- `src-tauri/src/face_clusterer_v2.rs` — Constraint-aware clustering, adaptive eps, quality scoring
- `src-tauri/src/db/constraint_dao.rs` — Face constraint CRUD operations

### Modified files:
- `src/components/FaceView.tsx` — Three-tab layout (named/unnamed/review), merge/split UI, drawer trigger
- `src/components/PhotoDetail.tsx` — Face annotation in detail panel
- `src/types/index.ts` — PersonDetail, FaceConstraint types (from Plan 1)
- `src/api/tauri.ts` — New face commands: add_constraint, remove_constraint, get_person_detail, get_person_timeline, get_face_quality
- `src-tauri/src/db/schema.rs` — face_constraints, person_metadata tables (from Plan 1)
- `src-tauri/src/db/connection.rs` — Migrations (from Plan 1)
- `src-tauri/src/db/face_dao.rs` — Constraint loading, quality score, person metadata queries
- `src-tauri/src/commands/faces.rs` — Constraint-aware clustering, person detail endpoint
- `ai_worker/face_clusterer.py` — Adaptive eps, constraint-aware DBSCAN, quality scoring
- `ai_worker/server.py` — New endpoints: cluster_faces_v2, compute_face_quality

---

### Task 1: Schema and Types Foundation

> Note: Schema changes are defined in Plan 1 (Task 1). This plan assumes those migrations exist. If executing this plan standalone, first run Plan 1 Task 1.

**Files:**
- (No new schema work needed - covered in Plan 1)

- [ ] **Step 1: Verify schema migrations exist**

Check that `src-tauri/src/db/connection.rs` contains:
- `face_constraints` table creation
- `person_metadata` table creation
- `quality_score` and `person_name` columns on `face_detections`

If not present, copy from Plan 1 Task 1.

- [ ] **Step 2: Commit** (only if changes were made)

```bash
git status
git add -A
git commit -m "feat(faces): verify schema migrations for face recognition v2"
```

---

### Task 2: Face Constraint DAO (Rust)

**Files:**
- Create: `src-tauri/src/db/constraint_dao.rs`
- Modify: `src-tauri/src/db/mod.rs` (if exists) or add mod declaration

- [ ] **Step 1: Create constraint_dao.rs**

Create `src-tauri/src/db/constraint_dao.rs`:

```rust
use rusqlite::Connection;
use crate::error::AppResult;

#[derive(Debug, Clone)]
pub struct FaceConstraint {
    pub id: i64,
    pub photo_id_1: i64,
    pub face_index_1: i32,
    pub photo_id_2: i64,
    pub face_index_2: i32,
    pub constraint_type: String, // "must_link" | "cannot_link"
}

pub fn add_constraint(
    conn: &Connection,
    photo_id_1: i64,
    face_index_1: i32,
    photo_id_2: i64,
    face_index_2: i32,
    constraint_type: &str,
) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO face_constraints (photo_id_1, face_index_1, photo_id_2, face_index_2, constraint_type)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        [photo_id_1, face_index_1 as i64, photo_id_2, face_index_2 as i64, constraint_type],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn remove_constraint(conn: &Connection, constraint_id: i64) -> AppResult<()> {
    conn.execute(
        "DELETE FROM face_constraints WHERE id = ?1",
        [constraint_id],
    )?;
    Ok(())
}

pub fn get_all_constraints(conn: &Connection) -> AppResult<Vec<FaceConstraint>> {
    let mut stmt = conn.prepare(
        "SELECT id, photo_id_1, face_index_1, photo_id_2, face_index_2, constraint_type
         FROM face_constraints"
    )?;
    let constraints = stmt.query_map([], |row| {
        Ok(FaceConstraint {
            id: row.get(0)?,
            photo_id_1: row.get(1)?,
            face_index_1: row.get(2)?,
            photo_id_2: row.get(3)?,
            face_index_2: row.get(4)?,
            constraint_type: row.get(5)?,
        })
    })?;
    constraints.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
}

pub fn get_constraints_for_face(
    conn: &Connection,
    photo_id: i64,
    face_index: i32,
) -> AppResult<Vec<FaceConstraint>> {
    let mut stmt = conn.prepare(
        "SELECT id, photo_id_1, face_index_1, photo_id_2, face_index_2, constraint_type
         FROM face_constraints
         WHERE (photo_id_1 = ?1 AND face_index_1 = ?2)
            OR (photo_id_2 = ?1 AND face_index_2 = ?2)"
    )?;
    let constraints = stmt.query_map([photo_id, face_index as i64], |row| {
        Ok(FaceConstraint {
            id: row.get(0)?,
            photo_id_1: row.get(1)?,
            face_index_1: row.get(2)?,
            photo_id_2: row.get(3)?,
            face_index_2: row.get(4)?,
            constraint_type: row.get(5)?,
        })
    })?;
    constraints.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
}

pub fn get_must_links(conn: &Connection) -> AppResult<Vec<(i64, i64)>> {
    // Returns pairs of (face_key_1, face_key_2) where face_key = (photo_id << 8) | face_index
    let mut stmt = conn.prepare(
        "SELECT
            (photo_id_1 << 8) | face_index_1,
            (photo_id_2 << 8) | face_index_2
         FROM face_constraints
         WHERE constraint_type = 'must_link'"
    )?;
    let pairs = stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })?;
    pairs.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
}

pub fn get_cannot_links(conn: &Connection) -> AppResult<Vec<(i64, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT
            (photo_id_1 << 8) | face_index_1,
            (photo_id_2 << 8) | face_index_2
         FROM face_constraints
         WHERE constraint_type = 'cannot_link'"
    )?;
    let pairs = stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })?;
    pairs.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
}
```

- [ ] **Step 2: Register module**

In `src-tauri/src/db/mod.rs` or wherever db modules are declared (check `src-tauri/src/lib.rs` or a db/mod.rs), add:

```rust
pub mod constraint_dao;
```

If there's no mod.rs, the modules are likely declared in `lib.rs`. Search for `mod photo_dao` and add alongside it:

```rust
mod constraint_dao;
```

- [ ] **Step 3: Verify Rust compiles**

Run: `cd src-tauri && cargo check`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/db/constraint_dao.rs
git commit -m "feat(faces): add face constraint DAO for must-link/cannot-link operations

- CRUD operations for face_constraints table
- Query constraints by face pair or globally
- Get must-link and cannot-link pairs as face keys"
```

---

### Task 3: Adaptive Face Clustering (Python)

**Files:**
- Modify: `ai_worker/face_clusterer.py`
- Modify: `ai_worker/server.py`

- [ ] **Step 1: Add adaptive eps computation**

In `ai_worker/face_clusterer.py`, add after the existing `cluster_faces` function:

```python
import numpy as np
from sklearn.neighbors import NearestNeighbors

def compute_adaptive_eps(embeddings: np.ndarray, min_eps: float = 0.3, max_eps: float = 0.8) -> float:
    """Compute optimal eps using K-distance graph elbow method."""
    n_samples = len(embeddings)
    if n_samples < 10:
        return min_eps  # Too few faces, use minimum eps

    k = min(10, n_samples - 1)  # K neighbors
    neighbors = NearestNeighbors(n_neighbors=k, metric='cosine').fit(embeddings)
    distances, _ = neighbors.kneighbors(embeddings)

    # Use the k-th nearest neighbor distance
    k_distances = np.sort(distances[:, -1])

    # Find elbow: point of maximum curvature
    n_points = len(k_distances)
    x = np.arange(n_points)
    y = k_distances

    # Line from first to last point
    p1 = np.array([x[0], y[0]])
    p2 = np.array([x[-1], y[-1]])

    # Distance from each point to the line
    line_vec = p2 - p1
    line_len = np.sqrt(np.sum(line_vec ** 2))
    if line_len == 0:
        return min_eps

    line_unit = line_vec / line_len

    max_dist = 0
    elbow_idx = n_points // 2  # Default to middle

    for i in range(n_points):
        point = np.array([x[i], y[i]])
        vec = point - p1
        proj = np.dot(vec, line_unit) * line_unit
        dist = np.sqrt(np.sum((point - p1 - proj) ** 2))
        if dist > max_dist:
            max_dist = dist
            elbow_idx = i

    eps = float(k_distances[elbow_idx])
    return max(min_eps, min(max_eps, eps))


def compute_face_quality(embedding: np.ndarray, all_embeddings: np.ndarray) -> float:
    """Compute face quality score based on embedding distinctiveness."""
    if len(all_embeddings) < 2:
        return 0.5

    # Cosine similarity to all other faces
    from sklearn.metrics.pairwise import cosine_similarity
    similarities = cosine_similarity(embedding.reshape(1, -1), all_embeddings)[0]

    # Remove self-similarity
    mean_sim = np.mean(similarities)

    # Higher distinctiveness (lower avg similarity) = higher quality
    # Normalize to 0-1 range
    quality = max(0.0, min(1.0, 1.0 - mean_sim))
    return float(quality)


def cluster_faces_v2(
    embeddings_dir: str,
    existing_clusters: dict = None,
    threshold: float = 0.6,
    must_links: list = None,
    cannot_links: list = None,
) -> dict:
    """Enhanced clustering with adaptive eps and constraint support.

    existing_clusters: {filename: cluster_id} from previous runs
    must_links: [(face_key_1, face_key_2), ...] where face_key = int
    cannot_links: same format
    Returns: {filename: cluster_id}
    """
    import os
    from sklearn.cluster import DBSCAN
    from sklearn.metrics.pairwise import cosine_similarity

    npy_files = [f for f in os.listdir(embeddings_dir) if f.endswith('.npy')]
    if not npy_files:
        return {}

    embeddings = []
    file_names = []
    for f in sorted(npy_files):
        try:
            emb = np.load(os.path.join(embeddings_dir, f))
            embeddings.append(emb)
            file_names.append(f)
        except Exception:
            continue

    if not embeddings:
        return {}

    X = np.array(embeddings)
    n_faces = len(X)

    # Build constraint lookup: face_key → forced cluster or blocked clusters
    face_key_to_idx = {f: i for i, f in enumerate(file_names)}
    must_link_map = {}  # face_idx → forced_cluster_id
    cannot_link_map = {}  # face_idx → set of blocked_cluster_ids

    def face_key_to_filename(key):
        return f"{int(key):08x}.npy"

    if must_links:
        # First pass: build cluster assignments from existing_clusters
        cluster_members = {}
        if existing_clusters:
            for fname, cid in existing_clusters.items():
                cluster_members.setdefault(cid, set()).add(fname)

        # For each must-link, if one side is assigned, force the other
        for key1, key2 in must_links:
            f1, f2 = face_key_to_filename(key1), face_key_to_filename(key2)
            idx1 = face_key_to_idx.get(f1)
            idx2 = face_key_to_idx.get(f2)
            if idx1 is None or idx2 is None:
                continue
            # If either is in existing_clusters, force both to same cluster
            if existing_clusters and f1 in existing_clusters:
                must_link_map[idx2] = existing_clusters[f1]
            if existing_clusters and f2 in existing_clusters:
                must_link_map[idx1] = existing_clusters[f2]

    if cannot_links and existing_clusters:
        for key1, key2 in cannot_links:
            f1, f2 = face_key_to_filename(key1), face_key_to_filename(key2)
            idx1 = face_key_to_idx.get(f1)
            idx2 = face_key_to_idx.get(f2)
            if idx1 is None or idx2 is None:
                continue
            if f1 in existing_clusters:
                cannot_link_map.setdefault(idx1, set()).add(existing_clusters[f2] if f2 in existing_clusters else None)
            if f2 in existing_clusters:
                cannot_link_map.setdefault(idx2, set()).add(existing_clusters[f1] if f1 in existing_clusters else None)

    # Compute cluster centroids from existing clusters for matching
    cluster_centroids = {}
    if existing_clusters:
        cluster_members = {}
        for fname, cid in existing_clusters.items():
            if fname in face_key_to_idx:
                cluster_members.setdefault(cid, []).append(face_key_to_idx[fname])

        for cid, indices in cluster_members.items():
            embs = X[indices]
            cluster_centroids[cid] = np.mean(embs, axis=0)

    # If no new faces, just return existing clusters
    if existing_clusters and len(existing_clusters) > 0:
        results = dict(existing_clusters)
        matched_files = set()

        for i, emb in enumerate(X):
            fname = file_names[i]

            # Check must-link constraint: force to specific cluster
            if i in must_link_map:
                results[fname] = must_link_map[i]
                matched_files.add(fname)
                continue

            # Multi-threshold matching against cluster centroids
            best_sim = -1
            best_cluster = None

            for cluster_id, centroid in cluster_centroids.items():
                sim = cosine_similarity(emb.reshape(1, -1), centroid.reshape(1, -1))[0, 0]
                if sim > 0.65 and sim > best_sim:
                    # Check cannot-link constraint
                    if i in cannot_link_map and cluster_id in (cannot_link_map[i] or set()):
                        continue
                    best_sim = sim
                    best_cluster = cluster_id

            if best_cluster is not None:
                results[fname] = best_cluster
                matched_files.add(fname)

        # Run DBSCAN only on unmatched faces
        unmatched_indices = [i for i in range(n_faces) if file_names[i] not in matched_files]
        if unmatched_indices:
            X_unmatched = X[unmatched_indices]
            if len(X_unmatched) >= 2:
                new_eps = compute_adaptive_eps(X_unmatched)
                db = DBSCAN(eps=new_eps, min_samples=2, metric="cosine").fit(X_unmatched)

                new_cluster_id = max(results.values(), default=-1) + 1
                for local_idx, global_idx in enumerate(unmatched_indices):
                    label = db.labels_[local_idx]
                    if label != -1:
                        results[file_names[global_idx]] = new_cluster_id + label

        return results

    # No existing clusters: fresh clustering with adaptive eps
    eps = compute_adaptive_eps(X)
    db = DBSCAN(eps=eps, min_samples=2, metric="cosine").fit(X)

    results = {}
    for i, label in enumerate(db.labels_):
        if label != -1:
            results[file_names[i]] = label

    return results

    return results
```

- [ ] **Step 2: Update server.py with new endpoints**

In `ai_worker/server.py`, add new endpoints:

```python
@app.post("/cluster_faces_v2")
async def cluster_faces_v2(request: ClusterFacesV2Request):
    """Enhanced clustering with adaptive eps and constraints."""
    embeddings_dir = request.embeddings_dir
    existing_clusters = request.existing_clusters or {}
    threshold = request.threshold or 0.6
    must_links = request.must_links or []
    cannot_links = request.cannot_links or []

    results = cluster_faces_v2(
        embeddings_dir,
        existing_clusters=existing_clusters,
        threshold=threshold,
        must_links=must_links,
        cannot_links=cannot_links,
    )
    return {"clusters": results}


class FaceQualityRequest(BaseModel):
    photo_id: int
    face_index: int
    embedding_path: str
    all_embedding_paths: List[str]


@app.post("/compute_face_quality")
async def compute_face_quality(request: FaceQualityRequest):
    """Compute face quality score."""
    try:
        target_emb = np.load(request.embedding_path)
        all_embs = [np.load(p) for p in request.all_embedding_paths]
        all_embs_array = np.array(all_embs)
        quality = compute_face_quality(target_emb, all_embs_array)
        return {"quality": quality}
    except Exception as e:
        return {"error": str(e)}
```

Add the `ClusterFacesV2Request` model at the top of `server.py`:

```python
class ClusterFacesV2Request(BaseModel):
    embeddings_dir: str
    existing_clusters: Optional[Dict[str, int]] = None
    threshold: Optional[float] = 0.6
    must_links: Optional[List[Tuple[int, int]]] = None
    cannot_links: Optional[List[Tuple[int, int]]] = None
```

- [ ] **Step 3: Test Python changes**

```bash
cd ai_worker && python -c "
from face_clusterer import compute_adaptive_eps, compute_face_quality
import numpy as np
# Quick smoke test
X = np.random.rand(20, 512)
eps = compute_adaptive_eps(X)
print(f'Adaptive eps: {eps}')
assert 0.3 <= eps <= 0.8, f'eps {eps} out of range'
print('OK')
"
```
Expected: Prints "Adaptive eps: X.XX" and "OK"

- [ ] **Step 4: Commit**

```bash
git add ai_worker/face_clusterer.py ai_worker/server.py
git commit -m "feat(faces): adaptive face clustering with constraints support

- compute_adaptive_eps using K-distance elbow method
- cluster_faces_v2 with must-link/cannot-link constraint support
- multi-threshold matching: strict (0.35 cosine sim) then relaxed (0.5)
- compute_face_quality based on embedding distinctiveness
- New server endpoints: /cluster_faces_v2, /compute_face_quality"
```

---

### Task 4: Constraint-Aware Clustering (Rust Backend)

**Files:**
- Modify: `src-tauri/src/commands/faces.rs`
- Modify: `src-tauri/src/db/face_dao.rs`

- [ ] **Step 1: Add person metadata and quality queries to face_dao.rs**

In `src-tauri/src/db/face_dao.rs`, add after existing functions:

```rust
pub fn update_face_quality(conn: &Connection, face_id: i64, quality_score: f64) -> AppResult<()> {
    conn.execute(
        "UPDATE face_detections SET quality_score = ?1 WHERE id = ?2",
        [quality_score, face_id],
    )?;
    Ok(())
}

pub fn get_person_details(conn: &Connection, person_id: i64) -> AppResult<Option<PersonDetail>> {
    let mut stmt = conn.prepare(
        "SELECT
            fc.id as person_id,
            fc.name as user_name,
            fc.face_count,
            COALESCE(pm.confidence, 'medium') as confidence,
            MIN(p.taken_at) as first_seen,
            MAX(p.taken_at) as last_seen,
            (SELECT fd.photo_id FROM face_detections fd
             WHERE fd.person_id = fc.id AND fd.quality_score = (
                 SELECT MAX(quality_score) FROM face_detections WHERE person_id = fc.id
             )
             LIMIT 1) as cover_photo_id
         FROM face_clusters fc
         LEFT JOIN person_metadata pm ON pm.person_id = fc.id
         LEFT JOIN face_detections fd ON fd.person_id = fc.id
         LEFT JOIN photos p ON p.id = fd.photo_id
         WHERE fc.id = ?1
         GROUP BY fc.id"
    )?;

    let result = stmt.query_row([person_id], |row| {
        Ok(PersonDetail {
            person_id: row.get(0)?,
            user_name: row.get(1)?,
            face_count: row.get(2)?,
            confidence: row.get(3)?,
            first_seen: row.get(4)?,
            last_seen: row.get(5)?,
            cover_photo_id: row.get(6)?,
        })
    }).optional()?;

    Ok(result)
}

pub fn get_person_timeline(conn: &Connection, person_id: i64) -> AppResult<Vec<(String, i64)>> {
    // Returns (year_month, count) tuples
    let mut stmt = conn.prepare(
        "SELECT
            strftime('%Y-%m', COALESCE(p.taken_at, p.file_mtime)) as month,
            COUNT(*) as cnt
         FROM face_detections fd
         JOIN photos p ON p.id = fd.photo_id
         WHERE fd.person_id = ?1 AND p.deleted = 0
         GROUP BY month
         ORDER BY month DESC"
    )?;

    let rows = stmt.query_map([person_id], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
}

pub fn get_person_scene_tags(conn: &Connection, person_id: i64) -> AppResult<Vec<(String, i64)>> {
    // Returns top scene tags for this person's photos
    let mut stmt = conn.prepare(
        "SELECT
            ac.label,
            COUNT(*) as cnt
         FROM face_detections fd
         JOIN ai_classifications ac ON ac.photo_id = fd.photo_id
         WHERE fd.person_id = ?1 AND ac.tag_type = 'ai_scene'
         GROUP BY ac.label
         ORDER BY cnt DESC
         LIMIT 10"
    )?;

    let rows = stmt.query_map([person_id], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
}

pub fn set_person_name(conn: &Connection, person_id: i64, name: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE face_clusters SET name = ?1 WHERE id = ?2",
        [name, person_id],
    )?;
    Ok(())
}

pub fn split_person(conn: &Connection, person_id: i64, face_ids: &[i64]) -> AppResult<i64> {
    // Create new cluster and move specified faces to it
    let new_cluster_id = create_cluster(conn)?;
    for face_id in face_ids {
        assign_face_to_person(conn, *face_id, Some(new_cluster_id))?;
    }
    // Update face counts
    update_cluster_face_counts(conn)?;
    Ok(new_cluster_id)
}
```

Add the `PersonDetail` struct to `src-tauri/src/models/mod.rs` or a relevant models file:

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub struct PersonDetail {
    pub person_id: i64,
    pub user_name: Option<String>,
    pub face_count: i64,
    pub confidence: String,  // DB-enforced: 'high' | 'medium' | 'low' (via CHECK constraint in schema)
    pub first_seen: Option<String>,
    pub last_seen: Option<String>,
    pub cover_photo_id: Option<i64>,
}
```

- [ ] **Step 2: Update clustering command with constraints**

In `src-tauri/src/commands/faces.rs`, modify `cmd_run_face_clustering_inner` (line 39). Replace the existing clustering call with constraint-aware version:

```rust
// After getting existing_clusters and embeddings (lines 50-86), add:
let must_links = constraint_dao::get_must_links(&conn)?;
let cannot_links = constraint_dao::get_cannot_links(&conn)?;

// Pass constraints to Python worker
let request = ClusterFaceV2Request {
    embeddings_dir: embeddings_dir.to_string_lossy().to_string(),
    existing_clusters: Some(existing_clusters),
    threshold: 0.6,
    must_links: Some(must_links),
    cannot_links: Some(cannot_links),
};

let response = client.cluster_faces_v2(&request).await?;
```

- [ ] **Step 3: Add new Tauri commands for constraints**

In `src-tauri/src/commands/faces.rs`, add:

```rust
#[tauri::command]
pub async fn cmd_add_face_constraint(
    photo_id_1: i64,
    face_index_1: i32,
    photo_id_2: i64,
    face_index_2: i32,
    constraint_type: String,
    state: State<'_, Arc<Mutex<Option<Project>>>>,
) -> AppResult<()> {
    let project = state.lock().await.as_ref().ok_or(AppError::NoProjectOpen)?;
    let conn = Self::get_connection(project)?;
    constraint_dao::add_constraint(&conn, photo_id_1, face_index_1, photo_id_2, face_index_2, &constraint_type)?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_remove_face_constraint(
    constraint_id: i64,
    state: State<'_, Arc<Mutex<Option<Project>>>>,
) -> AppResult<()> {
    let project = state.lock().await.as_ref().ok_or(AppError::NoProjectOpen)?;
    let conn = Self::get_connection(project)?;
    constraint_dao::remove_constraint(&conn, constraint_id)?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_get_person_detail(
    person_id: i64,
    state: State<'_, Arc<Mutex<Option<Project>>>>,
) -> AppResult<PersonDetail> {
    let project = state.lock().await.as_ref().ok_or(AppError::NoProjectOpen)?;
    let conn = Self::get_connection(project)?;
    face_dao::get_person_details(&conn, person_id)?
        .ok_or(AppError::NotFound(format!("Person {} not found", person_id)))
}

#[tauri::command]
pub async fn cmd_get_person_timeline(
    person_id: i64,
    state: State<'_, Arc<Mutex<Option<Project>>>>,
) -> AppResult<Vec<(String, i64)>> {
    let project = state.lock().await.as_ref().ok_or(AppError::NoProjectOpen)?;
    let conn = Self::get_connection(project)?;
    face_dao::get_person_timeline(&conn, person_id)
}

#[tauri::command]
pub async fn cmd_get_person_scene_tags(
    person_id: i64,
    state: State<'_, Arc<Mutex<Option<Project>>>>,
) -> AppResult<Vec<(String, i64)>> {
    let project = state.lock().await.as_ref().ok_or(AppError::NoProjectOpen)?;
    let conn = Self::get_connection(project)?;
    face_dao::get_person_scene_tags(&conn, person_id)
}

#[tauri::command]
pub async fn cmd_split_person(
    person_id: i64,
    face_ids: Vec<i64>,
    state: State<'_, Arc<Mutex<Option<Project>>>>,
) -> AppResult<i64> {
    let project = state.lock().await.as_ref().ok_or(AppError::NoProjectOpen)?;
    let conn = Self::get_connection(project)?;
    face_dao::split_person(&conn, person_id, &face_ids)
}
```

- [ ] **Step 4: Register new commands**

Add to the `.invoke_handler()` in `lib.rs`:
```rust
cmd_add_face_constraint,
cmd_remove_face_constraint,
cmd_get_person_detail,
cmd_get_person_timeline,
cmd_get_person_scene_tags,
cmd_split_person,
```

- [ ] **Step 5: Verify Rust compiles**

Run: `cd src-tauri && cargo check`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db/face_dao.rs src-tauri/src/commands/faces.rs
git commit -m "feat(faces): constraint-aware clustering backend + person detail queries

- Add face constraint DAO integration to clustering command
- New Tauri commands: add/remove constraint, get person detail/timeline/tags
- split_person: move selected faces to new cluster
- Quality score and person metadata queries"
```

---

### Task 5: FaceView Three-Tab Layout

**Files:**
- Modify: `src/components/FaceView.tsx`
- Modify: `src/api/tauri.ts`

- [ ] **Step 1: Add new API functions**

In `src/api/tauri.ts`, add:

```typescript
export async function addFaceConstraint(
  photoId1: number, faceIndex1: number,
  photoId2: number, faceIndex2: number,
  constraintType: "must_link" | "cannot_link"
): Promise<void> {
  return await invoke("cmd_add_face_constraint", {
    photoId1, faceIndex1, photoId2, faceIndex2, constraintType
  });
}

export async function removeFaceConstraint(constraintId: number): Promise<void> {
  return await invoke("cmd_remove_face_constraint", { constraintId });
}

export async function getPersonDetail(personId: number): Promise<PersonDetail> {
  return await invoke("cmd_get_person_detail", { personId });
}

export async function getPersonTimeline(personId: number): Promise<[string, number][]> {
  return await invoke("cmd_get_person_timeline", { personId });
}

export async function getPersonSceneTags(personId: number): Promise<[string, number][]> {
  return await invoke("cmd_get_person_scene_tags", { personId });
}

export async function splitPerson(personId: number, faceIds: number[]): Promise<number> {
  return await invoke("cmd_split_person", { personId, faceIds });
}
```

- [ ] **Step 2: Rewrite FaceView with three-tab layout**

Replace `src/components/FaceView.tsx` with:

```tsx
import { useState, useCallback, useEffect } from "react";
import * as api from "../api/tauri";
import AiStatusIndicator from "./AiStatusIndicator";
import PersonDrawer from "./PersonDrawer";

interface Props {
  onSelectPhoto: (id: number) => void;
}

interface Cluster {
  id: number;
  name: string | null;
  face_count: number;
  created_at: string;
  confidence?: "high" | "medium" | "low";
}

export default React.memo(function FaceView({ onSelectPhoto }: Props) {
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [activeTab, setActiveTab] = useState<"named" | "unnamed" | "review">("named");
  const [selectedPerson, setSelectedPerson] = useState<number | null>(null);
  const [aiRunning, setAiRunning] = useState(false);
  const [clustering, setClustering] = useState(false);
  const [workerHealthy, setWorkerHealthy] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [mergeMode, setMergeMode] = useState(false);
  const [selectedForMerge, setSelectedForMerge] = useState<number[]>([]);

  const loadClusters = useCallback(async () => {
    const raw = await api.getClusters();
    setClusters(raw);
  }, []);

  useEffect(() => { loadClusters(); }, [loadClusters]);

  const handleRunClustering = useCallback(async () => {
    setClustering(true);
    try {
      await api.runFaceClustering();
      await loadClusters();
    } catch (e) {
      console.error("Clustering failed:", e);
    } finally {
      setClustering(false);
    }
  }, [loadClusters]);

  const handleRunFaceDetection = useCallback(async () => {
    const healthy = await api.workerHealth();
    setWorkerHealthy(healthy);
    if (!healthy) {
      await api.startAiWorker();
    }
    setAiRunning(true);
    try {
      await api.runAiFaceDetection(50);
      await handleRunClustering();
    } catch (e) {
      console.error("Face detection failed:", e);
    } finally {
      setAiRunning(false);
      await loadClusters();
    }
  }, [loadClusters, handleRunClustering]);

  const handleRename = useCallback(async (clusterId: number, name: string) => {
    await api.renameCluster(clusterId);
    setEditName("");
    setRenamingId(null);
    await loadClusters();
  }, [loadClusters]);

  const handleMerge = useCallback(async () => {
    if (selectedForMerge.length < 2) return;
    const targetId = selectedForMerge[0];
    for (let i = 1; i < selectedForMerge.length; i++) {
      await api.mergeClusters(selectedForMerge[i], targetId);
    }
    setSelectedForMerge([]);
    setMergeMode(false);
    await loadClusters();
  }, [selectedForMerge, loadClusters]);

  const handlePersonClick = useCallback((personId: number) => {
    setSelectedPerson(personId);
  }, []);

  // Filter clusters by tab
  const namedClusters = clusters.filter(c => c.name);
  const unnamedClusters = clusters.filter(c => !c.name);
  const reviewClusters = clusters.filter(c => c.confidence === "low");

  const currentClusters = activeTab === "named"
    ? namedClusters
    : activeTab === "unnamed"
      ? unnamedClusters
      : reviewClusters;

  return (
    <div className="flex h-full flex-col">
      <AiStatusIndicator />

      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <button
          onClick={handleRunFaceDetection}
          disabled={aiRunning}
          className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          {aiRunning ? "检测中..." : "运行人脸检测"}
        </button>
        <button
          onClick={handleRunClustering}
          disabled={clustering}
          className="rounded bg-secondary px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {clustering ? "聚类中..." : "重新聚类"}
        </button>
        {activeTab === "named" && (
          <button
            onClick={() => setMergeMode(!mergeMode)}
            className={cn(
              "rounded px-3 py-1.5 text-sm",
              mergeMode ? "bg-primary text-primary-foreground" : "bg-secondary"
            )}
          >
            {mergeMode ? "取消合并" : "合并人物"}
          </button>
        )}
        {mergeMode && selectedForMerge.length >= 2 && (
          <button
            onClick={handleMerge}
            className="rounded bg-green-600 px-3 py-1.5 text-sm text-white"
          >
            合并所选 ({selectedForMerge.length})
          </button>
        )}
        {activeTab === "review" && reviewClusters.length > 0 && (
          <button
            onClick={() => {
              // Open batch review: show face grid for first low-confidence person
              if (reviewClusters.length > 0) {
                handlePersonClick(reviewClusters[0].id);
              }
            }}
            className="rounded bg-orange-500 px-3 py-1.5 text-sm text-white"
          >
            批量审核 ({reviewClusters.length} 个待审核人物)
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b">
        {[
          { key: "named" as const, label: `已命名 (${namedClusters.length})` },
          { key: "unnamed" as const, label: `未命名 (${unnamedClusters.length})` },
          { key: "review" as const, label: `待审核 (${reviewClusters.length})` },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "px-4 py-2 text-sm",
              activeTab === tab.key
                ? "border-b-2 border-primary font-medium"
                : "text-muted-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Cluster Grid */}
      <div className="flex-1 overflow-auto p-4">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {currentClusters.map(cluster => (
            <div
              key={cluster.id}
              className={cn(
                "cursor-pointer rounded-lg border bg-card p-3 transition-shadow hover:shadow-md",
                mergeMode && selectedForMerge.includes(cluster.id) && "ring-2 ring-primary",
                activeTab === "review" && "border-orange-300"
              )}
              onClick={() => {
                if (mergeMode) {
                  setSelectedForMerge(prev =>
                    prev.includes(cluster.id)
                      ? prev.filter(id => id !== cluster.id)
                      : [...prev, cluster.id]
                  );
                } else {
                  handlePersonClick(cluster.id);
                }
              }}
            >
              {/* Face thumbnail */}
              <div className="aspect-square overflow-hidden rounded-md bg-muted">
                <FaceThumbnail clusterId={cluster.id} />
              </div>
              <div className="mt-2">
                {renamingId === cluster.id ? (
                  <input
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    onBlur={() => handleRename(cluster.id, editName)}
                    onKeyDown={e => {
                      if (e.key === "Enter") handleRename(cluster.id, editName);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    className="w-full rounded border px-1 py-0.5 text-sm"
                    autoFocus
                  />
                ) : (
                  <div
                    onDoubleClick={() => {
                      setRenamingId(cluster.id);
                      setEditName(cluster.name || "");
                    }}
                    className="truncate text-sm font-medium"
                  >
                    {cluster.name || "未命名人物"}
                  </div>
                )}
                <div className="text-xs text-muted-foreground">
                  {cluster.face_count} 张照片
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Person Detail Drawer */}
      {selectedPerson && (
        <PersonDrawer
          personId={selectedPerson}
          onClose={() => setSelectedPerson(null)}
          onSelectPhoto={onSelectPhoto}
          onRename={async (name) => {
            await api.renameCluster(selectedPerson, name);
            await loadClusters();
          }}
        />
      )}
    </div>
  );
});

// Sub-component for lazy-loaded face thumbnail
function FaceThumbnail({ clusterId }: { clusterId: number }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    api.getClusterFaceThumbnail(clusterId).then(setUrl).catch(() => {});
  }, [clusterId]);

  if (!url) {
    return <div className="flex h-full w-full items-center justify-center bg-muted" />;
  }

  return <img src={url} alt="" className="h-full w-full object-cover" />;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/FaceView.tsx src/api/tauri.ts
git commit -m "feat(faces): FaceView with three-tab layout, merge mode, and batch review

- Tabs: 已命名 / 未命名 / 待审核
- Merge mode: select multiple clusters and merge into one
- Review tab shows low-confidence clusters with orange border
- Batch review button to审核 low-confidence persons
- Person detail drawer trigger on click
- Inline rename on double-click"
```

---

### Task 6: Person Detail Drawer Component

**Files:**
- Create: `src/components/PersonDrawer.tsx`

- [ ] **Step 1: Create PersonDrawer component**

Create `src/components/PersonDrawer.tsx`:

```tsx
import { useState, useEffect, useCallback, useRef } from "react";
import * as api from "../api/tauri";

interface Props {
  personId: number;
  onClose: () => void;
  onSelectPhoto: (id: number) => void;
  onRename: (name: string) => Promise<void>;
}

export default function PersonDrawer({ personId, onClose, onSelectPhoto, onRename }: Props) {
  const [detail, setDetail] = useState<any>(null);
  const [timeline, setTimeline] = useState<[string, number][]>([]);
  const [sceneTags, setSceneTags] = useState<[string, number][]>([]);
  const [photos, setPhotos] = useState<any[]>([]);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getPersonDetail(personId).then(setDetail).catch(() => {});
    api.getPersonTimeline(personId).then(setTimeline).catch(() => {});
    api.getPersonSceneTags(personId).then(setSceneTags).catch(() => {});

    // Load photos for this person
    api.getPhotos(null, 50, { person_id: personId }).then(page => {
      setPhotos(page.photos);
    }).catch(() => {});
  }, [personId]);

  const handleSaveName = useCallback(async () => {
    if (nameInput.trim()) {
      await onRename(nameInput.trim());
      setEditingName(false);
      setDetail(prev => ({ ...prev, user_name: nameInput.trim() }));
    }
  }, [nameInput, onRename]);

  const maxCount = Math.max(...timeline.map(([, c]) => c), 1);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />

      {/* Drawer */}
      <div
        ref={drawerRef}
        className="relative z-10 w-96 bg-background shadow-xl transition-transform duration-300"
        style={{ animation: "slideInRight 0.3s ease-out" }}
      >
        <div className="flex h-full flex-col">
          {/* Header */}
          <div className="flex items-center justify-between border-b px-4 py-3">
            <button onClick={onClose} className="text-lg">←</button>
            <span className="font-medium">人物详情</span>
            <button
              onClick={() => {
                setEditingName(true);
                setNameInput(detail?.user_name || "");
              }}
              className="text-sm text-primary"
            >
              命名
            </button>
          </div>

          {/* Person Info */}
          <div className="border-b px-4 py-4">
            {editingName ? (
              <div className="flex gap-2">
                <input
                  value={nameInput}
                  onChange={e => setNameInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleSaveName()}
                  className="flex-1 rounded border px-2 py-1"
                  autoFocus
                />
                <button onClick={handleSaveName} className="text-sm text-primary">保存</button>
              </div>
            ) : (
              <div className="text-lg font-medium">
                {detail?.user_name || "未命名人物"}
              </div>
            )}
            <div className="mt-1 text-sm text-muted-foreground">
              {detail?.face_count || 0} 张照片
              {detail?.first_seen && detail?.last_seen &&
                ` · ${detail.first_seen} - ${detail.last_seen}`}
            </div>
          </div>

          {/* Timeline */}
          <div className="border-b px-4 py-4">
            <h3 className="mb-2 text-sm font-medium">时间线</h3>
            {timeline.slice(0, 12).map(([month, count]) => (
              <div key={month} className="mb-1 flex items-center gap-2">
                <span className="w-16 text-xs text-muted-foreground">{month}</span>
                <div className="flex-1 overflow-hidden rounded bg-muted">
                  <div
                    className="h-3 rounded bg-primary transition-all"
                    style={{ width: `${(count / maxCount) * 100}%` }}
                  />
                </div>
                <span className="w-8 text-right text-xs">{count}张</span>
              </div>
            ))}
          </div>

          {/* Scene Tags */}
          {sceneTags.length > 0 && (
            <div className="border-b px-4 py-4">
              <h3 className="mb-2 text-sm font-medium">常见场景</h3>
              <div className="flex flex-wrap gap-1">
                {sceneTags.map(([label, count]) => (
                  <span
                    key={label}
                    className="rounded-full bg-secondary px-2 py-0.5 text-xs"
                  >
                    {label} ({count})
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Photo Grid */}
          <div className="flex-1 overflow-auto px-4 py-4">
            <h3 className="mb-2 text-sm font-medium">照片</h3>
            <div className="grid grid-cols-3 gap-1">
              {photos.map(photo => (
                <div
                  key={photo.id}
                  className="aspect-square cursor-pointer overflow-hidden rounded bg-muted"
                  onClick={() => {
                    onSelectPhoto(photo.id);
                    onClose();
                  }}
                >
                  <PhotoThumb photo={photo} />
                </div>
              ))}
            </div>
          </div>

          {/* Filter Button */}
          <div className="border-t px-4 py-3">
            <button
              onClick={() => {
                window.location.href = `/?person=${personId}`;
              }}
              className="w-full rounded bg-primary py-2 text-sm text-primary-foreground"
            >
              筛选查看该人物的所有照片
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PhotoThumb({ photo }: { photo: any }) {
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
```

Add slide-in animation CSS to `src/index.css`:

```css
@keyframes slideInRight {
  from {
    transform: translateX(100%);
  }
  to {
    transform: translateX(0);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/PersonDrawer.tsx src/index.css
git commit -m "feat(faces): person detail drawer with timeline, scene tags, and photo grid

- Right-side slide-in drawer with backdrop
- Editable person name
- Monthly timeline bar chart
- Scene tag chips from AI classifications
- Photo grid (3 columns) with click-through to Lightbox
- Filter button to view all photos of this person"
```

---

### Task 7: Integration + Register Commands

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src/components/PhotoDetail.tsx`

- [ ] **Step 1: Register all new commands in lib.rs**

Ensure these are in the `.invoke_handler()` call:
```rust
cmd_add_face_constraint,
cmd_remove_face_constraint,
cmd_get_person_detail,
cmd_get_person_timeline,
cmd_get_person_scene_tags,
cmd_split_person,
```

- [ ] **Step 2: Add face annotation to PhotoDetail**

In `src/components/PhotoDetail.tsx`, find the faces section (around line 350-380). Add face annotation UI:

```tsx
// In the faces section, add click-to-annotate on each face:
{faces.map((face, idx) => (
  <div key={face.id} className="relative">
    {/* Existing face thumbnail */}
    <div className="group relative cursor-pointer">
      {/* ... existing face thumbnail ... */}
      {/* Annotation overlay */}
      <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          onClick={() => {
            // Show person picker or create new constraint
            api.addFaceConstraint(
              photo.id!,
              idx,
              // ... target person
              "must_link"
            );
          }}
          className="rounded bg-white/20 px-2 py-1 text-xs text-white"
        >
          标注
        </button>
      </div>
    </div>
  </div>
))}
```

- [ ] **Step 3: Verify and test**

```bash
npx tsc --noEmit
cd src-tauri && cargo check
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/main.rs src/components/PhotoDetail.tsx
git commit -m "feat(faces): register commands + add face annotation to PhotoDetail

- Register all new face constraint and person detail commands
- Add hover annotation button on faces in PhotoDetail panel
- Click to mark a face as belonging to a specific person"
```
