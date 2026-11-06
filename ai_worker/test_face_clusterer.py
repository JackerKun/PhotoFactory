import os
import tempfile
import unittest

import numpy as np

from face_clusterer import cluster_faces_v2, plan_automatic_cluster_merges


class FaceClustererTests(unittest.TestCase):
    def test_complete_link_does_not_chain_different_people(self):
        # A-B and B-C are near neighbours, but A-C are not. DBSCAN merged this
        # kind of chain; complete linkage must keep C separate.
        vectors = {
            "00000001.npy": np.array([1.0, 0.0, 0.0]),
            "00000002.npy": np.array([0.9, 0.43589, 0.0]),
            "00000003.npy": np.array([0.5, 0.86603, 0.0]),
        }
        with tempfile.TemporaryDirectory() as directory:
            for filename, vector in vectors.items():
                np.save(os.path.join(directory, filename), vector)
            result = cluster_faces_v2(directory, threshold=0.6)

        self.assertEqual(result["00000001.npy"], result["00000002.npy"])
        self.assertNotEqual(result["00000001.npy"], result["00000003.npy"])

    def test_incremental_face_uses_requested_similarity_threshold(self):
        with tempfile.TemporaryDirectory() as directory:
            np.save(os.path.join(directory, "00000001.npy"), np.array([1.0, 0.0]))
            np.save(os.path.join(directory, "00000002.npy"), np.array([0.7, 0.714]))
            result = cluster_faces_v2(
                directory,
                existing_clusters={"00000001.npy": 9},
                threshold=0.75,
            )

        self.assertEqual(result["00000001.npy"], 9)
        self.assertNotEqual(result["00000002.npy"], 9)

    def test_incremental_candidates_do_not_reload_unrelated_history(self):
        with tempfile.TemporaryDirectory() as directory:
            np.save(os.path.join(directory, "00000001.npy"), np.array([1.0, 0.0]))
            np.save(os.path.join(directory, "00000002.npy"), np.array([0.99, 0.01]))
            np.save(os.path.join(directory, "00009999.npy"), np.array([0.0, 1.0]))
            result = cluster_faces_v2(
                directory,
                existing_clusters={"00000001.npy": 9},
                candidate_files=["00000002.npy"],
                threshold=0.75,
            )

        self.assertEqual(set(result), {"00000001.npy", "00000002.npy"})
        self.assertEqual(result["00000002.npy"], 9)

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
