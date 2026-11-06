"""Download and validate the ONNX models used by PhotoFactory.

The Places365 source model is stored as ONNX external data. This script
downloads both files and consolidates them into the single
``resnet50_places365.onnx`` file expected by the packaged application.
Existing valid models are kept, so this command is safe on every build.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODELS_DIR = ROOT / "models"

SINGLE_FILE_MODELS = {
    "retinaface.onnx": {
        "url": "https://huggingface.co/TheEeeeLin/HivisionIDPhotos_matting/resolve/main/retinaface-resnet50.onnx",
        "minimum_bytes": 50 * 1024 * 1024,
    },
    "arcface.onnx": {
        "url": "https://huggingface.co/facefusion/models-3.0.0/resolve/main/arcface_w600k_r50.onnx",
        "minimum_bytes": 100 * 1024 * 1024,
    },
    "clip_vision_int8.onnx": {
        "url": "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_int8.onnx",
        "minimum_bytes": 75 * 1024 * 1024,
    },
    "clip_text_int8.onnx": {
        "url": "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/text_model_int8.onnx",
        "minimum_bytes": 55 * 1024 * 1024,
    },
}

MODEL_ASSETS = {
    "clip_tokenizer.json": {
        "url": "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/tokenizer.json",
        "minimum_bytes": 1 * 1024 * 1024,
    },
}

PLACES_GRAPH_URL = (
    "https://huggingface.co/kakilangit/resnet50places365/resolve/main/"
    "resnet50_places365_official.onnx"
)
PLACES_DATA_URL = f"{PLACES_GRAPH_URL}.data"


def download(url: str, destination: Path) -> None:
    partial = destination.with_suffix(destination.suffix + ".part")
    partial.unlink(missing_ok=True)
    print(f"  downloading {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "PhotoFactory/0.1"})
    with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as output:
        shutil.copyfileobj(response, output, length=1024 * 1024)
    partial.replace(destination)


def validate_onnx(path: Path, minimum_bytes: int) -> bool:
    if not path.is_file() or path.stat().st_size < minimum_bytes:
        return False
    try:
        try:
            import onnx
            model = onnx.load(str(path), load_external_data=False)
            onnx.checker.check_model(model, full_check=False)
        except ImportError:
            import onnxruntime as ort
            options = ort.SessionOptions()
            options.inter_op_num_threads = 1
            options.intra_op_num_threads = 1
            ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])
        return True
    except Exception as error:
        print(f"  invalid {path.name}: {error}")
        return False


def ensure_single_file_model(name: str, url: str, minimum_bytes: int) -> None:
    destination = MODELS_DIR / name
    if validate_onnx(destination, minimum_bytes):
        print(f"  ok {name} ({destination.stat().st_size / 1024 / 1024:.1f} MB)")
        return
    destination.unlink(missing_ok=True)
    download(url, destination)
    if not validate_onnx(destination, minimum_bytes):
        destination.unlink(missing_ok=True)
        raise RuntimeError(f"Downloaded model is not a valid ONNX file: {name}")
    print(f"  ready {name} ({destination.stat().st_size / 1024 / 1024:.1f} MB)")


def ensure_asset(name: str, url: str, minimum_bytes: int) -> None:
    destination = MODELS_DIR / name
    if destination.is_file() and destination.stat().st_size >= minimum_bytes:
        print(f"  ok {name} ({destination.stat().st_size / 1024 / 1024:.1f} MB)")
        return
    destination.unlink(missing_ok=True)
    download(url, destination)
    if destination.stat().st_size < minimum_bytes:
        destination.unlink(missing_ok=True)
        raise RuntimeError(f"Downloaded model asset is invalid: {name}")
    print(f"  ready {name} ({destination.stat().st_size / 1024 / 1024:.1f} MB)")


def ensure_places365() -> None:
    destination = MODELS_DIR / "resnet50_places365.onnx"
    if validate_onnx(destination, 80 * 1024 * 1024):
        print(f"  ok {destination.name} ({destination.stat().st_size / 1024 / 1024:.1f} MB)")
        return

    destination.unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(prefix="photofactory-places365-") as temp_dir:
        temp = Path(temp_dir)
        graph = temp / "resnet50_places365_official.onnx"
        data = temp / "resnet50_places365_official.onnx.data"
        download(PLACES_GRAPH_URL, graph)
        download(PLACES_DATA_URL, data)
        print("  consolidating Places365 external data...")
        import onnx
        model = onnx.load(str(graph), load_external_data=True)
        onnx.checker.check_model(model, full_check=False)
        onnx.save_model(model, str(destination), save_as_external_data=False)

    if not validate_onnx(destination, 80 * 1024 * 1024):
        destination.unlink(missing_ok=True)
        raise RuntimeError("Consolidated Places365 model is invalid")
    print(f"  ready {destination.name} ({destination.stat().st_size / 1024 / 1024:.1f} MB)")


def main() -> None:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Checking AI models in {MODELS_DIR}")
    for name, metadata in SINGLE_FILE_MODELS.items():
        ensure_single_file_model(name, metadata["url"], metadata["minimum_bytes"])
    for name, metadata in MODEL_ASSETS.items():
        ensure_asset(name, metadata["url"], metadata["minimum_bytes"])
    ensure_places365()
    print("All AI models are ready.")


if __name__ == "__main__":
    main()
