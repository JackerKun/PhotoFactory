"""Loopback browser UI for the existing offline map packer."""
import argparse
import gzip
import hashlib
import json
import mimetypes
import os
import secrets
import shutil
import sqlite3
import tempfile
import threading
import time
import webbrowser
from collections import deque
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request

WEB = Path(__file__).with_name("offline_map_web")
# The asset name participates in the browse and package cache keys.
STANDARD_OVERVIEW = WEB / "natural-earth-5.1.2-labels-v2.mbtiles"
STREET_NATIVE_ZOOM = 14
STREET_MAX_ZOOM = 19
STREET_CREDIT = "OpenFreeMap © OpenMapTiles © OpenStreetMap contributors"
STREET_TILEJSON = "https://tiles.openfreemap.org/planet"
STREET_LIMIT = 3000
STREET_BYTES = 50_000_000
ASSETS = {"/": WEB / "index.html", "/app.js": WEB / "app.js",
          "/streets.js": WEB / "streets.js", "/style.css": WEB / "style.css"}
ASSETS.update({f"/vendor/{path.relative_to(WEB / 'vendor').as_posix()}": path
               for path in (WEB / "vendor").rglob("*") if path.is_file()})


def cached_selection(directory, rectangles):
    """Find actual cached XYZ files without walking every coordinate in the bbox."""
    found = []
    signature = hashlib.sha256()
    size = 0
    for zoom, columns, rows in rectangles:
        level = directory / str(zoom)
        if not level.is_dir():
            continue
        for column in sorted(level.iterdir()):
            if not column.name.isascii() or not column.name.isdecimal():
                continue
            x = int(column.name)
            if x not in columns or column.name != str(x) or not column.is_dir():
                continue
            hits = []
            for tile in sorted(column.iterdir()):
                if tile.suffix not in (".png", ".jpg", ".webp"):
                    continue
                if not tile.stem.isascii() or not tile.stem.isdecimal():
                    continue
                y = int(tile.stem)
                if y not in rows or tile.stem != str(y) or not tile.is_file():
                    continue
                try:
                    stat = tile.stat()
                except FileNotFoundError:
                    continue
                hits.append(y)
                size += stat.st_size
                signature.update(f"{zoom}/{x}/{y}:{stat.st_size}:{stat.st_mtime_ns}\n".encode())
            if hits:
                found.append((zoom, (x,), tuple(sorted(hits))))
    return found, sum(len(rows) for _, _, rows in found), size, signature.hexdigest()


def write_cache(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temp:
        temporary = Path(temp.name)
        try:
            temp.write(data)
            temp.close()
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def is_street(plan):
    return plan.layer == "standard" and getattr(plan, "street", False)


class MapJobs:
    def __init__(self, packer, workspace):
        self.packer = packer
        self.workspace = workspace
        self.lock = threading.Lock()
        self.cancel = threading.Event()
        self.state = {"status": "idle"}
        self.previews = deque(maxlen=4)
        self.output = None
        self.worker = None
        self.sources = {}
        self.browse_slots = threading.BoundedSemaphore(4)
        self.street_locks = [threading.Lock() for _ in range(16)]
        self.street_template = None
        self.street_requests = 0
        self.street_bytes = 0

    def plan(self, form):
        if not isinstance(form, dict):
            raise ValueError("打包设置无效。")
        layer = form.get("layer")
        if layer not in ("standard", "satellite", "both"):
            raise ValueError("请选择打包图层。")
        source = form.get("source")
        if source not in ("streets", "natural-earth", "nasa", "url", "directory"):
            raise ValueError("请选择地图来源。")
        if (source == "nasa" and layer != "satellite") or (source in ("streets", "natural-earth") and layer == "satellite"):
            raise ValueError("请选择与图层匹配的地图来源。")
        bounds = self.packer.bounds_arg(str(form.get("bounds", "")))
        name = str(form.get("name", "")).strip() or "离线地图"
        if len(name) > 100:
            raise ValueError("名称最多 100 个字符。")
        source_value = str(form.get("sourceValue", "")).strip()
        if source in ("url", "directory") and not source_value:
            raise ValueError("请填写瓦片网址或本地瓦片目录。")
        satellite_source = form.get("satelliteSource", "nasa")
        if satellite_source not in ("nasa", "url", "directory"):
            raise ValueError("卫星来源无效。")
        satellite_value = str(form.get("satelliteValue", "")).strip()
        if layer == "both" and satellite_source in ("url", "directory") and not satellite_value:
            raise ValueError("请填写卫星瓦片网址或本地目录。")
        try:
            low, high = int(form["minZoom"]), int(form["maxZoom"])
            sat_low = int(form["satelliteMinZoom"]) if layer == "both" else None
            sat_high = int(form["satelliteMaxZoom"]) if layer == "both" else None
            limit = int(form["limit"])
        except (TypeError, ValueError, KeyError) as error:
            raise ValueError("缩放层级和瓦片上限须为整数。") from error
        options = argparse.Namespace(
            name=name, bbox=bounds, layer=layer, output=None, min_zoom=low, max_zoom=high,
            max_tiles=limit, delay=0.25, attribution=str(form.get("credit", "")).strip(),
            tile_url=source_value if source == "url" else None,
            tile_dir=Path(source_value).expanduser() if source == "directory" else None,
            satellite_url=satellite_value if layer == "both" and satellite_source == "url" else None,
            satellite_dir=Path(satellite_value).expanduser() if layer == "both" and satellite_source == "directory" else None,
            satellite_attribution=str(form.get("satelliteCredit", "")).strip(),
            satellite_min_zoom=sat_low, satellite_max_zoom=sat_high,
        )
        if source == "streets":
            if form.get("mode") not in ("viewed", "preview"):
                raise ValueError("内置街道地图请先浏览，再导出已浏览的瓦片。")
            options.tile_dir = self.workspace / "viewed" / "openfreemap-streets-v1"
            options.attribution = STREET_CREDIT
            options.street = True
        if source == "natural-earth":
            if high > 6:
                raise ValueError("内置标准概览支持 0–6 级。更高层级请选择 XYZ 来源。")
            if not STANDARD_OVERVIEW.is_file():
                raise ValueError("缺少内置标准概览文件，请检查工具文件是否完整。")
            options.tile_mbtiles = STANDARD_OVERVIEW.resolve()
            options.attribution = "Made with Natural Earth"
        plans = self.packer.plan_layers(options)
        if form.get("mode") == "viewed":
            for index, (plan, rectangles, _) in enumerate(plans):
                directory = self.browse_directory(plan)
                found, count, size, signature = cached_selection(directory, rectangles)
                if not count:
                    label = "卫星实景" if plan.layer == "satellite" else "标准地图"
                    raise ValueError(f"选区和层级内没有已浏览的{label}瓦片。请先缩放、平移并等地图加载完成。")
                if is_street(plan) and (count > STREET_LIMIT or size > STREET_BYTES):
                    raise ValueError("街道地图每包最多 3,000 张、50 MB。请缩小选区或层级范围。")
                plan.tile_url = None
                plan.tile_dir = directory
                if hasattr(plan, "tile_mbtiles"):
                    plan.tile_mbtiles = None
                plan.min_zoom, plan.max_zoom = found[0][0], found[-1][0]
                plan.cache_signature = signature
                plans[index] = plan, found, count
        total = sum(count for _, _, count in plans)
        return options, plans, total

    def browse_directory(self, plan):
        if is_street(plan):
            return self.workspace / "viewed" / "openfreemap-streets-v1"
        identity = [plan.layer, plan.tile_url, plan.tile_dir, getattr(plan, "tile_mbtiles", None)]
        key = hashlib.sha256(json.dumps(identity, default=str).encode()).hexdigest()
        return self.workspace / "viewed" / key

    def register_source(self, form):
        if not isinstance(form, dict) or form.get("layer") not in ("standard", "satellite"):
            raise ValueError("请选择预览图层。")
        _, [(plan, _, _)], _ = self.plan({
            **form, "bounds": "0,0,1,1", "minZoom": 0,
            "maxZoom": {"natural-earth": 6, "nasa": 8}.get(form.get("source"), 19),
            "limit": 1, "mode": "preview",
        })
        key = self.browse_directory(plan).name
        with self.lock:
            if key not in self.sources and len(self.sources) >= 32:
                self.sources.pop(next(iter(self.sources)))
            self.sources[key] = plan
        return {"source": key, "maxZoom": plan.max_zoom, "attribution": plan.attribution,
                "nativeZoom": STREET_NATIVE_ZOOM if is_street(plan) else None}

    def browse_plan(self, key, z, x, y):
        with self.lock:
            plan = self.sources.get(key)
        if plan is None or not (0 <= z <= plan.max_zoom and 0 <= x < 1 << z and 0 <= y < 1 << z):
            raise ValueError("预览瓦片坐标无效。")
        return plan

    def street_vector_path(self, z, x, y):
        shift = max(0, z - STREET_NATIVE_ZOOM)
        return self.workspace / "street-vectors-v1" / str(z - shift) / str(x >> shift) / f"{y >> shift}.pbf"

    def street_vector(self, z, x, y):
        path = self.street_vector_path(z, x, y)
        with self.street_locks[hash(path) % len(self.street_locks)]:
            if path.is_file():
                return path.read_bytes()
            if self.street_template is None:
                request = Request(STREET_TILEJSON, headers={"User-Agent": "PhotoFactory-OfflineMap/1.0"})
                with self.packer.package_opener().open(request, timeout=15) as response:
                    template = json.loads(response.read(65536))["tiles"][0]
                if urlsplit(template).hostname != "tiles.openfreemap.org" or not template.startswith(STREET_TILEJSON + "/"):
                    raise ValueError("街道地图地址无效。")
                self.street_template = template
            with self.lock:
                reservation = self.packer.MAX_TILE_BYTES
                if self.street_requests >= STREET_LIMIT or self.street_bytes + reservation > STREET_BYTES:
                    raise ValueError("本次街道地图下载已达到 3,000 张或 50 MB 上限。请导出已浏览区域。")
                self.street_requests += 1
                self.street_bytes += reservation
            size = reservation
            try:
                url = self.street_template.format(z=path.parent.parent.name, x=path.parent.name, y=path.stem)
                req = Request(url, headers={"User-Agent": "PhotoFactory-OfflineMap/1.0"})
                with self.packer.package_opener().open(req, timeout=15) as response:
                    wire = response.read(reservation + 1)
                if len(wire) > reservation:
                    raise ValueError("街道矢量瓦片过大。")
                size = len(wire)
                if wire.startswith(b"\x1f\x8b"):
                    import io
                    with gzip.GzipFile(fileobj=io.BytesIO(wire)) as stream:
                        data = stream.read(reservation + 1)
                else:
                    data = wire
                if len(data) > reservation:
                    raise ValueError("街道矢量瓦片过大。")
                write_cache(path, data)
                return data
            finally:
                with self.lock:
                    self.street_bytes -= reservation - size

    def save_street_image(self, key, z, x, y, data):
        plan = self.browse_plan(key, z, x, y)
        if not is_street(plan) or not self.street_vector_path(z, x, y).is_file():
            raise ValueError("街道瓦片尚未下载。")
        if self.packer.tile_format(data) != "png" or data[16:24] != b"\x00\x00\x01\x00" * 2:
            raise ValueError("街道瓦片图像无效。")
        write_cache(self.browse_directory(plan) / str(z) / str(x) / f"{y}.png", data)

    def browse_tile(self, key, z, x, y):
        plan = self.browse_plan(key, z, x, y)
        column = self.browse_directory(plan) / str(z) / str(x)
        with self.browse_slots:
            for extension in ("png", "jpg", "webp"):
                path = column / f"{y}.{extension}"
                if path.is_file():
                    return path.read_bytes(), extension
            if is_street(plan):
                return self.street_vector(z, x, y), "pbf"
            source_path = getattr(plan, "tile_mbtiles", None)
            if source_path:
                with closing(sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True)) as conn:
                    row = conn.execute(
                        "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                        (z, x, (1 << z) - 1 - y),
                    ).fetchone()
                if row is None:
                    raise ValueError("预览瓦片不存在。")
                data = row[0]
            else:
                data = self.packer.read_tile(plan, z, x, y)
            if not data or len(data) > self.packer.MAX_TILE_BYTES:
                raise ValueError("预览瓦片大小无效。")
            extension = self.packer.tile_format(data)
            write_cache(column / f"{y}.{extension}", data)
            return data, extension

    def start(self, form):
        options, plans, total = self.plan(form)
        if total > options.max_tiles:
            raise ValueError(f"选区需要 {total:,} 张瓦片，超过上限 {options.max_tiles:,}。")
        identity = [vars(layer) for layer, _, _ in plans]
        fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True, default=str).encode()).hexdigest()
        suffix = ".pfmap" if options.layer == "both" else ".mbtiles"
        output = self.workspace / fingerprint / ("offline-map" + suffix)
        options.output = output
        with self.lock:
            if self.state["status"] in ("running", "stopping"):
                raise ValueError("已有一个打包任务正在运行。")
            self.cancel.clear()
            self.previews.clear()
            self.output = output
            self.state = {
                "status": "running", "done": 0, "total": total,
                "download": secrets.token_urlsafe(20), "filename": options.name + suffix,
            }
            self.worker = threading.Thread(target=self.run, args=(options, plans, total), daemon=True)
            self.worker.start()
            return self.state["download"]

    def run(self, options, plans, total):
        last_tile = 0.0
        last_level = None
        sequence = 0

        def stage(name):
            with self.lock:
                self.state["stage"] = name
                self.state.pop("tile", None)

        def progress(done, _total):
            with self.lock:
                self.state["done"] = done
                self.state.pop("network", None)

        def network(zoom, attempt, retry_wait):
            with self.lock:
                self.state["network"] = {
                    "z": zoom, "attempt": attempt, "retryWait": retry_wait,
                }

        def tile(layer, zoom, x, y, data):
            nonlocal last_tile, last_level, sequence
            now = time.monotonic()
            level = (layer, zoom)
            new_level = level != last_level
            if not new_level and now - last_tile < 0.16:
                return
            first_tile = sequence == 0
            last_level, last_tile = level, now
            sequence += 1
            with self.lock:
                self.state["tile"] = {"layer": layer, "z": zoom, "x": x, "y": y, "sequence": sequence}
                self.previews.append((str(sequence), data))
            # Keep each new level visible for at least one browser poll.
            if new_level:
                self.cancel.wait(0.9 if first_tile else 0.32)

        try:
            if not options.output.is_file():
                self.packer.build_map(options, plans, total, progress=progress, stop=self.cancel,
                                      on_tile=tile, on_stage=stage, on_network=network)
            with self.lock:
                self.state.update(status="done", done=total)
        except self.packer.BuildCancelled:
            with self.lock:
                self.state.update(status="stopped")
        except Exception as error:
            with self.lock:
                self.state.update(status="error", message=str(error))

    def stop(self):
        with self.lock:
            if self.state["status"] == "running":
                self.state["status"] = "stopping"
                self.cancel.set()


def serve(packer, *, open_browser=True, workspace=None):
    base = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / ".cache"))
    jobs = MapJobs(packer, workspace or (base / "PhotoFactory" / "offline-map-builder"))
    token = secrets.token_urlsafe(32)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def send_data(self, data, mime, status=200):
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
            self.send_header("X-Content-Type-Options", "nosniff")
            try:
                self.end_headers()
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def json(self, value, status=200):
            self.send_data(json.dumps(value, ensure_ascii=False).encode(), "application/json; charset=utf-8", status)

        def local_host(self):
            return self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"

        def authorized(self):
            return secrets.compare_digest(self.headers.get("X-Offline-Token", ""), token)

        def do_GET(self):
            if not self.local_host():
                return self.send_error(403)
            url = urlsplit(self.path)
            if url.path in ASSETS:
                asset = ASSETS[url.path]
                mime = {".js": "text/javascript", ".css": "text/css", ".html": "text/html; charset=utf-8"}.get(asset.suffix)
                mime = mime or mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
                return self.send_data(asset.read_bytes(), mime)
            if url.path == "/download":
                with jobs.lock:
                    state, path = jobs.state.copy(), jobs.output
                if state["status"] != "done" or not path or parse_qs(url.query).get("id") != [state["download"]]:
                    return self.send_error(404)
                from urllib.parse import quote
                with path.open("rb") as file:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(path.stat().st_size))
                    self.send_header("Referrer-Policy", "no-referrer")
                    self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(state["filename"], safe=""))
                    self.end_headers()
                    try:
                        shutil.copyfileobj(file, self.wfile, length=1024 * 1024)
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                return
            if not self.authorized():
                return self.send_error(403)
            if url.path == "/api/status":
                with jobs.lock:
                    state = jobs.state.copy()
                return self.json(state)
            if url.path.startswith("/api/browse/"):
                try:
                    key, z, x, y = url.path.removeprefix("/api/browse/").split("/")
                    data, extension = jobs.browse_tile(key, int(z), int(x), int(y))
                except (ValueError, OSError) as error:
                    return self.json({"error": str(error)}, 404)
                mime = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp",
                        "pbf": "application/x-protobuf"}
                return self.send_data(data, mime[extension])
            if url.path == "/api/tile":
                query = parse_qs(url.query)
                with jobs.lock:
                    preview = next((data for sequence, data in jobs.previews
                                    if query.get("sequence") == [sequence] and query.get("id") == [jobs.state["download"]]), None)
                if preview:
                    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}
                    return self.send_data(preview, mime[packer.tile_format(preview)])
            self.send_error(404)

        def do_POST(self):
            if not self.local_host() or not self.authorized():
                return self.send_error(403)
            if self.headers.get("Origin") not in (None, f"http://127.0.0.1:{self.server.server_port}"):
                return self.send_error(403)
            try:
                if self.path.startswith("/api/browse/"):
                    key, z, x, y = self.path.removeprefix("/api/browse/").split("/")
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= packer.MAX_TILE_BYTES:
                        return self.send_error(400)
                    jobs.save_street_image(key, int(z), int(x), int(y), self.rfile.read(length))
                    return self.send_data(b"", "text/plain", 204)
                if self.path == "/api/stop":
                    jobs.stop()
                    return self.json({"ok": True})
                if self.path not in ("/api/plan", "/api/start", "/api/source"):
                    return self.send_error(404)
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 32768:
                    return self.send_error(400)
                form = json.loads(self.rfile.read(length))
                if self.path == "/api/source":
                    return self.json(jobs.register_source(form))
                if self.path == "/api/plan":
                    _, plans, total = jobs.plan(form)
                    return self.json({"total": total, "layers": [
                        {"layer": layer.layer, "count": count, "minZoom": layer.min_zoom,
                         "maxZoom": layer.max_zoom, "cached": hasattr(layer, "cache_signature")}
                        for layer, _, count in plans
                    ]})
                self.json({"download": jobs.start(form)})
            except (ValueError, TypeError, OSError, argparse.ArgumentTypeError) as error:
                self.json({"error": str(error)}, 400)

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        url = f"http://127.0.0.1:{server.server_port}/#{token}"
        print(f"离线地图工具：{url}", flush=True)
        if open_browser:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            jobs.stop()
            if jobs.worker:
                jobs.worker.join()
