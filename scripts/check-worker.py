"""Start the frozen Worker from an unrelated directory and require a healthy HTTP response."""
import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parents[1]
worker = root / 'ai_worker/dist/photofactory-ai' / ('photofactory-ai.exe' if os.name == 'nt' else 'photofactory-ai')
if not worker.is_file():
    raise SystemExit(f'Missing standalone Worker: {worker}')
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
env = {**os.environ, 'AI_WORKER_PORT': str(port), 'AI_MODELS_DIR': str(root / 'ai_worker/models')}
# Do not let development import paths rescue missing bundled modules.
for key in ['PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV']:
    env.pop(key, None)
with tempfile.TemporaryDirectory(prefix='photofactory-worker-check-') as directory:
    log_path = root / 'worker-smoke.log'
    with log_path.open('w+b') as log:
        process = subprocess.Popen([str(worker)], cwd=directory, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(120):
                if process.poll() is not None:
                    break
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=2) as response:
                        if json.load(response).get('status') == 'ok':
                            print('Standalone AI Worker health check passed')
                            break
                except (OSError, ValueError):
                    pass
                time.sleep(0.5)
            else:
                raise RuntimeError('Standalone Worker startup timed out')
            if process.poll() is not None:
                raise RuntimeError(f'Standalone Worker exited with {process.returncode}')
        except Exception:
            log.flush()
            print(log_path.read_text(errors='replace'))
            raise
        finally:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
