import os
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from face_clusterer import _complete_link_labels, cluster_faces_v2, plan_automatic_cluster_merges


class FaceClustererTests(unittest.TestCase):
    def test_complete_link_keeps_pairs_at_the_cutoff_separate(self):
        distances = np.array([[0, 0.125, 0.25], [0.125, 0, 0.25], [0.25, 0.25, 0]])
        labels = _complete_link_labels(distances, 0.25, lambda *_: None)
        np.testing.assert_array_equal(labels, [0, 0, 2])

    def test_first_batch_groups_without_loading_scipy_or_sklearn(self):
        from builtins import __import__ as import_module

        def checked_import(name, *args, **kwargs):
            if name.split(".", 1)[0] in ("scipy", "sklearn"):
                raise AssertionError(f"Incremental grouping loaded {name}")
            return import_module(name, *args, **kwargs)

        vectors = {index << 8: [1, 0] if index % 2 else [0, 1] for index in range(1, 1001)}
        phases = []
        with patch("builtins.__import__", side_effect=checked_import):
            result = self.run_cluster(vectors, progress=lambda *event: phases.append(event))

        self.assertEqual(len(result), 1000)
        self.assertEqual(len(set(result.values())), 2)
        self.assertIn(("run_linkage", 992, 999, 0), phases)

    def test_complete_link_does_not_chain_different_people(self):
        # A-B and B-C are near neighbours, but A-C are not. DBSCAN merged this
        # kind of chain; complete linkage must keep C separate.
        vectors = {
            "00000100.npy": np.array([1.0, 0.0, 0.0]),
            "00000200.npy": np.array([0.9, 0.43589, 0.0]),
            "00000300.npy": np.array([0.5, 0.86603, 0.0]),
        }
        with tempfile.TemporaryDirectory() as directory:
            for filename, vector in vectors.items():
                np.save(os.path.join(directory, filename), vector)
            result = cluster_faces_v2(directory, threshold=0.6)

        self.assertEqual(result["00000100.npy"], result["00000200.npy"])
        self.assertNotEqual(result["00000100.npy"], result["00000300.npy"])

    def test_incremental_face_uses_requested_similarity_threshold(self):
        with tempfile.TemporaryDirectory() as directory:
            np.save(os.path.join(directory, "00000100.npy"), np.array([1.0, 0.0]))
            np.save(os.path.join(directory, "00000200.npy"), np.array([0.7, 0.714]))
            result = cluster_faces_v2(
                directory,
                existing_clusters={"00000100.npy": 9},
                threshold=0.75,
            )

        self.assertEqual(result["00000100.npy"], 9)
        self.assertNotEqual(result["00000200.npy"], 9)

    def test_incremental_candidates_do_not_reload_unrelated_history(self):
        with tempfile.TemporaryDirectory() as directory:
            np.save(os.path.join(directory, "00000100.npy"), np.array([1.0, 0.0]))
            np.save(os.path.join(directory, "00000200.npy"), np.array([0.99, 0.01]))
            np.save(os.path.join(directory, "00009999.npy"), np.array([0.0, 1.0]))
            result = cluster_faces_v2(
                directory,
                existing_clusters={"00000100.npy": 9},
                candidate_files=["00000200.npy"],
                threshold=0.75,
            )

        self.assertEqual(set(result), {"00000100.npy", "00000200.npy"})
        self.assertEqual(result["00000200.npy"], 9)

    def test_incremental_progress_reports_unreadable_features_and_keeps_valid_faces(self):
        phases = []
        result = self.run_cluster(
            {0x100: [1, 0], 0x200: [1, 0]},
            existing_clusters={"00000100.npy": 9},
            candidate_files=["00000200.npy", "00000300.npy"],
            progress=lambda *event: phases.append(event),
        )
        self.assertIn(("read_embeddings", 3, 3, 1), phases)
        self.assertIn(("compare_people", 0, 1, 1), phases)
        self.assertEqual(phases[-1][0], "form_groups")
        self.assertEqual(result["00000200.npy"], 9)
        self.assertNotIn("00000300.npy", result)

    def run_cluster(self, vectors, **kwargs):
        with tempfile.TemporaryDirectory() as directory:
            for key, vector in vectors.items():
                np.save(os.path.join(directory, f"{key:08x}.npy"), np.array(vector))
            return cluster_faces_v2(directory, **kwargs)

    def test_fresh_group_respects_same_photo_and_saved_cannot_link(self):
        result = self.run_cluster(
            {0x100: [1, 0], 0x101: [1, 0], 0x200: [1, 0]},
            cannot_links=[(0x100, 0x200), (0x101, 0x200)],
        )
        self.assertEqual(len(set(result.values())), 3)

    def test_explicit_same_photo_link_overrides_automatic_exclusion(self):
        result = self.run_cluster(
            {0x100: [1, 0], 0x101: [0, 1]},
            must_links=[(0x100, 0x101)],
        )
        self.assertEqual(len(set(result.values())), 1)

    def test_unloaded_members_enforce_photo_exclusion_and_both_correction_types(self):
        cases = [
            (0x201, [], [], False),
            (0x300, [], [(0x200, 0x300)], False),
            (0x300, [(0x200, 0x300)], [], True),
        ]
        for candidate, must, cannot, expected in cases:
            with self.subTest(candidate=candidate, must=must, cannot=cannot):
                name = f"{candidate:08x}.npy"
                result = self.run_cluster(
                    {0x100: [1, 0], candidate: [1, 0] if not must else [0, 1]},
                    existing_clusters={"00000100.npy": 9}, memberships={"00000200.npy": 9},
                    candidate_files=[name], must_links=must, cannot_links=cannot,
                )
                self.assertEqual(result[name] == 9, expected)

    def test_near_tie_does_not_teach_an_existing_identity(self):
        review = []
        result = self.run_cluster(
            {0x100: [0.95, 0.31], 0x200: [0.95, -0.31], 0x300: [1, 0]},
            existing_clusters={"00000100.npy": 10, "00000200.npy": 20},
            review_files=review,
        )
        self.assertNotIn(result["00000300.npy"], (10, 20))
        self.assertEqual(review, ["00000300.npy"])

    def test_fresh_near_tie_isolates_a_bridge_between_incompatible_faces(self):
        review = []
        result = self.run_cluster(
            {0x100: [0.82, 0.572], 0x200: [0.82, -0.572], 0x300: [1, 0]},
            review_files=review,
        )
        self.assertEqual(len(set(result.values())), 3)
        self.assertEqual(review, ["00000300.npy"])

    def test_post_merge_tolerates_one_pose_outlier_when_most_faces_agree(self):
        with tempfile.TemporaryDirectory() as directory:
            vectors = {
                "00000100.npy": ([1.0, 0.0], 10),
                "00000200.npy": ([0.98, 0.20], 10),
                "00000300.npy": ([0.74, 0.67], 10),
                "00000400.npy": ([0.99, 0.10], 20),
                "00000500.npy": ([0.97, 0.24], 20),
                "00000600.npy": ([0.96, 0.28], 20),
            }
            assignments = {}
            for filename, (vector, cluster_id) in vectors.items():
                np.save(os.path.join(directory, filename), np.array(vector))
                assignments[filename] = cluster_id

            groups = plan_automatic_cluster_merges(directory, assignments, 0.72)

        self.assertEqual(groups, [[10, 20]])

    def test_post_merge_can_use_one_named_destination_per_group(self):
        with tempfile.TemporaryDirectory() as directory:
            assignments = {"00000100.npy": 10, "00000200.npy": 20, "00000300.npy": 30}
            for filename in assignments:
                np.save(os.path.join(directory, filename), np.array([1.0, 0.0]))
            groups = plan_automatic_cluster_merges(
                directory, assignments, 0.72, named_cluster_ids=[20, 30]
            )
            self.assertEqual(len(groups), 1)
            self.assertIn(10, groups[0])
            self.assertEqual(len(set(groups[0]) & {20, 30}), 1)
            self.assertEqual(
                plan_automatic_cluster_merges(directory, assignments, 0.72, named_cluster_ids=[10, 20, 30]),
                [],
            )

    def test_merge_progress_reports_missing_embeddings_and_rejects_an_empty_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            assignments = {"00000100.npy": 10, "00000200.npy": 20, "00000300.npy": 30}
            for name in list(assignments)[:2]:
                np.save(os.path.join(directory, name), np.array([1.0, 0.0]))
            updates = []
            groups = plan_automatic_cluster_merges(
                directory, assignments, progress=lambda *update: updates.append(update)
            )
            self.assertEqual(groups, [[10, 20]])
            self.assertIn(("read_embeddings", 3, 3, 1), updates)
            self.assertIn(("find_neighbors", 2, 2, 1), updates)
            self.assertEqual(updates[-1], ("build_candidates", 1, 1, 1))
            with self.assertRaisesRegex(ValueError, "无法读取全部"):
                plan_automatic_cluster_merges(directory, {"00000300.npy": 30})

    def test_post_merge_can_find_pairs_below_the_old_cutoff(self):
        with tempfile.TemporaryDirectory() as directory:
            np.save(os.path.join(directory, "00012300.npy"), np.array([1.0, 0.0]))
            np.save(os.path.join(directory, "00012400.npy"), np.array([0.48, 0.8773]))
            assignments = {"00012300.npy": 10, "00012400.npy": 20}
            self.assertEqual(plan_automatic_cluster_merges(directory, assignments, 0.60), [])
            self.assertEqual(plan_automatic_cluster_merges(directory, assignments, 0.40), [[10, 20]])

    def test_post_merge_never_joins_people_from_the_same_photo(self):
        with tempfile.TemporaryDirectory() as directory:
            # First six hex digits encode the same photo id; final byte is face index.
            np.save(os.path.join(directory, "00012300.npy"), np.array([1.0, 0.0]))
            np.save(os.path.join(directory, "00012301.npy"), np.array([0.999, 0.01]))
            groups = plan_automatic_cluster_merges(
                directory,
                {"00012300.npy": 10, "00012301.npy": 20},
                0.72,
            )

        self.assertEqual(groups, [])

    def test_post_merge_respects_a_saved_cannot_link(self):
        with tempfile.TemporaryDirectory() as directory:
            np.save(os.path.join(directory, "00012300.npy"), np.array([1.0, 0.0]))
            np.save(os.path.join(directory, "00012400.npy"), np.array([0.999, 0.01]))
            groups = plan_automatic_cluster_merges(
                directory,
                {"00012300.npy": 10, "00012400.npy": 20},
                0.72,
                cannot_links=[(0x00012300, 0x00012400)],
            )

        self.assertEqual(groups, [])


if __name__ == "__main__":
    unittest.main()
