# ai_worker/face_clusterer.py
"""Face clustering using DBSCAN on face embeddings."""

import json
import os
from typing import List, Dict
import numpy as np
from sklearn.cluster import DBSCAN
from sklearn.cluster import AgglomerativeClustering
from sklearn.neighbors import NearestNeighbors
from sklearn.metrics.pairwise import cosine_similarity as cosine_sim_matrix

def cluster_faces(
    embeddings_dir: str,
    eps: float = 0.6,
    min_samples: int = 2
) -> Dict[str, int]:
    """Cluster faces based on embeddings. Returns mapping of file -> cluster_id."""
    files = [f for f in os.listdir(embeddings_dir) if f.endswith('.npy')]
    if not files:
        return {}

    embedding_map = {}
    vectors = []
    for f in files:
        path = os.path.join(embeddings_dir, f)
        vec = np.load(path)
        embedding_map[f] = vec
        vectors.append(vec)

    X = np.array(vectors)
    clustering = DBSCAN(eps=eps, min_samples=min_samples, metric="cosine").fit(X)
    labels = clustering.labels_

    result = {}
    for i, f in enumerate(files):
        result[f] = int(labels[i])
    return result

def save_cluster_results(results: Dict[str, int], output_path: str):
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, 'w') as f:
        json.dump(results, f)

def load_cluster_results(path: str) -> Dict[str, int]:
    with open(path, 'r') as f:
        return json.load(f)

def compute_centroid(embeddings: np.ndarray) -> np.ndarray:
    """Compute the mean embedding (centroid) from a list of embeddings."""
    return np.mean(embeddings, axis=0)

def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Compute cosine similarity between two vectors."""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


def compute_adaptive_eps(
    embeddings: np.ndarray,
    min_eps: float = 0.3,
    max_eps: float = 0.8
) -> float:
    """Compute optimal eps using K-distance graph elbow method."""
    n_samples = len(embeddings)
    if n_samples < 10:
        return min_eps

    k = min(10, n_samples - 1)
    neighbors = NearestNeighbors(n_neighbors=k, metric='cosine').fit(embeddings)
    distances, _ = neighbors.kneighbors(embeddings)

    k_distances = np.sort(distances[:, -1])

    n_points = len(k_distances)
    x = np.arange(n_points)
    y = k_distances

    p1 = np.array([x[0], y[0]])
    p2 = np.array([x[-1], y[-1]])

    line_vec = p2 - p1
    line_len = np.sqrt(np.sum(line_vec ** 2))
    if line_len == 0:
        return min_eps

    line_unit = line_vec / line_len

    max_dist = 0.0
    elbow_idx = n_points // 2

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


def compute_face_quality(
    embedding: np.ndarray,
    all_embeddings: np.ndarray
) -> float:
    """Compute face quality score based on embedding distinctiveness.

    Returns a value between 0.0 and 1.0. Higher = more distinctive/better quality.
    """
    if len(all_embeddings) < 2:
        return 0.5

    similarities = cosine_sim_matrix(
        embedding.reshape(1, -1), all_embeddings
    )[0]

    mean_sim = np.mean(similarities)

    quality = max(0.0, min(1.0, 1.0 - mean_sim))
    return float(quality)


def _complete_link_labels(embeddings: np.ndarray, threshold: float) -> np.ndarray:
    """Cluster without DBSCAN's transitive-chain failure mode.

    ArcFace embeddings are unit vectors and ``1 - cosine_similarity`` is their
    cosine distance.  Complete-link clustering only joins two groups when every
    cross-group pair is close enough, so a sequence of merely similar faces can
    no longer collapse an entire library into one person.
    """
    if len(embeddings) == 0:
        return np.array([], dtype=int)
    if len(embeddings) == 1:
        return np.array([0], dtype=int)

    safe_threshold = float(max(0.45, min(0.8, threshold)))
    return AgglomerativeClustering(
        n_clusters=None,
        metric="cosine",
        linkage="complete",
        distance_threshold=1.0 - safe_threshold,
    ).fit_predict(embeddings)


def _photo_id_from_embedding_name(filename: str):
    """Return the photo id encoded by Rust's ``{photo_id:06x}{index:02x}`` name."""
    try:
        stem = os.path.splitext(os.path.basename(filename))[0]
        return int(stem[:-2], 16) if len(stem) > 2 else None
    except (TypeError, ValueError):
        return None


def plan_automatic_cluster_merges(
    embeddings_dir: str,
    assignments: dict,
    threshold: float = 0.72,
    cannot_links: list = None,
    return_details: bool = False,
) -> list:
    """Find high-confidence merge groups among automatic person clusters.

    ``assignments`` must contain only machine-created/unnamed people.  Callers
    deliberately exclude named people, and this function never proposes a
    destination outside that set.

    A centroid match alone is not enough: at least 60% of the faces on both
    sides must have a plausible counterpart.  Groups containing faces from the
    same photo are incompatible, which prevents two people standing next to
    each other from being collapsed by a visually similar pair.
    """
    safe_threshold = float(max(0.60, min(0.90, threshold)))
    support_threshold = max(0.54, safe_threshold - 0.14)

    members = {}
    photo_ids = {}
    for filename, cluster_id in assignments.items():
        path = os.path.join(embeddings_dir, filename)
        try:
            vector = np.asarray(np.load(path), dtype=np.float32)
        except Exception:
            continue
        norm = np.linalg.norm(vector)
        if not np.isfinite(norm) or norm <= 0:
            continue
        members.setdefault(int(cluster_id), []).append(vector / norm)
        photo_id = _photo_id_from_embedding_name(filename)
        if photo_id is not None:
            photo_ids.setdefault(int(cluster_id), set()).add(photo_id)

    cluster_ids = sorted(members)
    if len(cluster_ids) < 2:
        return []

    matrices = {cluster_id: np.stack(members[cluster_id]) for cluster_id in cluster_ids}
    centroids = {}
    compactness = {}
    prototypes = {}
    for cluster_id, matrix in matrices.items():
        centroid = matrix.mean(axis=0)
        norm = np.linalg.norm(centroid)
        centroids[cluster_id] = centroid / norm if norm > 0 else centroid
        compactness[cluster_id] = float(np.mean(matrix @ centroids[cluster_id]))
        # Keep up to three diverse, real faces instead of representing a person
        # with one mean vector.  This handles side views and appearance changes.
        chosen = [int(np.argmax(matrix @ centroids[cluster_id]))]
        while len(chosen) < min(3, len(matrix)):
            similarity_to_chosen = matrix @ matrix[chosen].T
            next_index = int(np.argmin(np.max(similarity_to_chosen, axis=1)))
            if next_index in chosen:
                break
            chosen.append(next_index)
        prototypes[cluster_id] = matrix[chosen]

    blocked_pairs = set()
    for left_key, right_key in cannot_links or []:
        left_filename = f"{int(left_key):08x}.npy"
        right_filename = f"{int(right_key):08x}.npy"
        left_id = assignments.get(left_filename)
        right_id = assignments.get(right_filename)
        if left_id is not None and right_id is not None and left_id != right_id:
            blocked_pairs.add(tuple(sorted((int(left_id), int(right_id)))))

    compatible = {}
    centroid_similarities = {}
    photo_conflicts = set()
    candidates = []
    # Comparing every pair becomes expensive for very large libraries.  An ANN-
    # ready nearest-neighbour stage limits expensive face-to-face checks to the
    # 50 closest people per cluster while preserving deterministic behaviour.
    centroid_matrix = np.stack([centroids[cluster_id] for cluster_id in cluster_ids])
    neighbor_count = min(51, len(cluster_ids))
    neighbors = NearestNeighbors(n_neighbors=neighbor_count, metric="cosine").fit(centroid_matrix)
    _, neighbor_indices = neighbors.kneighbors(centroid_matrix)
    candidate_pairs = set()
    for left_pos, positions in enumerate(neighbor_indices):
        for right_pos in positions[1:]:
            candidate_pairs.add(tuple(sorted((cluster_ids[left_pos], cluster_ids[int(right_pos)]))))

    for left_id, right_id in sorted(candidate_pairs):
        if (left_id, right_id) in blocked_pairs:
            compatible[(left_id, right_id)] = False
            continue
        if photo_ids.get(left_id, set()) & photo_ids.get(right_id, set()):
            photo_conflicts.add((left_id, right_id))
            compatible[(left_id, right_id)] = False
            continue
        centroid_similarity = float(centroids[left_id] @ centroids[right_id])
        centroid_similarities[(left_id, right_id)] = centroid_similarity
        prototype_cross = prototypes[left_id] @ prototypes[right_id].T
        prototype_similarity = float(np.max(prototype_cross))
        similarity = 0.78 * centroid_similarity + 0.22 * prototype_similarity
        effective_threshold = safe_threshold
        if min(len(matrices[left_id]), len(matrices[right_id])) == 1:
            effective_threshold += 0.025
        elif min(len(matrices[left_id]), len(matrices[right_id])) >= 5:
            effective_threshold -= 0.015
        if min(compactness[left_id], compactness[right_id]) < 0.72:
            effective_threshold += 0.02
        effective_threshold = float(np.clip(effective_threshold, 0.60, 0.90))
        if similarity < effective_threshold:
            compatible[(left_id, right_id)] = False
            continue

        cross = matrices[left_id] @ matrices[right_id].T
        left_support = float(np.mean(np.max(cross, axis=1) >= support_threshold))
        right_support = float(np.mean(np.max(cross, axis=0) >= support_threshold))
        is_compatible = left_support >= 0.60 and right_support >= 0.60
        compatible[(left_id, right_id)] = is_compatible
        if is_compatible:
            candidates.append((similarity, left_id, right_id))

    # Greedy complete-link over *person centroids*.  This permits pose/expression
    # outliers within a person while still preventing transitive A-B-C chains.
    groups = [{cluster_id} for cluster_id in cluster_ids]
    candidates.sort(reverse=True)
    for _, left_id, right_id in candidates:
        left_group = next((group for group in groups if left_id in group), None)
        right_group = next((group for group in groups if right_id in group), None)
        if left_group is None or right_group is None or left_group is right_group:
            continue
        cross_keys = [
            tuple(sorted((a, b)))
            for a in left_group
            for b in right_group
        ]
        cross_similarities = [centroid_similarities.get(key, -1.0) for key in cross_keys]
        supported_fraction = float(np.mean([
            compatible.get(key, False) for key in cross_keys
        ]))
        # Average-link at the person-seed level tolerates one unusual pose, while
        # the minimum-spread and support checks stop weak similarity chains.
        can_merge_groups = (
            not any(key in photo_conflicts for key in cross_keys)
            and float(np.mean(cross_similarities)) >= safe_threshold
            and min(cross_similarities) >= safe_threshold - 0.06
            and supported_fraction >= 0.60
        )
        if can_merge_groups:
            left_group.update(right_group)
            groups.remove(right_group)

    merge_groups = [sorted(group) for group in groups if len(group) > 1]
    if not return_details:
        return merge_groups
    details = []
    for group in merge_groups:
        pair_scores = [
            float(centroids[a] @ centroids[b])
            for position, a in enumerate(group)
            for b in group[position + 1:]
        ]
        details.append({
            "cluster_ids": group,
            "similarity": float(np.mean(pair_scores)) if pair_scores else 1.0,
            "face_count": sum(len(matrices[cluster_id]) for cluster_id in group),
        })
    return details


def _apply_planned_merges(assignments: dict, merge_groups: list) -> dict:
    remap = {}
    for group in merge_groups:
        target = min(group)
        remap.update({cluster_id: target for cluster_id in group})
    return {
        filename: remap.get(cluster_id, cluster_id)
        for filename, cluster_id in assignments.items()
    }


def cluster_faces_v2(
    embeddings_dir: str,
    existing_clusters: dict = None,
    threshold: float = 0.6,
    must_links: list = None,
    cannot_links: list = None,
    candidate_files: list = None,
) -> dict:
    """Incremental complete-link clustering with constraint support.

    existing_clusters: {filename: cluster_id} from previous runs
    must_links: [(face_key_1, face_key_2), ...]
    cannot_links: same format
    Returns: {filename: cluster_id}
    """
    if candidate_files is None:
        npy_files = [f for f in os.listdir(embeddings_dir) if f.endswith('.npy')]
    else:
        # Incremental runs only load new faces and a few persisted prototypes
        # per existing person, keeping memory bounded for very large libraries.
        npy_files = sorted(set(candidate_files) | set((existing_clusters or {}).keys()))
        npy_files = [f for f in npy_files if f.endswith('.npy')]
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

    face_key_to_idx = {f: i for i, f in enumerate(file_names)}
    must_link_map = {}
    cannot_link_map = {}

    def face_key_to_filename(key):
        return f"{int(key):08x}.npy"

    if must_links:
        cluster_members = {}
        if existing_clusters:
            for fname, cid in existing_clusters.items():
                cluster_members.setdefault(cid, set()).add(fname)

        for key1, key2 in must_links:
            f1, f2 = face_key_to_filename(key1), face_key_to_filename(key2)
            idx1 = face_key_to_idx.get(f1)
            idx2 = face_key_to_idx.get(f2)
            if idx1 is None or idx2 is None:
                continue
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
                cannot_link_map.setdefault(idx1, set()).add(
                    existing_clusters[f2] if f2 in existing_clusters else None
                )
            if f2 in existing_clusters:
                cannot_link_map.setdefault(idx2, set()).add(
                    existing_clusters[f1] if f1 in existing_clusters else None
                )

    cluster_centroids = {}
    cluster_prototypes = {}
    cluster_sizes = {}
    if existing_clusters:
        cluster_members = {}
        for fname, cid in existing_clusters.items():
            if fname in face_key_to_idx:
                cluster_members.setdefault(cid, []).append(face_key_to_idx[fname])

        for cid, indices in cluster_members.items():
            embs = X[indices]
            centroid = np.mean(embs, axis=0)
            centroid /= max(np.linalg.norm(centroid), 1e-12)
            cluster_centroids[cid] = centroid
            cluster_sizes[cid] = len(embs)
            chosen = [int(np.argmax(embs @ centroid))]
            while len(chosen) < min(3, len(embs)):
                similarity_to_chosen = embs @ embs[chosen].T
                next_index = int(np.argmin(np.max(similarity_to_chosen, axis=1)))
                if next_index in chosen:
                    break
                chosen.append(next_index)
            cluster_prototypes[cid] = embs[chosen]

    if existing_clusters and len(existing_clusters) > 0:
        results = dict(existing_clusters)
        matched_files = set(existing_clusters)

        # Compute every new-face/centroid similarity in one BLAS-backed matrix
        # operation. The previous nested Python loop scaled as faces * people and
        # dominated clustering time for larger libraries.
        candidate_indices = [
            i for i, fname in enumerate(file_names) if fname not in existing_clusters
        ]
        cluster_ids = list(cluster_centroids)
        similarity_matrix = None
        if candidate_indices and cluster_ids:
            candidate_matrix = X[candidate_indices]
            centroid_matrix = np.stack([cluster_centroids[cid] for cid in cluster_ids])
            centroid_scores = cosine_sim_matrix(candidate_matrix, centroid_matrix)
            prototype_vectors = []
            prototype_cluster_positions = []
            for cluster_position, cluster_id in enumerate(cluster_ids):
                for prototype in cluster_prototypes[cluster_id]:
                    prototype_vectors.append(prototype)
                    prototype_cluster_positions.append(cluster_position)
            prototype_raw = cosine_sim_matrix(candidate_matrix, np.stack(prototype_vectors))
            prototype_scores = np.full_like(centroid_scores, -1.0)
            for prototype_position, cluster_position in enumerate(prototype_cluster_positions):
                prototype_scores[:, cluster_position] = np.maximum(
                    prototype_scores[:, cluster_position], prototype_raw[:, prototype_position]
                )
            similarity_matrix = 0.78 * centroid_scores + 0.22 * prototype_scores

        for row, i in enumerate(candidate_indices):
            fname = file_names[i]

            if i in must_link_map:
                results[fname] = must_link_map[i]
                matched_files.add(fname)
                continue
            if similarity_matrix is None:
                continue

            scores = similarity_matrix[row]
            # Constraints are uncommon, so only constrained faces need a sorted
            # fallback search. Everyone else uses the O(C) argmax fast path.
            blocked = cannot_link_map.get(i, set())
            if blocked:
                choices = np.argsort(scores)[::-1]
                best_pos = next(
                    (int(pos) for pos in choices if cluster_ids[int(pos)] not in blocked),
                    None,
                )
            else:
                best_pos = int(np.argmax(scores))

            effective_threshold = threshold
            if best_pos is not None and cluster_sizes[cluster_ids[best_pos]] >= 5:
                effective_threshold = max(0.45, threshold - 0.015)
            if best_pos is not None and float(scores[best_pos]) >= effective_threshold:
                results[fname] = cluster_ids[best_pos]
                matched_files.add(fname)

        unmatched_indices = [
            i for i in range(n_faces) if file_names[i] not in matched_files
        ]
        if unmatched_indices:
            X_unmatched = X[unmatched_indices]
            if len(X_unmatched) >= 2:
                labels = _complete_link_labels(X_unmatched, threshold)

                next_cluster_id = max(results.values(), default=-1) + 1
                label_to_cluster = {}
                for local_idx, global_idx in enumerate(unmatched_indices):
                    label = int(labels[local_idx])
                    if label not in label_to_cluster:
                        label_to_cluster[label] = next_cluster_id
                        next_cluster_id += 1
                    results[file_names[global_idx]] = label_to_cluster[label]
            else:
                next_cluster_id = max(results.values(), default=-1) + 1
                results[file_names[unmatched_indices[0]]] = next_cluster_id

        return results

    # Fresh clustering starts with conservative face-level seeds, then joins
    # well-supported seed groups by centroid.  This avoids both DBSCAN chaining
    # and the old behaviour where one unusual pose permanently split a person.
    labels = _complete_link_labels(X, threshold)

    results = {}
    next_cluster_id = 0
    label_to_cluster = {}
    for i, raw_label in enumerate(labels):
        label = int(raw_label)
        if label not in label_to_cluster:
            label_to_cluster[label] = next_cluster_id
            next_cluster_id += 1
        results[file_names[i]] = label_to_cluster[label]

    merge_groups = plan_automatic_cluster_merges(
        embeddings_dir,
        results,
        threshold=max(0.72, threshold + 0.12),
    )
    return _apply_planned_merges(results, merge_groups)
