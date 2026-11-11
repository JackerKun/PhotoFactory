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
        photo_id = _photo_id_from_embedding_name(filename)
        if photo_id is not None:
            photo_ids.setdefault(int(cluster_id), set()).add(photo_id)
        path = os.path.join(embeddings_dir, filename)
        try:
            vector = np.asarray(np.load(path), dtype=np.float32)
        except Exception:
            continue
        norm = np.linalg.norm(vector)
        if not np.isfinite(norm) or norm <= 0:
            continue
        members.setdefault(int(cluster_id), []).append(vector / norm)

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


def cluster_faces_v2(
    embeddings_dir: str,
    existing_clusters: dict = None,
    threshold: float = 0.6,
    must_links: list = None,
    cannot_links: list = None,
    candidate_files: list = None,
    memberships: dict = None,
    qualities: dict = None,
    review_files: list = None,
) -> dict:
    """Compare against bounded prototypes; enforce constraints using all memberships."""
    prototypes = existing_clusters or {}
    results = dict(prototypes)
    occupied = {}
    members = dict(prototypes)
    members.update(memberships or {})
    for filename, person in members.items():
        occupied.setdefault(person, {}).setdefault(_photo_id_from_embedding_name(filename), set()).add(filename)

    def links(pairs):
        mapping = {}
        for a, b in pairs or []:
            left, right = f"{int(a):08x}.npy", f"{int(b):08x}.npy"
            mapping.setdefault(left, set()).add(right)
            mapping.setdefault(right, set()).add(left)
        return mapping

    must, cannot = links(must_links), links(cannot_links)
    quality = qualities or {}
    threshold = float(np.clip(threshold, 0.45, 0.85))

    def allowed(filename, person, manual=False):
        if any(members.get(other) == person for other in cannot.get(filename, ())):
            return False
        photo = _photo_id_from_embedding_name(filename)
        same_photo = occupied.get(person, {}).get(photo, ())
        return photo is None or not same_photo or (
            manual and set(same_photo).issubset(must.get(filename, ()))
        )

    def assign(filename, person):
        results[filename] = members[filename] = person
        occupied.setdefault(person, {}).setdefault(_photo_id_from_embedding_name(filename), set()).add(filename)

    files = candidate_files if candidate_files is not None else os.listdir(embeddings_dir)
    vectors = {}
    for filename in sorted(set(files) | set(prototypes)):
        if not filename.endswith(".npy") or (filename in members and filename not in prototypes):
            continue
        try:
            vector = np.asarray(np.load(os.path.join(embeddings_dir, filename)), dtype=np.float32)
            norm = np.linalg.norm(vector)
            if vector.ndim == 1 and np.isfinite(norm) and norm > 0:
                vectors[filename] = vector / norm
        except (ValueError, OSError):
            continue
    candidates = [filename for filename in vectors if filename not in members]
    pending = set()
    seeds = {}
    for filename, person in prototypes.items():
        if filename in vectors:
            seeds.setdefault(person, []).append(vectors[filename])
    people = sorted(seeds)

    # Resolve explicit links first, including links to non-prototype faces.
    while True:
        changed = False
        for filename in candidates:
            if filename in members:
                continue
            targets = {members[other] for other in must.get(filename, ()) if other in members}
            if len(targets) == 1 and allowed(filename, next(iter(targets)), manual=True):
                assign(filename, next(iter(targets)))
                changed = True
        if not changed:
            break

    remaining = [filename for filename in candidates if filename not in members]
    if remaining and people:
        matrix = np.stack([vectors[name] for name in remaining])
        centers, references, starts = [], [], []
        for person in people:
            refs = np.stack(seeds[person])
            centroid = refs.mean(axis=0)
            centers.append(centroid / max(np.linalg.norm(centroid), 1e-12))
            starts.append(len(references))
            references.extend(refs)
        nearest = np.maximum.reduceat(matrix @ np.stack(references).T, starts, axis=1)
        scores = 0.72 * (matrix @ np.stack(centers).T) + 0.28 * nearest
        # Give the strongest face first choice when a photo has competing faces.
        for row in np.argsort(-scores.max(axis=1), kind="stable"):
            name = remaining[row]
            ranked = np.argsort(-scores[row], kind="stable")
            viable = []
            for pos in ranked:
                if allowed(name, people[pos]):
                    viable.append(pos)
                    if len(viable) == 2:
                        break
            if any(other in members for other in must.get(name, ())):
                pending.add(name)
                continue
            if not viable:
                if scores[row, ranked[0]] >= threshold - 0.04:
                    pending.add(name)
                continue
            best = viable[0]
            score = scores[row, best]
            gap = score - scores[row, viable[1]] if len(viable) > 1 else 2.0
            # Don't fall through to the second person if the closest identity
            # is already in this photo. Keep both detections reviewable.
            blocked_best = ranked[0] != best and scores[row, ranked[0]] >= threshold
            effective = threshold + (0.05 if 0 < quality.get(name, 1) < 0.55 else 0)
            if score >= effective and gap >= 0.06 and not blocked_best:
                assign(name, people[best])
            elif score >= threshold - 0.04 or blocked_best:
                pending.add(name)

    remaining = [name for name in candidates if name not in members]
    seed_names = [name for name in remaining if name not in pending]
    labels = []
    if len(seed_names) > 1:
        matrix = np.stack([vectors[name] for name in seed_names])
        distances = np.clip(1 - matrix @ matrix.T, 0, 2)
        photo_ids = np.array([_photo_id_from_embedding_name(name) or 0 for name in seed_names])
        low_quality = np.array([0 < quality.get(name, 1) < 0.55 for name in seed_names])
        distances += 0.05 * (low_quality[:, None] | low_quality[None, :])
        distances[(photo_ids[:, None] == photo_ids[None, :]) & (photo_ids[:, None] > 0)] = 2
        positions = {name: idx for idx, name in enumerate(seed_names)}
        for mapping, distance in ((must, 0), (cannot, 2)):
            for left, others in mapping.items():
                if left not in positions:
                    continue
                for right in others:
                    if right in positions:
                        distances[positions[left], positions[right]] = distance
        # If two plausible matches contradict each other, don't let their
        # nearly tied bridge decide which of them gets the face.
        if len(seed_names) >= 3:
            np.fill_diagonal(distances, 2)
            closest = np.argpartition(distances, 1, axis=1)[:, :2]
            for i, (left, right) in enumerate(closest):
                if (max(distances[i, left], distances[i, right]) < 1 - threshold
                    and abs(distances[i, left] - distances[i, right]) < 0.045
                    and distances[left, right] >= 1 - threshold
                    and not must.get(seed_names[i])):
                    pending.add(seed_names[i])
            for name in pending.intersection(positions):
                i = positions[name]
                distances[i, :] = distances[:, i] = 2
        np.fill_diagonal(distances, 0)
        labels = AgglomerativeClustering(
            n_clusters=None, metric="precomputed", linkage="complete",
            distance_threshold=1 - threshold,
        ).fit_predict(distances)
    elif seed_names:
        labels = [0]

    next_id = max(members.values(), default=-1) + 1
    new_labels = {}
    label_counts = dict(zip(*np.unique(labels, return_counts=True)))
    for name, label in zip(seed_names, labels):
        if label_counts[label] == 1 and 0 < quality.get(name, 1) < 0.55:
            pending.add(name)
        if name in pending:
            continue
        if label not in new_labels:
            new_labels[label] = next_id
            next_id += 1
        assign(name, new_labels[label])
    for name in sorted(pending):
        assign(name, next_id)
        next_id += 1
    if review_files is not None:
        review_files.extend(sorted(pending))
    return results
