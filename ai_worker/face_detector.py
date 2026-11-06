# ai_worker/face_detector.py
"""Face detection and embedding extraction using ONNX Runtime."""

import os
import sys
import math
from typing import List, Optional, Tuple
import numpy as np
from PIL import Image

# Allow running both as module and script
sys.path.insert(0, os.path.dirname(__file__))
from server import DetectedFace


class FaceDetector:
    """Wraps RetinaFace (detection) and ArcFace (embedding) ONNX models."""

    _INPUT_SIZE = 640
    # 0.3 produced many shoulders, mouths and background textures in People.
    # A moderately conservative floor gives ArcFace substantially cleaner input.
    _SCORE_THRESHOLD = 0.55
    _NMS_THRESHOLD = 0.4
    # RetinaFace-MobileNet0.25 anchor config for 640x640
    _MIN_SIZES = [[16, 32], [64, 128], [256, 512]]
    _STEPS = [8, 16, 32]
    _VARIANCE = [0.1, 0.2]  # Standard RetinaFace variance

    def __init__(self, det_model_path: Optional[str] = None, rec_model_path: Optional[str] = None):
        import onnxruntime as ort
        models_dir = os.environ.get(
            "AI_MODELS_DIR", os.path.join(os.path.dirname(__file__), "models")
        )
        det_path = det_model_path or os.path.join(models_dir, "retinaface.onnx")
        rec_path = rec_model_path or os.path.join(models_dir, "arcface.onnx")

        if not os.path.exists(det_path):
            raise FileNotFoundError(f"RetinaFace model not found at {det_path}. Run download_models.py first.")
        if not os.path.exists(rec_path):
            raise FileNotFoundError(f"ArcFace model not found at {rec_path}. Run download_models.py first.")

        # Use CoreML on macOS for near-zero CPU usage; fall back to CPU with limited threads
        providers = ["CoreMLExecutionProvider", "CPUExecutionProvider"]
        session_options = ort.SessionOptions()
        thread_count = int(os.environ.get(
            "PHOTFACTORY_AI_THREADS", max(2, min(6, (os.cpu_count() or 4) // 2))
        ))
        session_options.inter_op_num_threads = max(1, min(2, thread_count // 2))
        session_options.intra_op_num_threads = thread_count
        try:
            self.det_session = ort.InferenceSession(det_path, sess_options=session_options, providers=providers)
            self.rec_session = ort.InferenceSession(rec_path, sess_options=session_options, providers=providers)
        except Exception as exc:
            # CoreML can be present but unavailable (for example, if its model-cache
            # directory cannot be created). ONNX Runtime does not automatically retry
            # session construction with the next provider in that case.
            print(f"CoreML initialization failed; using bounded CPU inference: {exc}", flush=True)
            self.det_session = ort.InferenceSession(
                det_path, sess_options=session_options, providers=["CPUExecutionProvider"]
            )
            self.rec_session = ort.InferenceSession(
                rec_path, sess_options=session_options, providers=["CPUExecutionProvider"]
            )
        self.det_input_name = self.det_session.get_inputs()[0].name
        self.rec_input_name = self.rec_session.get_inputs()[0].name
        rec_batch = self.rec_session.get_inputs()[0].shape[0]
        self.rec_supports_batch = not isinstance(rec_batch, int) or rec_batch != 1

        # Pre-compute anchors
        self._anchors = self._create_anchors()

    def _create_anchors(self) -> np.ndarray:
        """Create prior boxes (anchors) for 640x640 input."""
        anchors = []
        for k, (min_sizes, step) in enumerate(zip(self._MIN_SIZES, self._STEPS)):
            feature_size = self._INPUT_SIZE // step
            for sy in range(feature_size):
                for sx in range(feature_size):
                    for min_size in min_sizes:
                        # Center of anchor
                        cx = (sx + 0.5) * step
                        cy = (sy + 0.5) * step
                        # Anchor width/height
                        w = h = min_size
                        anchors.append([cx, cy, w, h])
        return np.array(anchors, dtype=np.float32)

    def detect(self, image_path: str) -> List[DetectedFace]:
        """Detect faces and return bounding boxes with embeddings."""
        source = Image.open(image_path)
        source_w, source_h = source.size
        # JPEG decoders can discard high-frequency blocks while decoding. This
        # avoids materializing a 40–100 MP frame when detection only needs 640px.
        source.draft("RGB", (self._INPUT_SIZE, self._INPUT_SIZE))
        image = source.convert("RGB")
        orig_w, orig_h = image.size
        output_scale_x = source_w / max(orig_w, 1)
        output_scale_y = source_h / max(orig_h, 1)

        # Preprocess
        inp, scale, pad_x, pad_y = self._preprocess(image)

        # Run detection
        det_outputs = self.det_session.run(None, {self.det_input_name: inp})

        # Decode boxes
        boxes = self._decode_boxes(det_outputs, scale, pad_x, pad_y, orig_w, orig_h)

        prepared = []
        for x, y, w, h, landmarks, score in boxes:
            face_crop = self._align_face(image, landmarks)
            alignment_success = face_crop is not None
            if face_crop is None:
                face_crop = image.crop((
                    max(0, x), max(0, y),
                    min(orig_w, x + w), min(orig_h, y + h)
                ))
            yaw, pitch, roll = self._estimate_pose(landmarks)
            quality = self._quality_score(
                face_crop, score, int(w * output_scale_x), int(h * output_scale_y),
                yaw, pitch, roll, alignment_success
            )
            output_landmarks = None if landmarks is None else np.asarray(landmarks) * np.array([output_scale_x, output_scale_y])
            prepared.append((
                face_crop, int(x * output_scale_x), int(y * output_scale_y),
                int(w * output_scale_x), int(h * output_scale_y), output_landmarks,
                score, quality, yaw, pitch, roll, alignment_success
            ))
        embeddings = self._get_embeddings([item[0] for item in prepared])
        results = []
        for item, embedding in zip(prepared, embeddings):
            _, x, y, w, h, landmarks, score, quality, yaw, pitch, roll, alignment_success = item
            results.append(DetectedFace(
                bbox=[x, y, w, h],
                embedding=embedding,
                confidence=score,
                quality_score=quality,
                landmarks=(np.asarray(landmarks).reshape(-1).tolist() if landmarks is not None else []),
                pose_yaw=yaw,
                pose_pitch=pitch,
                pose_roll=roll,
                alignment_success=alignment_success,
            ))
        return results

    def _estimate_pose(self, landmarks) -> Tuple[float, float, float]:
        if landmarks is None or np.asarray(landmarks).shape != (5, 2):
            return 0.0, 0.0, 0.0
        points = np.asarray(landmarks, dtype=np.float32)
        left_eye, right_eye, nose, left_mouth, right_mouth = points
        eye_mid = (left_eye + right_eye) / 2.0
        mouth_mid = (left_mouth + right_mouth) / 2.0
        eye_distance = max(float(np.linalg.norm(right_eye - left_eye)), 1.0)
        yaw = float(np.clip((nose[0] - eye_mid[0]) / eye_distance * 60.0, -60.0, 60.0))
        expected_nose_y = eye_mid[1] + (mouth_mid[1] - eye_mid[1]) * 0.52
        pitch = float(np.clip((nose[1] - expected_nose_y) / eye_distance * 70.0, -45.0, 45.0))
        roll = float(math.degrees(math.atan2(
            right_eye[1] - left_eye[1], right_eye[0] - left_eye[0]
        )))
        return yaw, pitch, roll

    def _quality_score(
        self, face: Image.Image, confidence: float, width: int, height: int,
        yaw: float, pitch: float, roll: float, aligned: bool,
    ) -> float:
        gray = np.asarray(face.convert("L"), dtype=np.float32) / 255.0
        gx = np.diff(gray, axis=1)
        gy = np.diff(gray, axis=0)
        sharpness = min(1.0, float(gx.var() + gy.var()) / 0.025)
        size_score = min(1.0, min(width, height) / 160.0)
        pose_score = max(0.0, 1.0 - (abs(yaw) / 70.0 + abs(pitch) / 55.0 + abs(roll) / 90.0) / 3.0)
        score = (
            0.38 * float(confidence)
            + 0.25 * sharpness
            + 0.17 * size_score
            + 0.15 * pose_score
            + 0.05 * float(aligned)
        )
        return float(np.clip(score, 0.0, 1.0))

    def _preprocess(self, image: Image.Image) -> tuple:
        orig_w, orig_h = image.size
        size = self._INPUT_SIZE
        scale = size / max(orig_w, orig_h)
        new_w, new_h = int(orig_w * scale), int(orig_h * scale)
        resized = image.resize((new_w, new_h), Image.LANCZOS)
        pad_w = size - new_w
        pad_h = size - new_h
        padded = Image.new("RGB", (size, size), (0, 0, 0))
        padded.paste(resized, (pad_w // 2, pad_h // 2))
        # Raw 0-255 float (this model expects unnormalized input)
        arr = np.array(padded, dtype=np.float32)
        arr = np.transpose(arr, (2, 0, 1))[np.newaxis, ...]
        return arr, scale, pad_w // 2, pad_h // 2

    def _decode_boxes(
        self,
        outputs: List[np.ndarray],
        scale: float,
        pad_x: int,
        pad_y: int,
        orig_w: int,
        orig_h: int,
    ) -> list:
        """Decode RetinaFace output using pre-computed anchors."""
        bbox_deltas = outputs[0]   # [1, N, 4]
        conf = outputs[1]          # [1, N, 2]
        raw_landmarks = outputs[2] if len(outputs) > 2 else None
        scores = conf[0, :, 1]

        anchors = self._anchors[:bbox_deltas.shape[1]]
        if len(anchors) != bbox_deltas.shape[1]:
            # Fallback: regenerate anchors if mismatch
            print(f"Warning: anchor count mismatch ({len(anchors)} vs {bbox_deltas.shape[1]})")
            return []

        # Decode: the model uses variance-scaled deltas
        # box_center = anchor_center + delta * variance * anchor_size
        # box_size = anchor_size * exp(delta * variance)
        cx = anchors[:, 0] + bbox_deltas[0, :, 0] * self._VARIANCE[0] * anchors[:, 2]
        cy = anchors[:, 1] + bbox_deltas[0, :, 1] * self._VARIANCE[0] * anchors[:, 3]
        w = anchors[:, 2] * np.exp(bbox_deltas[0, :, 2] * self._VARIANCE[1])
        h = anchors[:, 3] * np.exp(bbox_deltas[0, :, 3] * self._VARIANCE[1])

        decoded_landmarks = None
        if raw_landmarks is not None and raw_landmarks.shape[-1] >= 10:
            decoded_landmarks = np.empty((len(anchors), 5, 2), dtype=np.float32)
            for point in range(5):
                decoded_landmarks[:, point, 0] = (
                    anchors[:, 0]
                    + raw_landmarks[0, :, point * 2] * self._VARIANCE[0] * anchors[:, 2]
                )
                decoded_landmarks[:, point, 1] = (
                    anchors[:, 1]
                    + raw_landmarks[0, :, point * 2 + 1] * self._VARIANCE[0] * anchors[:, 3]
                )

        # Convert to x1, y1, w, h format
        x1 = cx - w / 2
        y1 = cy - h / 2

        boxes_with_scores = []
        for i in range(len(scores)):
            # Very small detections in the 640px model input do not contain
            # enough identity information even when their original image was huge.
            if scores[i] >= self._SCORE_THRESHOLD and w[i] >= 20 and h[i] >= 20:
                ox1 = int((x1[i] - pad_x) / scale)
                oy1 = int((y1[i] - pad_y) / scale)
                ow = int(w[i] / scale)
                oh = int(h[i] / scale)
                if ow > 20 and oh > 20:
                    ox1 = max(0, min(ox1, orig_w - 1))
                    oy1 = max(0, min(oy1, orig_h - 1))
                    ow = min(ow, orig_w - ox1)
                    oh = min(oh, orig_h - oy1)
                    if ow > 20 and oh > 20:
                        landmarks = None
                        if decoded_landmarks is not None:
                            landmarks = decoded_landmarks[i].copy()
                            landmarks[:, 0] = (landmarks[:, 0] - pad_x) / scale
                            landmarks[:, 1] = (landmarks[:, 1] - pad_y) / scale
                        boxes_with_scores.append(
                            (ox1, oy1, ow, oh, float(scores[i]), landmarks)
                        )

        if boxes_with_scores:
            boxes_with_scores = self._nms(boxes_with_scores)

        return [
            (x, y, bw, bh, landmarks, score)
            for x, y, bw, bh, score, landmarks in boxes_with_scores
        ]

    def _nms(self, boxes, iou_threshold=None):
        if iou_threshold is None:
            iou_threshold = self._NMS_THRESHOLD
        boxes = sorted(boxes, key=lambda b: b[4], reverse=True)
        keep = []
        while boxes:
            best = boxes.pop(0)
            keep.append(best)
            boxes = [b for b in boxes if self._iou((best[0], best[1], best[2], best[3]), (b[0], b[1], b[2], b[3])) < iou_threshold]
        return keep

    def _align_face(self, image: Image.Image, landmarks) -> Optional[Image.Image]:
        """Align eyes, nose and mouth corners to ArcFace's reference geometry."""
        if landmarks is None or np.asarray(landmarks).shape != (5, 2):
            return None
        source = np.asarray(landmarks, dtype=np.float32)
        if not np.all(np.isfinite(source)):
            return None
        # Reject unstable landmark predictions before they poison an embedding.
        if np.linalg.norm(source[0] - source[1]) < 4.0:
            return None
        destination = np.array([
            [38.2946, 51.6963],
            [73.5318, 51.5014],
            [56.0252, 71.7366],
            [41.5493, 92.3655],
            [70.7299, 92.2041],
        ], dtype=np.float32)
        # Solve the least-squares similarity transform:
        # dx = a*sx - b*sy + tx; dy = b*sx + a*sy + ty.
        system = []
        target = []
        for (sx, sy), (dx, dy) in zip(source, destination):
            system.append([sx, -sy, 1.0, 0.0])
            target.append(dx)
            system.append([sy, sx, 0.0, 1.0])
            target.append(dy)
        try:
            a, b, tx, ty = np.linalg.lstsq(
                np.asarray(system, dtype=np.float64),
                np.asarray(target, dtype=np.float64),
                rcond=None,
            )[0]
            forward = np.array([
                [a, -b, tx],
                [b, a, ty],
                [0.0, 0.0, 1.0],
            ])
            inverse = np.linalg.inv(forward)
        except np.linalg.LinAlgError:
            return None
        return image.transform(
            (112, 112),
            Image.Transform.AFFINE,
            data=tuple(inverse[:2].reshape(-1)),
            resample=Image.Resampling.BILINEAR,
        )

    def _iou(self, a, b) -> float:
        ax1, ay1, aw, ah = a
        bx1, by1, bw, bh = b
        ax2, ay2 = ax1 + aw, ay1 + ah
        bx2, by2 = bx1 + bw, by1 + bh
        inter_x1 = max(ax1, bx1)
        inter_y1 = max(ay1, by1)
        inter_x2 = min(ax2, bx2)
        inter_y2 = min(ay2, by2)
        inter_w = max(0, inter_x2 - inter_x1)
        inter_h = max(0, inter_y2 - inter_y1)
        inter_area = inter_w * inter_h
        union = aw * ah + bw * bh - inter_area
        return inter_area / union if union > 0 else 0.0

    def _get_embedding(self, face_image: Image.Image) -> List[float]:
        """Get ArcFace embedding for a cropped face."""
        return self._get_embeddings([face_image])[0]

    def _prepare_embedding_input(self, face_image: Image.Image) -> np.ndarray:
        face_resized = face_image.resize((112, 112), Image.LANCZOS)
        arr = np.array(face_resized, dtype=np.float32) / 255.0
        arr = arr[:, :, ::-1]  # RGB to BGR
        arr = (arr - 0.5) / 0.5
        return np.transpose(arr, (2, 0, 1))[np.newaxis, ...]

    def _get_embeddings(self, face_images: List[Image.Image]) -> List[List[float]]:
        if not face_images:
            return []
        prepared = [self._prepare_embedding_input(image) for image in face_images]
        if self.rec_supports_batch and len(prepared) > 1:
            batches = [np.concatenate(prepared, axis=0)]
        else:
            batches = prepared
        embeddings = []
        for batch in batches:
            output = self.rec_session.run(None, {self.rec_input_name: batch})[0]
            for vector in output:
                norm = float(np.linalg.norm(vector))
                embeddings.append((vector / norm if norm > 0 else vector).tolist())
        return embeddings
