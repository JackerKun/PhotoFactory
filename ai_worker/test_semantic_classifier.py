import unittest

from semantic_classifier import SEMANTIC_LABELS, select_semantic_tags


class SemanticClassifierTests(unittest.TestCase):
    def test_selects_diverse_reliable_tags(self):
        scores = [0.0] * len(SEMANTIC_LABELS)
        by_label = {item.label: index for index, item in enumerate(SEMANTIC_LABELS)}
        scores[by_label["猫"]] = 0.34
        scores[by_label["狗"]] = 0.31
        scores[by_label["鸟"]] = 0.30
        scores[by_label["海滩"]] = 0.29
        tags = select_semantic_tags(scores)
        self.assertEqual([tag.label for tag in tags], ["猫", "狗", "海滩"])
        self.assertTrue(all(tag.tag_type == "ai_semantic" for tag in tags))

    def test_rejects_scores_below_threshold(self):
        tags = select_semantic_tags([0.20] * len(SEMANTIC_LABELS))
        self.assertEqual(tags, [])


if __name__ == "__main__":
    unittest.main()
