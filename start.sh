#!/usr/bin/env bash
# Full desktop development launcher; Windows: run from Git Bash (not WSL).
set -euo pipefail
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
CHECK_ONLY=0
case "${1:-}" in
  --check) CHECK_ONLY=1 ;;
  --help|-h)
    echo 'Usage: ./start.sh [--check]'
    echo 'Prepares frontend + Python codecs/AI models, then launches the Tauri desktop app.'
    echo 'Windows: use Git Bash with native Windows Node, Rust/MSVC and Python x64.'
    echo '--check verifies dependencies and models without installing or launching.'
    exit 0 ;;
  '') ;;
  *) echo "Unknown argument: $1" >&2; exit 2 ;;
esac
fail() { echo "Error: $*" >&2; exit 1; }
for tool in node npm cargo; do
  command -v "$tool" >/dev/null 2>&1 || fail "Missing $tool. See docs/BUILDING.md."
done
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) VENV_PY="$ROOT_DIR/ai_worker/.venv/Scripts/python.exe"; PY_CANDIDATES=(python python3); WINDOWS=1 ;;
  *) VENV_PY="$ROOT_DIR/ai_worker/.venv/bin/python"; PY_CANDIDATES=(python3 python); WINDOWS=0 ;;
esac
# These helpers enable GPS/EXIF writing and OCR in the smart tools.
for tool in exiftool tesseract; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Warning: $tool is missing. Install it and add it to PATH for OCR/EXIF tools; see docs/BUILDING.md." >&2
  fi
done
# Avoid relying on ripgrep being installed on the user's machine.
if command -v tesseract >/dev/null 2>&1; then
  LANGUAGES="$(tesseract --list-langs 2>&1 || true)"
  if [[ "$LANGUAGES" != *eng* || "$LANGUAGES" != *chi_sim* ]]; then
    echo 'Warning: Install Tesseract eng and chi_sim language data for full English/Chinese OCR support.' >&2
  fi
fi
if [[ ! -f "$VENV_PY" ]]; then
  [[ "$CHECK_ONLY" == 0 ]] || fail 'Python virtual environment missing. Run ./start.sh first.'
  BASE_PY=''
  for candidate in "${PY_CANDIDATES[@]}"; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; assert sys.version_info >= (3, 10)' >/dev/null 2>&1; then
      BASE_PY="$candidate"; break
    fi
  done
  [[ -n "$BASE_PY" ]] || fail 'Install Python 3.10+ (3.11 x64 recommended on Windows).'
  "$BASE_PY" -m venv "$ROOT_DIR/ai_worker/.venv"
fi
if [[ "$WINDOWS" == 1 ]]; then
  "$VENV_PY" -c 'import sysconfig; assert sysconfig.get_platform() == "win-amd64", "Use native Windows x64 Python; see docs/BUILDING.md"'
fi
if [[ "$CHECK_ONLY" == 0 ]]; then
  if [[ ! -d node_modules || ! -f node_modules/.package-lock.json || package-lock.json -nt node_modules/.package-lock.json ]]; then
    echo 'Installing locked frontend dependencies...'
    npm ci --fetch-retries=1 --fetch-timeout=30000
  fi
  if [[ "$WINDOWS" == 1 ]] && "$VENV_PY" -m pip show onnxruntime >/dev/null 2>&1; then
    "$VENV_PY" -m pip uninstall -y onnxruntime
    "$VENV_PY" -m pip install --disable-pip-version-check --force-reinstall --no-deps --only-binary=:all: 'onnxruntime-directml>=1.18,<2'
  fi
  echo 'Preparing Python codecs and AI dependencies...'
  "$VENV_PY" -m pip install --disable-pip-version-check --retries 1 --timeout 30 --only-binary=:all: -r ai_worker/requirements.txt
fi
[[ -d node_modules/@tauri-apps/cli ]] || fail 'Frontend dependencies missing. Run ./start.sh first.'
"$VENV_PY" -c 'import fastapi, uvicorn, numpy, onnxruntime, onnx, cv2, PIL, pillow_heif, sklearn, rawpy, tokenizers'
if [[ "$WINDOWS" == 1 ]] && [[ "${PHOTOFACTORY_AI_PROVIDER:-auto}" == "auto" ]]; then
  "$VENV_PY" ai_worker/server.py --check-directml || echo "DirectML unavailable; AI will use CPU." >&2
fi
if [[ "$CHECK_ONLY" == 0 ]]; then
  "$VENV_PY" ai_worker/download_models.py
else
  "$VENV_PY" - <<'PY'
import sys
sys.path.insert(0, 'ai_worker')
from download_models import MODELS_DIR, SINGLE_FILE_MODELS, MODEL_ASSETS, validate_onnx
for name, info in SINGLE_FILE_MODELS.items():
    assert validate_onnx(MODELS_DIR / name, info['minimum_bytes']), f'Missing/invalid model: {name}'
for name, info in MODEL_ASSETS.items():
    path = MODELS_DIR / name
    assert path.is_file() and path.stat().st_size >= info['minimum_bytes'], f'Missing/invalid asset: {name}'
assert validate_onnx(MODELS_DIR / 'resnet50_places365.onnx', 80 * 1024 * 1024), 'Missing/invalid Places365 model'
PY
fi
if [[ "$WINDOWS" == 1 ]]; then
  export AI_WORKER_DIR="$(cygpath -w "$ROOT_DIR/ai_worker")"
else
  export AI_WORKER_DIR="$ROOT_DIR/ai_worker"
fi
echo 'Dependencies and AI models are ready.'
[[ "$CHECK_ONLY" == 0 ]] || exit 0
echo 'Starting PhotoFactory desktop. AI starts automatically when recognition is requested.'
exec npm run tauri -- dev
