#!/usr/bin/env python3
"""Evaluate face clustering against a small user-confirmed CSV data set.

CSV columns: embedding_path,person_label.  Paths may be embedding filenames or
absolute .npy paths.  Only listed faces are evaluated; no project data is changed.
"""

import argparse
import csv
import json
import sys
import tempfile
from pathlib import Path


def pair_metrics(labels, predicted):
    true_positive = false_positive = false_negative = 0
    for left in range(len(labels)):
        for right in range(left + 1, len(labels)):
            same_truth = labels[left] == labels[right]
            same_prediction = predicted[left] == predicted[right]
            true_positive += int(same_truth and same_prediction)
            false_positive += int(not same_truth and same_prediction)
            false_negative += int(same_truth and not same_prediction)
    precision = true_positive / max(1, true_positive + false_positive)
    recall = true_positive / max(1, true_positive + false_negative)
    f1 = 2 * precision * recall / max(1e-12, precision + recall)
    return precision, recall, f1, false_positive, false_negative


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("project_root", type=Path)
    parser.add_argument("labels_csv", type=Path)
    parser.add_argument("--threshold", type=float, default=0.60)
    args = parser.parse_args()

    repository = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(repository / "ai_worker"))
    from face_clusterer import cluster_faces_v2

    embeddings_root = args.project_root / ".pf" / "ai_cache" / "faces"
    rows = []
    with args.labels_csv.open(newline="", encoding="utf-8-sig") as source:
        for row in csv.DictReader(source):
            path = Path(row["embedding_path"])
            if not path.is_absolute():
                path = embeddings_root / path
            if path.exists() and row.get("person_label", "").strip():
                rows.append((path, row["person_label"].strip()))
    if len(rows) < 2:
        raise SystemExit("Need at least two valid labeled embeddings")

    with tempfile.TemporaryDirectory(prefix="photofactory-face-eval-") as directory:
        evaluation_dir = Path(directory)
        filenames = []
        for index, (source, _) in enumerate(rows):
            filename = f"{index:08x}.npy"
            (evaluation_dir / filename).symlink_to(source)
            filenames.append(filename)
        assignments = cluster_faces_v2(str(evaluation_dir), threshold=args.threshold)

    truth = [label for _, label in rows]
    predicted = [assignments[filename] for filename in filenames]
    precision, recall, f1, false_merges, missed_pairs = pair_metrics(truth, predicted)
    fragments = {}
    for label, cluster_id in zip(truth, predicted):
        fragments.setdefault(label, set()).add(cluster_id)
    report = {
        "faces": len(rows),
        "people": len(set(truth)),
        "predicted_clusters": len(set(predicted)),
        "pair_precision": round(precision, 4),
        "pair_recall": round(recall, 4),
        "pair_f1": round(f1, 4),
        "false_merge_pairs": false_merges,
        "missed_same_person_pairs": missed_pairs,
        "people_split_into_multiple_groups": sum(len(value) > 1 for value in fragments.values()),
        "threshold": args.threshold,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
