#!/usr/bin/env bash
# Start the PhotoFactory AI Worker
# Usage: ./start.sh [port]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-9876}"

# Check Python
if ! command -v python3 &>/dev/null; then
    echo "Error: python3 not found"
    exit 1
fi

# Check virtualenv or install deps
if [ -d "$SCRIPT_DIR/.venv" ]; then
    source "$SCRIPT_DIR/.venv/bin/activate"
    echo "Using virtualenv: $SCRIPT_DIR/.venv"
fi

# Check the complete runtime surface. Checking FastAPI alone allowed a partially
# installed environment to start and then fail only when clustering or RAW import ran.
if ! python3 -c "import fastapi, uvicorn, numpy, onnxruntime, PIL, pillow_heif, sklearn, rawpy, tokenizers" 2>/dev/null; then
    echo "Installing Python dependencies..."
    python3 -m pip install -r "$SCRIPT_DIR/requirements.txt"
fi

# Check models
MODELS_DIR="$SCRIPT_DIR/models"
MISSING=0
for model in retinaface.onnx arcface.onnx resnet50_places365.onnx clip_vision_int8.onnx clip_text_int8.onnx clip_tokenizer.json; do
    if [ ! -f "$MODELS_DIR/$model" ]; then
        MISSING=1
    fi
done

if [ "$MISSING" -eq 1 ]; then
    echo "Model files missing. Downloading..."
    python3 "$SCRIPT_DIR/download_models.py"
fi

echo ""
echo "=== PhotoFactory AI Worker ==="
echo "Port: $PORT"
echo "Models: $MODELS_DIR"
echo ""

export AI_WORKER_PORT="$PORT"
exec python3 "$SCRIPT_DIR/server.py"
