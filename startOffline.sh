#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)" || exit 1
MAP_TOOL="$SCRIPT_DIR/scripts/offline_map.py"

try_python() {
  if command -v "$1" >/dev/null 2>&1 && \
    "$@" -c 'import sys; sys.exit(sys.version_info < (3, 10))' >/dev/null 2>&1; then
    exec "$@" "$MAP_TOOL" --web
  fi
}

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) try_python py -3 ;;
esac
try_python python3
try_python python
if [[ "$(uname -s)" == Darwin ]]; then
  try_python /usr/local/bin/python3
  try_python /opt/homebrew/bin/python3
fi

printf '%s\n' '找不到 Python 3.10 或更新版本，请安装后再运行。' >&2
exit 1
