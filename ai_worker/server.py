"""PhotoFactory AI Worker - HTTP server for face detection and scene classification."""

import os
import time
import sys
import subprocess
import tempfile
from threading import Lock
from concurrent.futures import ThreadPoolExecutor
from typing import List, Dict, Optional, Tuple

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
import numpy as np
import uvicorn

RAW_EXTENSIONS = {".arw", ".cr2", ".nef", ".dng", ".raw", ".orf", ".rw2", ".pef"}
HEIF_EXTENSIONS = {".heic", ".heif"}


def _convert_for_ai(path: str) -> str | None:
    """Return a temporary JPEG for formats Pillow cannot reliably decode.

    HEIF uses pillow-heif on every supported platform and falls back to macOS
    ImageIO through ``sips``. RAW files continue to use rawpy first. Returning
    ``None`` means the original path is already directly readable.
    """
    ext = os.path.splitext(path)[1].lower()
    if ext not in RAW_EXTENSIONS and ext not in HEIF_EXTENSIONS:
        return None

    tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
    tmp.close()

    if ext in HEIF_EXTENSIONS:
        try:
            from pillow_heif import register_heif_opener
            from PIL import Image

            register_heif_opener()
            with Image.open(path) as image:
                image.convert("RGB").save(tmp.name, "JPEG", quality=90)
            if os.path.getsize(tmp.name) > 0:
                return tmp.name
        except Exception as e:
            print(f"HEIF conversion failed for {path}: {e}", flush=True)
    else:
        # rawpy is cross-platform and uses libraw for camera RAW formats.
        try:
            import rawpy
            with rawpy.imread(path) as raw:
                rgb = raw.postprocess()
            from PIL import Image
            Image.fromarray(rgb).save(tmp.name, "JPEG", quality=90)
            if os.path.getsize(tmp.name) > 0:
                return tmp.name
        except Exception as e:
            print(f"rawpy conversion failed for {path}: {e}", flush=True)

    # Fallback to macOS sips
    if sys.platform == "darwin":
        try:
            result = subprocess.run(
                ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "90", path, "-o", tmp.name],
                capture_output=True, timeout=30,
            )
            if result.returncode == 0 and os.path.exists(tmp.name):
                return tmp.name
        except Exception as e:
            print(f"sips conversion failed for {path}: {e}", flush=True)

    if os.path.exists(tmp.name):
        os.unlink(tmp.name)
    raise RuntimeError(f"Unable to decode {ext or 'image'} file: {path}")

# Ensure we can find sibling modules when running as `python server.py`
sys.path.insert(0, os.path.dirname(__file__))

app = FastAPI(title="PhotoFactory AI Worker")

# --- Pydantic models ---

class ClassifyRequest(BaseModel):
    paths: List[str]
    model: str = "scene_v2"

class AiTag(BaseModel):
    label: str
    confidence: float
    category: str = "场景"
    tag_type: str = "ai_scene"

class ClassifyResult(BaseModel):
    path: str
    tags: List[AiTag]
    error: Optional[str] = None

class ClassifyResponse(BaseModel):
    results: List[ClassifyResult]

class DetectFacesRequest(BaseModel):
    paths: List[str]
    cache_dir: str = ""  # If provided, save embeddings to disk and return paths
    previews: Dict[str, str] = Field(default_factory=dict)

class DetectedFace(BaseModel):
    bbox: List[int]
    embedding: List[float] = []
    embedding_path: str = ""
    confidence: float = 0.0
    quality_score: float = 0.0
    landmarks: List[float] = []
    pose_yaw: float = 0.0
    pose_pitch: float = 0.0
    pose_roll: float = 0.0
    alignment_success: bool = False

class FaceResult(BaseModel):
    path: str
    faces: List[DetectedFace]
    error: Optional[str] = None

class DetectFacesResponse(BaseModel):
    results: List[FaceResult]

class ClusterFaceRequest(BaseModel):
    embeddings_dir: str  # Directory containing new .npy embedding files
    existing_clusters: Dict[str, List[List[float]]]  # {cluster_id: [embeddings]}
    threshold: float = 0.6

class ClusterAssignment(BaseModel):
    embedding_file: str
    cluster_id: int  # -1 means new cluster
    is_new_cluster: bool = False

class ClusterFaceResponse(BaseModel):
    assignments: List[ClusterAssignment]

class ClusterFacesV2Request(BaseModel):
    embeddings_dir: str
    existing_clusters: Optional[Dict[str, int]] = None
    threshold: Optional[float] = 0.6
    must_links: Optional[List[Tuple[int, int]]] = None
    cannot_links: Optional[List[Tuple[int, int]]] = None
    candidate_files: Optional[List[str]] = None
    memberships: Optional[Dict[str, int]] = None
    qualities: Optional[Dict[str, float]] = None

class AutomaticMergeRequest(BaseModel):
    embeddings_dir: str
    unnamed_clusters: Dict[str, int]
    threshold: float = 0.72
    cannot_links: Optional[List[Tuple[int, int]]] = None

class FaceQualityRequest(BaseModel):
    embedding_path: str
    all_embedding_paths: List[str]

class HealthResponse(BaseModel):
    status: str

_last_face_batch = {}
_last_cluster_ms = None

@app.get("/runtime")
async def runtime_info():
    from inference_runtime import available_providers, loaded_providers
    return {"available": available_providers(), "models": loaded_providers(),
            "face_batch": _last_face_batch, "cluster_ms": _last_cluster_ms}

# --- Lazy model loading ---

_face_detector = None
_scene_classifier = None
_semantic_classifier = None
_semantic_unavailable = False


def _check_models():
    """Check if ONNX model files exist."""
    models_dir = os.environ.get(
        "AI_MODELS_DIR", os.path.join(os.path.dirname(__file__), "models")
    )
    required = ["retinaface.onnx", "arcface.onnx", "resnet50_places365.onnx"]
    missing = [f for f in required if not os.path.exists(os.path.join(models_dir, f))]
    if missing:
        raise RuntimeError(
            f"Missing model files: {', '.join(missing)}. "
            f"Run 'python download_models.py' first."
        )


_face_detector_lock = Lock()


def load_face_detector():
    global _face_detector
    with _face_detector_lock:
        if _face_detector is None:
            _check_models()
            from face_detector import FaceDetector
            _face_detector = FaceDetector()
            print("Face detector loaded", flush=True)
        return _face_detector


_scene_classifier_lock = Lock()


def load_scene_classifier():
    global _scene_classifier
    with _scene_classifier_lock:
        if _scene_classifier is None:
            _check_models()
            from scene_classifier import SceneClassifier
            _scene_classifier = SceneClassifier()
            print("Scene classifier loaded", flush=True)
        return _scene_classifier


_semantic_classifier_lock = Lock()


def load_semantic_classifier():
    """Load optional CLIP semantics without making legacy classification fail."""
    global _semantic_classifier, _semantic_unavailable
    with _semantic_classifier_lock:
        if _semantic_classifier is None and not _semantic_unavailable:
            try:
                from semantic_classifier import SemanticClassifier
                _semantic_classifier = SemanticClassifier()
                print("Semantic classifier loaded", flush=True)
            except Exception as error:
                _semantic_unavailable = True
                print(f"Semantic classifier unavailable; continuing with scene labels: {error}", flush=True)
        return _semantic_classifier


# --- Endpoints ---

@app.get("/health")
async def health() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/classify")
def classify(req: ClassifyRequest) -> ClassifyResponse:
    from image_input import open_ai_image

    try:
        classifier = load_scene_classifier()
        semantic_classifier = load_semantic_classifier()
        results = []
        total = len(req.paths)
        for idx, path in enumerate(req.paths):
            if not os.path.exists(path):
                print(f"  [{idx+1}/{total}] skip (not found): {path}", flush=True)
                results.append(ClassifyResult(path=path, tags=[], error="file not found"))
                continue
            jpeg_path = None
            try:
                jpeg_path = _convert_for_ai(path)
                process_path = jpeg_path or path
                with open_ai_image(process_path) as (image, _):
                    rgb = image.convert("RGB")
                    tags = classifier.classify_image(rgb)
                    if semantic_classifier is not None:
                        tags.extend(semantic_classifier.classify_image(rgb))
                results.append(ClassifyResult(path=path, tags=[t.model_dump() for t in tags], error=None))
            except Exception as e:
                # A single damaged/unsupported photo must not permanently block
                # the background queue. Keep an empty result and continue.
                print(f"  skip classification for {path}: {e}", flush=True)
                results.append(ClassifyResult(path=path, tags=[], error=str(e)))
            finally:
                if jpeg_path:
                    os.unlink(jpeg_path)
            if (idx + 1) % 10 == 0 or idx + 1 == total:
                print(f"  [{idx+1}/{total}] classified", flush=True)
        print(f"Classification done: {len(results)} results", flush=True)
        return ClassifyResponse(results=results)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/detect_faces")
def detect_faces(req: DetectFacesRequest) -> DetectFacesResponse:
    global _last_face_batch
    start = time.perf_counter()
    try:
        detector = load_face_detector()
        if req.cache_dir:
            os.makedirs(req.cache_dir, exist_ok=True)

        timings = [{} for _ in req.paths]

        def process_photo(item):
            result_index, path = item
            if not os.path.exists(path):
                return FaceResult(path=path, faces=[], error="file not found")
            jpeg_path = None
            try:
                conversion_ms = 0.0
                ext = os.path.splitext(path)[1].lower()
                preview = req.previews.get(path)
                # Decode HEIF directly, so a cached Windows preview can skip
                # opening the full raster for photos with no detected faces.
                # macOS builds those previews with ImageIO, which may rotate
                # them differently. Its HEIF path uses the source alone.
                faces = None
                if ext in HEIF_EXTENSIONS:
                    try:
                        from pillow_heif import register_heif_opener
                        register_heif_opener()
                        faces = detector.detect(path, preview if sys.platform == "win32" else None, timings[result_index])
                    except (OSError, ValueError):
                        pass  # use the existing HEIF conversion/decoder fallback
                if faces is None:
                    conversion_start = time.perf_counter()
                    jpeg_path = _convert_for_ai(path)
                    conversion_ms = 1000 * (time.perf_counter() - conversion_start)
                    faces = detector.detect(jpeg_path or path, None if jpeg_path else preview, timings[result_index])
                timings[result_index]["decode_ms"] += conversion_ms
                face_list = []
                for i, f in enumerate(faces):
                    metadata = f.model_dump(exclude={"embedding", "embedding_path"})
                    if req.cache_dir:
                        embedding_path = os.path.join(req.cache_dir, f"{result_index}_{i}.npy")
                        np.save(embedding_path, np.array(f.embedding, dtype=np.float32))
                        face_list.append({**metadata, "embedding_path": embedding_path})
                    else:
                        face_list.append({**metadata, "embedding": f.embedding})
                return FaceResult(path=path, faces=face_list, error=None)
            except Exception as e:
                # Preserve result ordering (embedding filenames depend on it)
                # and allow later photos in the batch to keep processing.
                print(f"  skip face detection for {path}: {e}", flush=True)
                return FaceResult(path=path, faces=[], error=str(e))
            finally:
                if jpeg_path:
                    os.unlink(jpeg_path)
        try:
            workers = max(1, min(2, int(os.environ.get("PHOTOFACTORY_FACE_WORKERS",
                                                       os.environ.get("PHOTFACTORY_FACE_WORKERS", "2")))))
        except ValueError:
            workers = 2
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="face-ai") as pool:
            results = list(pool.map(process_photo, enumerate(req.paths)))
        _last_face_batch = {key: sum(row.get(key, 0) for row in timings)
                            for key in ("preview_hits", "decode_ms", "detect_ms", "embed_ms")}
        _last_face_batch.update(photos=len(req.paths), elapsed_ms=1000 * (time.perf_counter() - start))
        return DetectFacesResponse(results=results)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/cluster_faces")
async def cluster_faces(req: ClusterFaceRequest) -> ClusterFaceResponse:
    """Match new face embeddings to existing clusters or create new ones."""
    import numpy as np
    from face_clusterer import compute_centroid, cosine_similarity
    from sklearn.cluster import DBSCAN

    files = sorted([f for f in os.listdir(req.embeddings_dir) if f.endswith('.npy')])
    if not files:
        return ClusterFaceResponse(assignments=[])

    # Compute existing cluster centroids
    centroids = {}
    for cluster_id, embeddings in req.existing_clusters.items():
        if embeddings:
            centroids[cluster_id] = np.array(embeddings)

    assignments = []
    unmatched_files = []
    unmatched_vectors = []

    for f in files:
        path = os.path.join(req.embeddings_dir, f)
        embedding = np.load(path)

        # Find best matching cluster
        best_cluster = None
        best_sim = -1
        for cluster_id, centroid in centroids.items():
            sim = cosine_similarity(embedding, centroid)
            if sim > best_sim:
                best_sim = sim
                best_cluster = cluster_id

        if best_cluster is not None and best_sim >= req.threshold:
            assignments.append(ClusterAssignment(
                embedding_file=f,
                cluster_id=int(best_cluster),
                is_new_cluster=False,
            ))
        else:
            unmatched_files.append(f)
            unmatched_vectors.append(embedding)

    # Run DBSCAN on unmatched faces to form new clusters
    if unmatched_files and len(unmatched_files) >= 2:
        X = np.array(unmatched_vectors)
        clustering = DBSCAN(eps=0.6, min_samples=2, metric="cosine").fit(X)
        labels = clustering.labels_
        # Find the max existing cluster ID to start new IDs from
        max_existing_id = max((int(k) for k in req.existing_clusters.keys()), default=-1)
        next_new_id = max_existing_id + 1

        for i, f in enumerate(unmatched_files):
            label = int(labels[i])
            if label == -1:
                # Noise - create its own cluster
                assignments.append(ClusterAssignment(
                    embedding_file=f,
                    cluster_id=next_new_id,
                    is_new_cluster=True,
                ))
                next_new_id += 1
            else:
                # Map DBSCAN label to sequential new cluster ID
                new_cluster_id = next_new_id + label
                assignments.append(ClusterAssignment(
                    embedding_file=f,
                    cluster_id=new_cluster_id,
                    is_new_cluster=True,
                ))
                # Update next_new_id to account for this label
                next_new_id = max(next_new_id, new_cluster_id + 1)
    elif unmatched_files:
        # Single unmatched face - create its own cluster
        max_existing_id = max((int(k) for k in req.existing_clusters.keys()), default=-1)
        assignments.append(ClusterAssignment(
            embedding_file=unmatched_files[0],
            cluster_id=max_existing_id + 1,
            is_new_cluster=True,
        ))

    return ClusterFaceResponse(assignments=assignments)


@app.post("/cluster_faces_v2")
def cluster_faces_v2(req: ClusterFacesV2Request):
    """Enhanced clustering with adaptive eps and constraints."""
    from face_clusterer import cluster_faces_v2 as cluster_v2

    embeddings_dir = req.embeddings_dir
    if not os.path.exists(embeddings_dir):
        raise HTTPException(status_code=400, detail=f"Embeddings dir not found: {embeddings_dir}")

    print(f"[cluster_faces_v2] Starting clustering for {embeddings_dir}...", flush=True)
    global _last_cluster_ms
    start = time.perf_counter()
    review_files = []
    results = cluster_v2(
        embeddings_dir,
        existing_clusters=req.existing_clusters or {},
        threshold=req.threshold or 0.6,
        must_links=req.must_links or [],
        cannot_links=req.cannot_links or [],
        candidate_files=req.candidate_files,
        memberships=req.memberships,
        qualities=req.qualities,
        review_files=review_files,
    )
    # Convert numpy ints to plain Python ints for JSON serialization
    _last_cluster_ms = 1000 * (time.perf_counter() - start)
    plain_results = {k: int(v) for k, v in results.items()}
    print(f"[cluster_faces_v2] Done: {len(plain_results)} faces clustered", flush=True)
    return {"clusters": plain_results, "review_files": review_files}


@app.post("/plan_automatic_face_merges")
def plan_automatic_face_merges(req: AutomaticMergeRequest):
    """Suggest merges only among the unnamed assignments supplied by the app."""
    from face_clusterer import plan_automatic_cluster_merges

    if not os.path.exists(req.embeddings_dir):
        raise HTTPException(status_code=400, detail="Embeddings directory not found")
    candidates = plan_automatic_cluster_merges(
        req.embeddings_dir,
        req.unnamed_clusters,
        threshold=req.threshold,
        cannot_links=req.cannot_links or [],
        return_details=True,
    )
    return {"candidates": candidates}


@app.post("/compute_face_quality")
async def compute_face_quality_endpoint(req: FaceQualityRequest):
    """Compute face quality score."""
    from face_clusterer import compute_face_quality

    try:
        target_emb = np.load(req.embedding_path)
        all_embs = [np.load(p) for p in req.all_embedding_paths]
        all_embs_array = np.array(all_embs)
        quality = compute_face_quality(target_emb, all_embs_array)
        return {"quality": quality}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Entry point ---

import signal
_shutdown_requested = False

def _handle_shutdown(signum, frame):
    global _shutdown_requested
    _shutdown_requested = True
    print(f"Received signal {signum}, shutting down gracefully...", flush=True)
    sys.exit(0)


def main():
    port = int(os.environ.get("AI_WORKER_PORT", "9876"))
    # Register signal handlers for graceful shutdown
    signal.signal(signal.SIGTERM, _handle_shutdown)
    signal.signal(signal.SIGINT, _handle_shutdown)

    print(f"Starting PhotoFactory AI Worker on port {port}", flush=True)
    print(
        f"Models directory: {os.environ.get('AI_MODELS_DIR', os.path.join(os.path.dirname(__file__), 'models'))}",
        flush=True,
    )
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


def thumbnail_stream():
    """Serve multiple thumbnail requests using one decoder process."""
    import json
    from pathlib import Path
    from PIL import Image
    from pillow_heif import register_heif_opener

    register_heif_opener()
    for line in sys.stdin.buffer:
        success = False
        try:
            request = json.loads(line)
            source = Path(request["source"])
            size = int(request["size"])
            if not 1 <= size <= 1024:
                raise ValueError("invalid thumbnail size")
            if source.suffix.lower() in RAW_EXTENSIONS:
                import rawpy
                with rawpy.imread(str(source)) as raw:
                    image = Image.fromarray(raw.postprocess(half_size=True))
            else:
                with Image.open(source) as original:
                    image = original.convert("RGB")
            image.thumbnail((size, size), Image.Resampling.LANCZOS)
            image.save(request["target"], format="WEBP", lossless=True, method=2)
            success = True
        except Exception as error:
            print(f"Thumbnail decode failed: {error}", file=sys.stderr, flush=True)
        print(json.dumps(success), flush=True)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--thumbnail-stream":
        thumbnail_stream()
    elif len(sys.argv) > 1 and sys.argv[1] == "--check-directml":
        from inference_runtime import available_providers
        providers = available_providers()
        print("Bundled ONNX providers:", ", ".join(providers))
        raise SystemExit(0 if "DmlExecutionProvider" in providers else 1)
    elif len(sys.argv) > 1 and sys.argv[1] == "--convert-image":
        # Shared decoder for Rust thumbnail/face previews, also in PyInstaller builds.
        # Do not start uvicorn or initialize inference models in this mode.
        import shutil
        if len(sys.argv) != 4:
            raise SystemExit("Usage: --convert-image SOURCE DESTINATION")
        converted = _convert_for_ai(sys.argv[2])
        try:
            if converted is None:
                from PIL import Image
                with Image.open(sys.argv[2]) as image:
                    image.convert("RGB").save(sys.argv[3], "JPEG", quality=90)
            else:
                shutil.copyfile(converted, sys.argv[3])
        finally:
            if converted is not None:
                os.unlink(converted)
    else:
        main()
