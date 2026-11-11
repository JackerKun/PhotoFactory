"""Local multi-label photo understanding using quantized CLIP ONNX encoders."""

from __future__ import annotations

import os
from collections import defaultdict
from dataclasses import dataclass
from typing import Iterable, List, Sequence

import numpy as np
from PIL import Image, ImageOps

from server import AiTag


@dataclass(frozen=True)
class SemanticLabel:
    category: str
    label: str
    prompt: str


SEMANTIC_LABELS: Sequence[SemanticLabel] = (
    SemanticLabel("人物", "单人肖像", "a portrait photo of one person"),
    SemanticLabel("人物", "自拍", "a selfie photo"),
    SemanticLabel("人物", "合影", "a group photo of people posing together"),
    SemanticLabel("人物", "儿童", "a photo of a child"),
    SemanticLabel("人物", "婴儿", "a photo of a baby"),
    SemanticLabel("人物", "情侣", "a photo of a couple"),
    SemanticLabel("人物", "人群", "a photo of a crowd of people"),
    SemanticLabel("活动", "聚会", "a party celebration"),
    SemanticLabel("活动", "婚礼", "a wedding ceremony"),
    SemanticLabel("活动", "毕业", "a graduation ceremony"),
    SemanticLabel("活动", "生日", "a birthday celebration"),
    SemanticLabel("活动", "演出", "a live stage performance"),
    SemanticLabel("活动", "音乐会", "a music concert"),
    SemanticLabel("活动", "会议", "a business meeting"),
    SemanticLabel("活动", "工作", "a person working"),
    SemanticLabel("活动", "购物", "people shopping"),
    SemanticLabel("活动", "旅行", "people traveling on vacation"),
    SemanticLabel("活动", "徒步", "people hiking outdoors"),
    SemanticLabel("活动", "露营", "a camping trip"),
    SemanticLabel("活动", "跑步", "a person running"),
    SemanticLabel("活动", "骑行", "a person riding a bicycle"),
    SemanticLabel("活动", "游泳", "a person swimming"),
    SemanticLabel("活动", "滑雪", "a person skiing"),
    SemanticLabel("活动", "球类运动", "people playing a ball sport"),
    SemanticLabel("活动", "用餐", "people eating a meal"),
    SemanticLabel("活动", "烹饪", "a person cooking food"),
    SemanticLabel("动物", "猫", "a photo of a cat"),
    SemanticLabel("动物", "狗", "a photo of a dog"),
    SemanticLabel("动物", "鸟", "a photo of a bird"),
    SemanticLabel("动物", "马", "a photo of a horse"),
    SemanticLabel("动物", "野生动物", "a photo of a wild animal"),
    SemanticLabel("食物", "餐食", "a photo of a meal or food"),
    SemanticLabel("食物", "甜点", "a photo of dessert"),
    SemanticLabel("食物", "蛋糕", "a photo of a cake"),
    SemanticLabel("食物", "水果", "a photo of fresh fruit"),
    SemanticLabel("食物", "咖啡", "a cup of coffee"),
    SemanticLabel("食物", "茶", "a cup of tea"),
    SemanticLabel("食物", "酒饮", "wine beer or an alcoholic drink"),
    SemanticLabel("交通", "汽车", "a photo of a car"),
    SemanticLabel("交通", "公交车", "a photo of a bus"),
    SemanticLabel("交通", "火车", "a photo of a train"),
    SemanticLabel("交通", "飞机", "a photo of an airplane"),
    SemanticLabel("交通", "船", "a photo of a boat or ship"),
    SemanticLabel("交通", "自行车", "a photo of a bicycle"),
    SemanticLabel("交通", "摩托车", "a photo of a motorcycle"),
    SemanticLabel("物品", "花卉", "a close photo of flowers"),
    SemanticLabel("物品", "书籍", "a photo of books"),
    SemanticLabel("物品", "文档", "a document or printed paper"),
    SemanticLabel("物品", "手机", "a smartphone"),
    SemanticLabel("物品", "电脑", "a computer or laptop"),
    SemanticLabel("物品", "艺术品", "a painting sculpture or artwork"),
    SemanticLabel("物品", "玩具", "a children's toy"),
    SemanticLabel("物品", "标牌文字", "a sign with prominent text"),
    SemanticLabel("自然", "山景", "a mountain landscape"),
    SemanticLabel("自然", "海滩", "a beach by the ocean"),
    SemanticLabel("自然", "海洋", "the ocean or sea"),
    SemanticLabel("自然", "森林", "a forest with trees"),
    SemanticLabel("自然", "湖泊", "a lake landscape"),
    SemanticLabel("自然", "河流", "a river landscape"),
    SemanticLabel("自然", "瀑布", "a waterfall"),
    SemanticLabel("自然", "草地", "a grassy field or meadow"),
    SemanticLabel("自然", "雪景", "a snowy landscape"),
    SemanticLabel("自然", "日落", "a colorful sunset"),
    SemanticLabel("自然", "夜空", "the night sky with stars"),
    SemanticLabel("天气", "雨天", "a rainy day"),
    SemanticLabel("天气", "雾", "a foggy misty scene"),
    SemanticLabel("天气", "蓝天", "a clear blue sky"),
    SemanticLabel("建筑", "城市建筑", "urban buildings and city architecture"),
    SemanticLabel("建筑", "古建筑", "traditional historical architecture"),
    SemanticLabel("建筑", "室内家居", "the interior of a home"),
    SemanticLabel("建筑", "餐厅", "the interior of a restaurant"),
    SemanticLabel("建筑", "办公室", "an office workspace"),
    SemanticLabel("建筑", "校园", "a school or university campus"),
)


def _normalize(values: np.ndarray) -> np.ndarray:
    denominator = np.linalg.norm(values, axis=-1, keepdims=True)
    return values / np.clip(denominator, 1e-12, None)


def select_semantic_tags(
    scores: Sequence[float],
    labels: Sequence[SemanticLabel] = SEMANTIC_LABELS,
    threshold: float = 0.235,
    max_tags: int = 8,
) -> List[AiTag]:
    """Select a diverse set of reliable tags from CLIP cosine similarities."""
    ranked = sorted(zip(scores, labels), key=lambda item: item[0], reverse=True)
    per_category: dict[str, int] = defaultdict(int)
    selected: List[AiTag] = []
    for raw_score, item in ranked:
        score = float(raw_score)
        if score < threshold:
            break
        if per_category[item.category] >= 2:
            continue
        confidence = min(0.99, max(0.0, (score - 0.18) / 0.18))
        selected.append(
            AiTag(
                label=item.label,
                confidence=confidence,
                category=item.category,
                tag_type="ai_semantic",
            )
        )
        per_category[item.category] += 1
        if len(selected) >= max_tags:
            break
    return selected


class SemanticClassifier:
    def __init__(self, models_dir: str | None = None):
        from tokenizers import Tokenizer

        models_dir = models_dir or os.environ.get(
            "AI_MODELS_DIR", os.path.join(os.path.dirname(__file__), "models")
        )
        vision_path = os.path.join(models_dir, "clip_vision_int8.onnx")
        text_path = os.path.join(models_dir, "clip_text_int8.onnx")
        tokenizer_path = os.path.join(models_dir, "clip_tokenizer.json")
        missing = [path for path in (vision_path, text_path, tokenizer_path) if not os.path.isfile(path)]
        if missing:
            raise FileNotFoundError("Semantic model is not installed: " + ", ".join(missing))

        from inference_runtime import InferenceModel
        # Quantized CLIP uses the CPU kernels on macOS; Windows and CUDA
        # can try the accelerator, with per-model CPU fallback.
        import sys
        self.vision = InferenceModel("semantic_vision", vision_path, accelerate=sys.platform != "darwin")
        self.text = InferenceModel("semantic_text", text_path, accelerate=False)

        tokenizer = Tokenizer.from_file(tokenizer_path)
        tokenizer.enable_truncation(max_length=77)
        tokenizer.enable_padding(length=77, pad_id=49407, pad_token="<|endoftext|>")
        encodings = tokenizer.encode_batch([item.prompt for item in SEMANTIC_LABELS])
        ids = np.asarray([encoding.ids for encoding in encodings], dtype=np.int64)
        masks = np.asarray([encoding.attention_mask for encoding in encodings], dtype=np.int64)
        text_inputs = {item.name for item in self.text.get_inputs()}
        feeds = {"input_ids": ids}
        if "attention_mask" in text_inputs:
            feeds["attention_mask"] = masks
        self.text_embeddings = _normalize(self._run_embedding(self.text, feeds, "text_embeds"))

    @staticmethod
    def _run_embedding(session, feeds: dict[str, np.ndarray], preferred_name: str) -> np.ndarray:
        output_names = [output.name for output in session.get_outputs()]
        values = session.run(None, feeds)
        if preferred_name in output_names:
            return np.asarray(values[output_names.index(preferred_name)], dtype=np.float32)
        for value in reversed(values):
            array = np.asarray(value)
            if array.ndim == 2 and array.shape[-1] >= 128:
                return array.astype(np.float32)
        raise RuntimeError(f"No embedding output found in {output_names}")

    @staticmethod
    def _preprocess(image: Image.Image) -> np.ndarray:
        image = ImageOps.fit(image.convert("RGB"), (224, 224), method=Image.Resampling.BICUBIC)
        array = np.asarray(image, dtype=np.float32) / 255.0
        mean = np.asarray([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
        std = np.asarray([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)
        array = (array - mean) / std
        return np.transpose(array, (2, 0, 1))[None, ...]

    def classify_image(self, image: Image.Image) -> List[AiTag]:
        pixel_values = self._preprocess(image)
        input_name = self.vision.get_inputs()[0].name
        image_embedding = _normalize(
            self._run_embedding(self.vision, {input_name: pixel_values}, "image_embeds")
        )
        scores = image_embedding @ self.text_embeddings.T
        return select_semantic_tags(scores[0])

    def classify(self, image_path: str) -> List[AiTag]:
        with Image.open(image_path) as image:
            return self.classify_image(image)
