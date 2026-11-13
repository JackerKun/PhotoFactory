"""Exercise provider selection/fallback and the preview-to-original geometry."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from pillow_heif import register_heif_opener

from server import AiTag, ClassifyRequest, DetectFacesRequest, classify, detect_faces

from face_detector import FaceDetector
from inference_runtime import InferenceModel, loaded_providers


class RuntimeTests(unittest.TestCase):
    def test_classification_uses_fresh_preview_when_jpeg_decode_fails(self):
        class Classifier:
            def classify_image(self, image):
                assert image.getpixel((0, 0)) == (13, 45, 67)
                return [AiTag(label="fixture", confidence=1.0)]

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "broken.jpeg"
            preview = Path(directory) / "preview.webp"
            Image.new("RGB", (32, 32)).save(source)
            source.write_bytes(source.read_bytes()[:-15])
            Image.new("RGB", (16, 16), (13, 45, 67)).save(preview, lossless=True)
            missing = Path(directory) / "missing.webp"
            request = ClassifyRequest(paths=[str(source)], previews={str(source): [str(missing), str(preview)]})
            with patch("server.load_scene_classifier", return_value=Classifier()), \
                 patch("server.load_semantic_classifier", return_value=None):
                result = classify(request).results[0]
                self.assertIsNone(result.error)
                self.assertEqual(result.tags[0].label, "fixture")
                os.utime(preview, (1, 1))
                result = classify(request).results[0]
                self.assertIn("无法解码原图", result.error)
                self.assertEqual(result.tags, [])

    def test_gpu_failure_falls_back_per_model_and_updates_status(self):
        class FakeSession:
            def __init__(self, _path, *, sess_options, providers):
                self.providers = providers
                if "DmlExecutionProvider" in providers:
                    assert not sess_options.enable_mem_pattern

            def get_providers(self):
                return self.providers

            def disable_fallback(self):
                pass

            def run(self, _outputs, _feeds):
                if self.providers[0] == "DmlExecutionProvider":
                    raise RuntimeError("device lost")
                return [1]

        with patch.dict(os.environ, {"PHOTOFACTORY_AI_PROVIDER": "auto"}), \
             patch("inference_runtime.available_providers", return_value=["DmlExecutionProvider", "CPUExecutionProvider"]), \
             patch("inference_runtime.ort.InferenceSession", FakeSession):
            model = InferenceModel("test_model", "fixture.onnx")
            self.assertEqual(loaded_providers()["test_model"], "DmlExecutionProvider")
            self.assertEqual(model.run(None, {}), [1])
            self.assertEqual(loaded_providers()["test_model"], "CPUExecutionProvider")

    def test_heif_face_detection_uses_the_source_without_jpeg_reencoding(self):
        register_heif_opener()
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "原图.HEIC"
            Image.new("RGB", (80, 60), (120, 60, 30)).save(source, format="HEIF")
            class Decoder:
                def detect(self, path, _preview, timings):
                    self_path = Path(path)
                    assert self_path == source
                    with Image.open(self_path) as image:
                        self_size = image.convert("RGB").size
                    assert self_size == (80, 60)
                    timings["decode_ms"] = 0.0
                    return []
            with patch("server.load_face_detector", return_value=Decoder()), \
                 patch("server._convert_for_ai", side_effect=AssertionError("unexpected JPEG conversion")):
                result = detect_faces(DetectFacesRequest(paths=[str(source)]))
                self.assertIsNone(result.results[0].error)

    def test_preview_coordinates_map_to_source_and_embedding_uses_source_pixels(self):
        class StubSession:
            def run(self, _outputs, _feeds):
                return []

        with tempfile.TemporaryDirectory() as directory:
            original, preview = Path(directory) / "original.jpg", Path(directory) / "large.webp"
            Image.new("RGB", (2048, 1536), (220, 5, 5)).save(original)
            Image.new("RGB", (1024, 768), (5, 5, 220)).save(preview)
            detector = FaceDetector.__new__(FaceDetector)
            detector.det_session, detector.det_input_name = StubSession(), "input"
            def preprocess(image):
                self.assertEqual(image.size, (1024, 768))
                self.assertGreater(image.getpixel((0, 0))[2], 180)
                return None, 1, 0, 0
            def embed(images):
                self.assertEqual(images[0].size, (80, 100))
                self.assertGreater(images[0].getpixel((0, 0))[0], 180)
                return [[1.0, 0.0]]
            detector._preprocess = preprocess
            detector._decode_boxes = lambda *_: [(100, 50, 40, 50, None, 0.95)]
            detector._get_embeddings = embed
            timings = {}
            faces = detector.detect(str(original), str(preview), timings)
            self.assertEqual(faces[0].bbox, [200, 100, 80, 100])
            self.assertEqual(timings["preview_hits"], 1)

    def test_oversized_jpeg_embeds_scaled_crops_in_original_coordinates(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "large.jpg"
            Image.new("RGB", (1024, 768), (220, 5, 5)).save(source)
            detector = FaceDetector.__new__(FaceDetector)
            detector.det_input_name = "input"
            detector.det_session = type("Session", (), {"run": lambda *_: []})()

            def preprocess(image):
                self.assertEqual(image.size, (256, 192))
                return None, 1, 0, 0

            def embed(crops):
                self.assertEqual(crops[0].size, (40, 50))
                self.assertGreater(crops[0].getpixel((0, 0))[0], 180)
                return [[1.0, 0.0]]

            detector._preprocess = preprocess
            detector._decode_boxes = lambda *_: [(100, 50, 40, 50, None, 0.95)]
            detector._get_embeddings = embed
            with patch.object(Image, "MAX_IMAGE_PIXELS", 300_000):
                with self.assertRaises(Image.DecompressionBombError):
                    Image.open(source)
                faces = detector.detect(str(source))
                self.assertEqual(Image.MAX_IMAGE_PIXELS, 300_000)
            self.assertEqual(faces[0].bbox, [400, 200, 160, 200])


if __name__ == "__main__":
    unittest.main()
