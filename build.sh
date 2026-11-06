#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-current}"
TARGET="${TAURI_TARGET:-}"
VERSION=""

usage() {
  cat <<'EOF'
PhotoFactory release builder

Usage:
  ./build.sh current   Build installers for the current operating system (default)
  ./build.sh macos     Build a macOS .dmg (must run on macOS)
  ./build.sh windows   Build Windows .msi and NSIS .exe installers (must run on Windows)
  ./build.sh all       Build the current host and explain the other required host

Optional environment:
  TAURI_TARGET=aarch64-apple-darwin ./build.sh macos
  RUN_TESTS=1 ./build.sh current

Tauri's native bundlers require their matching OS: DMG uses macOS tools, while
MSI/NSIS uses Windows tools. Run this same script once on each host (or CI runner)
to produce both release families.
EOF
}

prepare_ai_worker() {
  local bootstrap_python
  local ai_python
  if [[ "$HOST_MODE" == "windows" ]]; then
    bootstrap_python="python"
    ai_python="$PROJECT_DIR/ai_worker/.venv/Scripts/python.exe"
  else
    bootstrap_python="python3"
    ai_python="$PROJECT_DIR/ai_worker/.venv/bin/python"
  fi

  command -v "$bootstrap_python" >/dev/null 2>&1 || {
    echo "Python 3 is required to build the bundled AI service" >&2
    exit 1
  }
  if [[ ! -x "$ai_python" ]]; then
    echo "Creating the AI build environment..."
    "$bootstrap_python" -m venv "$PROJECT_DIR/ai_worker/.venv"
  fi
  if ! "$ai_python" -c "import fastapi, uvicorn, numpy, onnxruntime, PIL, pillow_heif, sklearn, rawpy, tokenizers" >/dev/null 2>&1; then
    echo "Installing AI runtime dependencies..."
    if [[ "${PHOTOFACTORY_BINARY_DEPS:-0}" == "1" ]]; then
      "$ai_python" -m pip install --only-binary=:all: -r "$PROJECT_DIR/ai_worker/requirements.txt"
    else
      "$ai_python" -m pip install -r "$PROJECT_DIR/ai_worker/requirements.txt"
    fi
  fi
  if ! "$ai_python" -c "import PyInstaller" >/dev/null 2>&1; then
    echo "Installing the AI packager..."
    "$ai_python" -m pip install "pyinstaller>=6,<7"
  fi

  echo "Checking AI models..."
  "$ai_python" "$PROJECT_DIR/ai_worker/download_models.py"

  echo "Building the standalone AI service..."
  PYINSTALLER_CONFIG_DIR="$PROJECT_DIR/ai_worker/.pyinstaller" "$ai_python" -m PyInstaller \
    --noconfirm \
    --clean \
    --onedir \
    --name photofactory-ai \
    --distpath "$PROJECT_DIR/ai_worker/dist" \
    --workpath "$PROJECT_DIR/ai_worker/build" \
    --specpath "$PROJECT_DIR/ai_worker" \
    --hidden-import face_detector \
    --hidden-import scene_classifier \
    --hidden-import semantic_classifier \
    --hidden-import face_clusterer \
    --collect-all pillow_heif \
    --collect-all tokenizers \
    "$PROJECT_DIR/ai_worker/server.py"
}

create_standard_dmg() {
  local app_path="$1"
  local dmg_path="$2"
  [[ -d "$app_path" ]] || { echo "Tauri did not produce PhotoFactory.app" >&2; exit 1; }
  echo "Tauri's styled DMG step failed; creating a standard macOS disk image..."
  # Tauri leaves local, identity-free builds linker-signed. Seal bundled AI
  # resources with an ad-hoc signature so Gatekeeper does not see a broken
  # resource envelope. Production releases can replace this with Developer ID.
  codesign --force --deep --sign - "$app_path"
  codesign --verify --deep --strict "$app_path"
  mkdir -p "$(dirname "$dmg_path")"
  hdiutil create -volname PhotoFactory -srcfolder "$app_path" -ov -format UDZO "$dmg_path"
}

case "$MODE" in
  -h|--help|help) usage; exit 0 ;;
  current|macos|windows|all) ;;
  *) echo "Unknown build mode: $MODE" >&2; usage >&2; exit 2 ;;
esac

command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 1; }
command -v cargo >/dev/null 2>&1 || { echo "Rust/Cargo is required" >&2; exit 1; }

cd "$PROJECT_DIR"
VERSION="$(node -p 'require("./package.json").version')"
if [[ ! -d node_modules ]]; then
  echo "Installing locked frontend dependencies..."
  npm ci
fi

HOST="$(uname -s)"
case "$HOST" in
  Darwin) HOST_MODE="macos" ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT) HOST_MODE="windows" ;;
  *) HOST_MODE="unsupported" ;;
esac

if [[ "$MODE" == "current" || "$MODE" == "all" ]]; then
  MODE="$HOST_MODE"
fi

if [[ "$MODE" == "macos" && "$HOST_MODE" != "macos" ]]; then
  echo "A DMG must be bundled on macOS. Run: ./build.sh macos" >&2
  exit 1
fi
if [[ "$MODE" == "windows" && "$HOST_MODE" != "windows" ]]; then
  echo "Windows MSI/NSIS installers must be bundled on Windows. Run: ./build.sh windows" >&2
  exit 1
fi
if [[ "$HOST_MODE" == "unsupported" ]]; then
  echo "This script creates desktop installers on macOS or Windows; detected: $HOST" >&2
  exit 1
fi

if [[ "${RUN_TESTS:-0}" == "1" ]]; then
  echo "Running frontend tests..."
  npm test -- --run
  echo "Running Rust tests..."
  cargo test --locked --manifest-path "$PROJECT_DIR/src-tauri/Cargo.toml" --lib
fi

if [[ "$MODE" == "macos" && -n "$TARGET" ]]; then
  case "$(uname -m):$TARGET" in
    arm64:aarch64-apple-darwin|x86_64:x86_64-apple-darwin) ;;
    *) echo "Build the app and AI Worker on a matching native macOS runner" >&2; exit 1 ;;
  esac
fi
prepare_ai_worker

if [[ "$MODE" == "macos" ]]; then
  echo "Building PhotoFactory DMG..."
  if [[ -n "$TARGET" ]]; then
    if ! npm run tauri build -- --bundles dmg --target "$TARGET" --config src-tauri/tauri.bundle-ai.conf.json -- --locked; then
      app_path="$PROJECT_DIR/src-tauri/target/$TARGET/release/bundle/macos/PhotoFactory.app"
      dmg_path="$PROJECT_DIR/src-tauri/target/$TARGET/release/bundle/dmg/PhotoFactory_${VERSION}_${TARGET%%-*}.dmg"
      create_standard_dmg "$app_path" "$dmg_path"
    fi
  else
    if ! npm run tauri build -- --bundles dmg --config src-tauri/tauri.bundle-ai.conf.json -- --locked; then
      app_path="$PROJECT_DIR/src-tauri/target/release/bundle/macos/PhotoFactory.app"
      dmg_path="$PROJECT_DIR/src-tauri/target/release/bundle/dmg/PhotoFactory_${VERSION}_$(uname -m).dmg"
      create_standard_dmg "$app_path" "$dmg_path"
    fi
  fi
else
  echo "Building PhotoFactory Windows installers..."
  bundles="msi,nsis"
  [[ "$TARGET" == "aarch64-pc-windows-msvc" ]] && bundles="nsis"
  if [[ -n "$TARGET" ]]; then
    npm run tauri build -- --bundles "$bundles" --target "$TARGET" --config src-tauri/tauri.bundle-ai.conf.json -- --locked
  else
    npm run tauri build -- --bundles "$bundles" --config src-tauri/tauri.bundle-ai.conf.json -- --locked
  fi
fi

echo "Build complete. Release artifacts:"
find "$PROJECT_DIR/src-tauri/target" -type f \( -name '*.dmg' -o -name '*.msi' -o -name '*-setup.exe' \) -print 2>/dev/null || true

if [[ "${1:-current}" == "all" ]]; then
  if [[ "$HOST_MODE" == "macos" ]]; then
    echo "macOS artifacts are ready. Run './build.sh windows' on a Windows host for .msi/.exe."
  else
    echo "Windows artifacts are ready. Run './build.sh macos' on a Mac for .dmg."
  fi
fi
