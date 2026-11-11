#!/usr/bin/env python3
"""Create a raster offline map with one or both layers (Python 3.10+)."""
import argparse
import hashlib
import http.client
import json
import math
import shutil
import sqlite3
import struct
import ssl
import sys
import time
from functools import lru_cache
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

MAX_LAT = 85.0511287798066
MAX_TILE_BYTES = 2 * 1024 * 1024
MAX_PACKAGE_BYTES = 32 * 1024**3
NASA_URL = (
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/'
    'default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg'
)


def bounds_arg(value):
    try:
        west, south, east, north = map(float, value.split(','))
    except ValueError as exc:
        raise argparse.ArgumentTypeError('expected west,south,east,north') from exc
    if not (-180 <= west < east <= 180 and -MAX_LAT <= south < north <= MAX_LAT):
        raise argparse.ArgumentTypeError('invalid bounds; split regions crossing ±180° into two packages')
    return west, south, east, north


def tile_rect(bounds, zoom):
    west, south, east, north = bounds
    edge = 1 << zoom
    def x(lon):
        return edge * (lon + 180) / 360
    def y(lat):
        return edge * (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2
    def span(lo, hi):
        start = max(0, min(edge - 1, math.floor(lo)))
        return range(start, max(start + 1, min(edge, math.ceil(hi))))
    return span(x(west), x(east)), span(y(north), y(south))


def tile_format(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png'
    if data.startswith(b'\xff\xd8\xff'):
        return 'jpg'
    if data.startswith(b'RIFF') and data[8:12] == b'WEBP':
        return 'webp'
    raise ValueError('tile is not a PNG, JPEG, or WebP image')


def check_url(url):
    parsed = urlsplit(url)
    host = (parsed.hostname or '').lower().rstrip('.')
    if parsed.scheme not in ('https', 'http') or not host:
        raise ValueError('tile URL must use HTTP or HTTPS')
    if host == 'tile.openstreetmap.org' or host.endswith('.tile.openstreetmap.org') or host in ('server.arcgisonline.com', 'services.arcgisonline.com'):
        raise ValueError('the built-in online OSM and Esri services cannot be used for bulk packaging')


class CheckedRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


@lru_cache(maxsize=1)
def tile_tls_context():
    context = ssl.create_default_context()
    if sys.platform == 'darwin' and not context.get_ca_certs() and not ssl.get_default_verify_paths().capath:
        # Some Python.org installs have Tk but their cert.pem symlink is absent.
        # Use macOS's shipped roots while keeping certificate and hostname checks on.
        from subprocess import DEVNULL, SubprocessError, check_output
        try:
            roots = check_output([
                '/usr/bin/security', 'find-certificate', '-a', '-p',
                '/System/Library/Keychains/SystemRootCertificates.keychain',
            ], text=True, stderr=DEVNULL, timeout=5)
            context.load_verify_locations(cadata=roots)
        except (OSError, SubprocessError, ValueError):
            pass
    return context


@lru_cache(maxsize=1)
def package_opener():
    return build_opener(CheckedRedirect(), HTTPSHandler(context=tile_tls_context()))


def network_failure(error):
    reason = getattr(error, 'reason', error)
    if isinstance(reason, ssl.SSLCertVerificationError):
        return 'HTTPS 证书验证失败'
    if isinstance(error, HTTPError):
        return f'HTTP {error.code}'
    if isinstance(reason, TimeoutError):
        return '网络请求超时'
    if isinstance(reason, http.client.IncompleteRead):
        return '瓦片传输中断，数据未收齐'
    return '无法连接地图服务'



class BuildCancelled(Exception):
    pass


def wait_or_cancel(seconds, stop):
    if stop is None:
        time.sleep(seconds)
    elif stop.wait(seconds):
        raise BuildCancelled()


def read_tile(args, z, x, y, stop=None, on_network=None):
    if args.tile_dir:
        for ext in ('png', 'jpg', 'jpeg', 'webp'):
            path = args.tile_dir / str(z) / str(x) / f'{y}.{ext}'
            if path.is_file():
                with path.open('rb') as handle:
                    return handle.read(MAX_TILE_BYTES + 1)
        raise ValueError('missing tile in local XYZ directory')
    url = args.tile_url.format(z=z, x=x, y=y)
    check_url(url)
    request = Request(url, headers={'User-Agent': 'PhotoFactory-OfflineMap/1.0'})
    for attempt in range(3):
        wait_or_cancel(0, stop)
        if on_network:
            on_network(z, attempt + 1, None)
        try:
            with package_opener().open(request, timeout=20) as response:
                expected = response.length
                if expected is not None and expected > MAX_TILE_BYTES:
                    raise ValueError('tile is larger than 2 MiB')
                data = bytearray()
                while len(data) <= MAX_TILE_BYTES:
                    wait_or_cancel(0, stop)
                    chunk = response.read1(min(65536, MAX_TILE_BYTES + 1 - len(data)))
                    if not chunk:
                        break
                    data.extend(chunk)
                if expected is not None and len(data) < expected:
                    raise http.client.IncompleteRead(bytes(data), expected - len(data))
                return bytes(data)
        except HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise ValueError(f'HTTP {error.code}') from None
            retry_after = error.headers.get('Retry-After', '')
            if retry_after.isdecimal() and int(retry_after) > 60:
                raise ValueError(f'HTTP {error.code}: server requested a longer pause; resume later') from None
            pause = max(2**attempt, int(retry_after) if retry_after.isdecimal() else 0)
        except (OSError, http.client.HTTPException) as error:
            if attempt == 2 or isinstance(getattr(error, 'reason', error), ssl.SSLCertVerificationError):
                raise ValueError(network_failure(error)) from error
            pause = 2**attempt
        if on_network:
            on_network(z, attempt + 1, pause)
        wait_or_cancel(pause, stop)


def package(args, rectangles, total, *, progress=None, stop=None, on_tile=None, on_network=None):
    output = args.output.resolve()
    if output.suffix.lower() != '.mbtiles' or output.exists():
        raise ValueError('output must be a new .mbtiles file')
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_name(output.name + '.part')
    info = {
        'name': args.name,
        'type': 'baselayer',
        'version': '1.3',
        'bounds': ','.join(map(str, args.bbox)),
        'minzoom': str(args.min_zoom),
        'maxzoom': str(args.max_zoom),
        'attribution': args.attribution or '',
        'photofactory_layer': args.layer,
    }
    source_path = getattr(args, 'tile_mbtiles', None)
    signature_parts = [info, args.tile_url, str(args.tile_dir)]
    if source_path:
        signature_parts.append(str(source_path))
    signature = hashlib.sha256(json.dumps(signature_parts, sort_keys=True).encode()).hexdigest()
    conn = sqlite3.connect(partial)
    source = None
    try:
        if source_path:
            source = sqlite3.connect(source_path.as_uri() + '?mode=ro', uri=True)
        conn.executescript('''
            CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS tiles (
                zoom_level INTEGER NOT NULL, tile_column INTEGER NOT NULL, tile_row INTEGER NOT NULL,
                tile_data BLOB NOT NULL, PRIMARY KEY (zoom_level, tile_column, tile_row)
            ) WITHOUT ROWID;
        ''')
        previous = dict(conn.execute('SELECT name,value FROM metadata'))
        if previous and previous.get('photofactory_build_signature') != signature:
            raise ValueError(f'{partial.name} belongs to a different build; choose another output path')
        conn.executemany('INSERT OR REPLACE INTO metadata VALUES (?,?)', {**info, 'photofactory_build_signature': signature}.items())
        conn.commit()
        image_format = previous.get('format')
        done, size = conn.execute('SELECT COUNT(*), COALESCE(SUM(length(tile_data)),0) FROM tiles').fetchone()
        if done:
            print(f'Resuming: {done:,}/{total:,} tiles already saved.', flush=True)
        if progress:
            progress(done, total)
        for z, xs, ys in rectangles:
            for x in xs:
                for y in ys:
                    wait_or_cancel(0, stop)
                    tms_y = (1 << z) - 1 - y
                    if conn.execute('SELECT 1 FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?', (z, x, tms_y)).fetchone():
                        continue
                    try:
                        if source is None:
                            data = read_tile(args, z, x, y, stop, on_network)
                        else:
                            row = source.execute(
                                'SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?',
                                (z, x, tms_y),
                            ).fetchone()
                            if row is None:
                                raise ValueError('内置底图缺少此瓦片')
                            data = row[0]
                        if not data or len(data) > MAX_TILE_BYTES:
                            raise ValueError('tile is empty or larger than 2 MiB')
                        fmt = tile_format(data)
                        if image_format is None:
                            image_format = fmt
                            conn.execute('INSERT INTO metadata VALUES (?,?)', ('format', fmt))
                        if fmt != image_format:
                            raise ValueError('all tiles must use the same image format')
                        size += len(data)
                        # Allow for the SQLite pages and index in the 32 GiB import limit.
                        if size > MAX_PACKAGE_BYTES * 0.9:
                            raise ValueError('package too large; use a smaller region or fewer zoom levels')
                        conn.execute('INSERT INTO tiles VALUES (?,?,?,?)', (z, x, tms_y, data))
                    except (ValueError, OSError) as error:
                        conn.commit()
                        raise ValueError(f'tile {z}/{x}/{y}: {error}; rerun the same command to resume') from error
                    done += 1
                    if done % 50 == 0 or done == total:
                        conn.commit()
                        print(f'{done:,}/{total:,} tiles', flush=True)
                    if progress:
                        progress(done, total)
                    if on_tile:
                        on_tile(args.layer, z, x, y, data)
                    if args.tile_url:
                        wait_or_cancel(args.delay, stop)
            conn.commit()
        if done != total or partial.stat().st_size > MAX_PACKAGE_BYTES:
            raise ValueError('incomplete or oversized package')
        if output.exists():
            raise ValueError('output file already exists')
        # Leave the build signature until all checks pass so interrupted builds can resume.
        conn.execute("DELETE FROM metadata WHERE name='photofactory_build_signature'")
        conn.commit()
    except BuildCancelled:
        conn.commit()
        raise
    finally:
        if source is not None:
            source.close()
        conn.close()
    partial.rename(output)
    print(f'Ready: {output} ({output.stat().st_size / 1024**2:.1f} MiB)')
    return output


def plan_package(args):
    if not args.name.strip() or not 0 <= args.min_zoom <= args.max_zoom <= 19:
        raise ValueError('provide a name and zoom levels 0–19 (min <= max)')
    if args.max_tiles < 1 or not math.isfinite(args.delay) or args.delay < 0.1:
        raise ValueError('--max-tiles must be positive and --delay must be at least 0.1')
    if args.tile_url:
        if not all('{' + key + '}' in args.tile_url for key in ('z', 'x', 'y')) or not (args.attribution or '').strip():
            raise ValueError('custom URL requires {z}, {x}, {y} and --attribution')
        try:
            check_url(args.tile_url.format(z=0, x=0, y=0))
        except (ValueError, KeyError, IndexError) as error:
            raise ValueError(f'invalid tile URL: {error}') from error
    elif not args.tile_dir and not getattr(args, 'tile_mbtiles', None):
        if args.max_zoom > 8:
            raise ValueError('NASA Blue Marble supports zoom 0–8; use --tile-url or --tile-dir for more detail')
        args.tile_url = NASA_URL
        args.layer = args.layer or 'satellite'
        args.attribution = args.attribution or 'NASA Earthdata / GIBS — Blue Marble'
    if args.tile_dir:
        args.tile_dir = args.tile_dir.resolve()
    args.layer = args.layer or 'standard'
    rectangles = [(z, *tile_rect(args.bbox, z)) for z in range(args.min_zoom, args.max_zoom + 1)]
    total = sum(len(xs) * len(ys) for _, xs, ys in rectangles)
    return rectangles, total


def plan_layers(args):
    if args.layer != 'both':
        return [(args, *plan_package(args))]
    if not args.tile_url and not args.tile_dir and not getattr(args, 'tile_mbtiles', None):
        raise ValueError('两种地图模式需要提供标准地图的 XYZ 瓦片网址或本地目录。')
    standard = argparse.Namespace(**{**vars(args), 'layer': 'standard'})
    use_nasa = not args.satellite_url and not args.satellite_dir
    satellite = argparse.Namespace(**{
        **vars(args), 'layer': 'satellite',
        'name': f'{args.name} · 卫星实景地图',
        'tile_url': args.satellite_url, 'tile_dir': args.satellite_dir,
        'attribution': args.satellite_attribution,
        'min_zoom': args.satellite_min_zoom if args.satellite_min_zoom is not None else (2 if use_nasa else args.min_zoom),
        'max_zoom': args.satellite_max_zoom if args.satellite_max_zoom is not None else (8 if use_nasa else args.max_zoom),
    })
    if hasattr(satellite, 'tile_mbtiles'):
        satellite.tile_mbtiles = None
    standard.name = f'{args.name} · 标准地图'
    return [(layer, *plan_package(layer)) for layer in (standard, satellite)]


def build_map(args, plans, total, *, progress=None, stop=None, on_tile=None, on_stage=None, on_network=None):
    if args.layer != 'both':
        if on_stage:
            on_stage(args.layer)
        return package(*plans[0], progress=progress, stop=stop, on_tile=on_tile, on_network=on_network)
    output = args.output.resolve()
    if output.suffix.lower() != '.pfmap' or output.exists():
        raise ValueError('请选择一个新的 .pfmap 保存位置。')
    output.parent.mkdir(parents=True, exist_ok=True)
    work = output.with_name(output.name + '.parts')
    signature_file = work / 'build-signature'
    signature = hashlib.sha256(json.dumps(
        [vars(layer) for layer, _, _ in plans], sort_keys=True, default=str,
    ).encode()).hexdigest()
    work.mkdir(exist_ok=True)
    if signature_file.exists():
        if signature_file.read_text(encoding='ascii') != signature:
            raise ValueError('保存位置存在另一组打包任务。请恢复原设置或选择其他文件名。')
    else:
        if any(work.iterdir()):
            raise ValueError('保存位置已有未识别的打包文件。请选择其他文件名。')
        signature_file.write_text(signature, encoding='ascii')

    paths = []
    finished = 0
    for layer, rectangles, count in plans:
        wait_or_cancel(0, stop)
        path = work / f'{layer.layer}.mbtiles'
        paths.append(path)
        if not path.exists():
            if on_stage:
                on_stage(layer.layer)
            options = argparse.Namespace(**{**vars(layer), 'output': path})
            package(options, rectangles, count, stop=stop, on_tile=on_tile, on_network=on_network,
                    progress=(lambda done, _, offset=finished: progress(offset + done, total)) if progress else None)
        finished += count
        if progress:
            progress(finished, total)

    if on_stage:
        on_stage('bundle')
    lengths = [path.stat().st_size for path in paths]
    if any(not 0 < length <= MAX_PACKAGE_BYTES for length in lengths):
        raise ValueError('某个图层的地图包超过 32 GiB 或文件不完整。')
    temporary = output.with_name(output.name + '.part')
    with temporary.open('wb') as bundle:
        bundle.write(struct.pack('<8sQQ', b'PFMAP001', *lengths))
        for path in paths:
            with path.open('rb') as source:
                while chunk := source.read(1024 * 1024):
                    wait_or_cancel(0, stop)
                    bundle.write(chunk)
    if output.exists():
        raise ValueError('保存位置已存在同名文件。')
    temporary.rename(output)
    shutil.rmtree(work, ignore_errors=True)
    return output


def preview_tile(zoom, x, y):
    """Fetch only tiles visible in the selection window, with HTTP caching."""
    from email.utils import parsedate_to_datetime
    from http.client import HTTPException
    from tempfile import NamedTemporaryFile
    from urllib.request import urlopen

    cache = Path.home() / '.cache' / 'photofactory-map-preview'
    path = cache / str(zoom) / str(x) / f'{y}.png'
    metadata_path = path.with_suffix('.json')
    cached = None
    metadata = {}
    try:
        with path.open('rb') as file:
            data = file.read(MAX_TILE_BYTES + 1)
        if len(data) <= MAX_TILE_BYTES and data.startswith(b'\x89PNG\r\n\x1a\n'):
            cached = data
            metadata = json.loads(metadata_path.read_text())
            if metadata.get('expires', 0) > time.time():
                return cached
    except (OSError, ValueError, TypeError, AttributeError):
        metadata = {}
    request_headers = {'User-Agent': 'PhotoFactory-MapPicker/1.0 (+https://github.com/JackerKun/PhotoFactory)'}
    for key, header in [('etag', 'If-None-Match'), ('modified', 'If-Modified-Since')]:
        if metadata.get(key):
            request_headers[header] = metadata[key]
    request = Request(f'https://tile.openstreetmap.org/{zoom}/{x}/{y}.png', headers=request_headers)
    reused = False
    try:
        with urlopen(request, timeout=6, context=tile_tls_context()) as response:
            headers = response.headers
            data = response.read(MAX_TILE_BYTES + 1)
        if len(data) > MAX_TILE_BYTES or not data.startswith(b'\x89PNG\r\n\x1a\n'):
            if cached is not None:
                return cached
            raise ValueError('底图服务未返回有效的 PNG 瓦片')
    except HTTPError as error:
        if error.code != 304 or cached is None:
            if cached is not None:
                return cached
            raise
        headers, data, reused = error.headers, cached, True
    except (OSError, HTTPException):
        if cached is not None:
            return cached
        raise
    cache_header = headers.get('Cache-Control', metadata.get('cache_control', '') if reused else '')
    directives = [value.strip().lower() for value in cache_header.split(',')]
    if 'no-store' in directives:
        return data
    fresh_until = time.time() + 7 * 86400
    if 'no-cache' in directives:
        fresh_until = 0
    else:
        try:
            max_age = next((part[8:] for part in directives if part.startswith('max-age=')), None)
            if max_age is not None:
                fresh_until = time.time() + int(max_age)
            elif headers.get('Expires'):
                fresh_until = parsedate_to_datetime(headers['Expires']).timestamp()
        except (ValueError, TypeError, OverflowError):
            pass
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if not reused:
            with NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
                temporary = Path(tmp.name)
                tmp.write(data)
            try:
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
        metadata_path.write_text(json.dumps({
            'expires': fresh_until, 'cache_control': cache_header,
            'etag': headers.get('ETag', metadata.get('etag') if reused else None),
            'modified': headers.get('Last-Modified', metadata.get('modified') if reused else None),
        }))
    except OSError:
        pass
    return data


class MapPicker:
    TILE_SIZE = 256

    def __init__(self, tk, canvas, mode, on_selection, info):
        from collections import OrderedDict
        from concurrent.futures import ThreadPoolExecutor

        self.tk = tk
        self.canvas = canvas
        self.mode = mode
        self.on_selection = on_selection
        self.info = info
        self.zoom = 4
        self.center = self.project(105, 35)
        self.selection = None
        self.drag = None
        self.draft = None
        self.images = OrderedDict()
        self.tile_items = {}
        self.failed = {}
        self.pending = {}
        self.executor = ThreadPoolExecutor(max_workers=4)
        self.load_timer = None
        self.poll_timer = None
        self.redraw_timer = None
        self.redraw_needs_load = False
        self.active = True
        self.scan_view = None
        self.scan_layer = None
        canvas.bind('<Configure>', self.request_redraw)
        for button in (1, 2, 3):
            canvas.bind(f'<ButtonPress-{button}>', self.press)
            canvas.bind(f'<B{button}-Motion>', self.move)
            canvas.bind(f'<ButtonRelease-{button}>', self.release)
        canvas.bind('<MouseWheel>', lambda event: self.change_zoom(1 if event.delta > 0 else -1, event.x, event.y))
        canvas.bind('<Button-4>', lambda event: self.change_zoom(1, event.x, event.y))
        canvas.bind('<Button-5>', lambda event: self.change_zoom(-1, event.x, event.y))

    @property
    def edge(self):
        return self.TILE_SIZE * (1 << self.zoom)

    def project(self, lon, lat):
        return (self.edge * (lon + 180) / 360,
                self.edge * (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2)

    def unproject(self, x, y):
        x = max(0, min(self.edge, x))
        y = max(0, min(self.edge, y))
        lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / self.edge))))
        return x / self.edge * 360 - 180, max(-MAX_LAT, min(MAX_LAT, lat))

    def origin(self):
        width, height = self.canvas.winfo_width(), self.canvas.winfo_height()
        cx, cy = self.center
        left = (self.edge - width) / 2 if width > self.edge else min(max(cx - width / 2, 0), self.edge - width)
        top = (self.edge - height) / 2 if height > self.edge else min(max(cy - height / 2, 0), self.edge - height)
        self.center = left + width / 2, top + height / 2
        return left, top

    def visible(self):
        left, top = self.origin()
        width, height = self.canvas.winfo_width(), self.canvas.winfo_height()
        count = 1 << self.zoom
        xs = range(max(0, math.floor(left / 256)), min(count, math.ceil((left + width) / 256)))
        ys = range(max(0, math.floor(top / 256)), min(count, math.ceil((top + height) / 256)))
        return [(self.zoom, x, y) for y in ys for x in xs]

    def request_redraw(self, _event=None, *, load=True):
        self.redraw_needs_load |= load
        if self.redraw_timer is None:
            self.redraw_timer = self.canvas.after(16, self.flush_redraw)

    def flush_redraw(self):
        self.redraw_timer = None
        load, self.redraw_needs_load = self.redraw_needs_load, False
        self.redraw(load=load and self.drag is None)

    def redraw(self, *, load=True):
        left, top = self.origin()
        visible = self.visible()
        wanted = set(visible)
        for key in self.tile_items.keys() - wanted:
            self.canvas.delete(self.tile_items.pop(key))
        for key in visible:
            if key not in self.images:
                continue
            self.images.move_to_end(key)
            _, x, y = key
            coords = x * 256 - left, y * 256 - top
            if key in self.tile_items:
                self.canvas.coords(self.tile_items[key], *coords)
            else:
                self.tile_items[key] = self.canvas.create_image(
                    *coords, image=self.images[key], anchor='nw', tags='map-tile',
                )
        self.draw_selection()
        if load and self.scan_view is None:
            if self.load_timer:
                self.canvas.after_cancel(self.load_timer)
            self.load_timer = self.canvas.after(130, self.load_visible)

    def load_visible(self):
        self.load_timer = None
        if self.drag or self.scan_view is not None:
            return
        visible = self.visible()
        wanted = set(visible)
        for key, future in list(self.pending.items()):
            if key not in wanted and future.cancel():
                del self.pending[key]
        for key in visible:
            if key not in self.images and key not in self.failed and key not in self.pending:
                self.pending[key] = self.executor.submit(preview_tile, *key)
        self.show_load_status(visible)
        if self.pending and self.poll_timer is None:
            self.poll_timer = self.canvas.after(75, self.receive_tiles)

    def receive_tiles(self):
        from http.client import HTTPException

        self.poll_timer = None
        if self.scan_view is not None:
            self.pending = {key: future for key, future in self.pending.items() if not future.done()}
            if self.pending:
                self.poll_timer = self.canvas.after(75, self.receive_tiles)
            return
        visible = self.visible()
        wanted = set(visible)
        decoded = 0
        for key, future in list(self.pending.items()):
            if not future.done():
                continue
            if key not in wanted:
                # The download is already cached on disk. Avoid decoding tiles
                # for a viewport the user has moved away from.
                del self.pending[key]
                continue
            if decoded == 3:
                continue
            del self.pending[key]
            decoded += 1
            try:
                data = future.result()
                if data is None:
                    self.failed[key] = '未收到瓦片'
                else:
                    self.images[key] = self.tk.PhotoImage(master=self.canvas, data=data, format='png')
            except (OSError, HTTPException, ValueError, self.tk.TclError) as error:
                self.failed[key] = str(error) if isinstance(error, ValueError) else network_failure(error)
        if decoded:
            self.request_redraw(load=False)
        while len(self.images) > max(128, len(visible)):
            stale = next((key for key in self.images if key not in wanted), None)
            if stale is None:
                break
            self.images.pop(stale)
        if self.pending:
            self.poll_timer = self.canvas.after(16 if decoded == 3 else 75, self.receive_tiles)
        self.show_load_status(visible)

    def show_load_status(self, visible):
        loaded = sum(key in self.images for key in visible)
        failed = next((self.failed[key] for key in visible if key in self.failed), '')
        if any(key in self.pending for key in visible):
            message = f'正在加载底图 {loaded}/{len(visible)}…'
        elif failed:
            message = f'底图加载失败（{failed}）。可点击「重试底图」。'
        else:
            message = ''
        if self.info.get() != message:
            self.info.set(message)
        overlay = self.canvas.find_withtag('map-loading')
        if message and not loaded:
            coords = self.canvas.winfo_width() / 2, self.canvas.winfo_height() / 2
            if overlay:
                self.canvas.coords(overlay[0], *coords)
                if self.canvas.itemcget(overlay[0], 'text') != message:
                    self.canvas.itemconfigure(overlay[0], text=message)
            else:
                self.canvas.create_text(*coords, text=message, fill='#34465a', tags='map-loading')
        elif overlay:
            self.canvas.delete('map-loading')

    def begin_scan(self):
        self.cancel_drag()
        self.scan_view = self.zoom, self.center, self.images
        self.images = type(self.images)()
        self.scan_layer = None
        if self.load_timer is not None:
            self.canvas.after_cancel(self.load_timer)
            self.load_timer = None
        for key, future in list(self.pending.items()):
            if future.cancel():
                del self.pending[key]
        self.canvas.delete('map-loading')
        self.info.set('正在扫描选区…')

    def show_scan_tile(self, layer, zoom, x, y, data):
        if self.scan_layer != layer or self.zoom != zoom:
            self.canvas.delete('map-tile')
            self.tile_items.clear()
            self.images.clear()
        self.scan_layer = layer
        self.zoom = zoom
        self.center = ((x + 0.5) * self.TILE_SIZE, (y + 0.5) * self.TILE_SIZE)
        key = zoom, x, y
        try:
            png_size = struct.unpack('>II', data[16:24]) if data.startswith(b'\x89PNG\r\n\x1a\n') and len(data) >= 24 else None
            if png_size == (self.TILE_SIZE, self.TILE_SIZE):
                self.images[key] = self.tk.PhotoImage(master=self.canvas, data=data, format='png')
            else:
                from io import BytesIO
                from PIL import Image, ImageTk
                with Image.open(BytesIO(data)) as tile:
                    if max(tile.size) <= 2048:
                        preview = tile.resize((self.TILE_SIZE, self.TILE_SIZE))
                        self.images[key] = ImageTk.PhotoImage(preview, master=self.canvas)
        except (ImportError, OSError, ValueError, self.tk.TclError):
            # Without a decoder, the highlighted tile and progress still show
            # exactly where the scan is working.
            pass
        self.redraw(load=False)
        self.canvas.delete('scan-tile')
        left, top = self.origin()
        px, py = x * self.TILE_SIZE - left, y * self.TILE_SIZE - top
        self.canvas.create_rectangle(
            px, py, px + self.TILE_SIZE, py + self.TILE_SIZE,
            outline='#e79314', width=3, tags='scan-tile',
        )
        visible = set(self.visible())
        while len(self.images) > max(128, len(visible)):
            stale = next((key for key in self.images if key not in visible), None)
            if stale is None:
                break
            self.images.pop(stale)
        name = '卫星实景' if layer == 'satellite' else '标准地图'
        self.info.set(f'{name} · 第 {zoom} 级 · 瓦片 {x}/{y}')

    def end_scan(self):
        self.canvas.delete('scan-tile', 'map-tile')
        self.tile_items.clear()
        self.zoom, self.center, self.images = self.scan_view
        self.scan_view = None
        self.scan_layer = None
        self.redraw()

    def retry(self):
        self.failed.clear()
        self.redraw()

    def draw_selection(self):
        self.canvas.delete('map-selection')
        rect = self.draft
        if rect is None and self.selection is not None:
            west, south, east, north = self.selection
            left, top = self.origin()
            x1, y1 = self.project(west, north)
            x2, y2 = self.project(east, south)
            rect = x1 - left, y1 - top, x2 - left, y2 - top
        if rect is not None:
            self.canvas.create_rectangle(*rect, outline='#1368d4', width=3, fill='#1368d4', stipple='gray25', tags='map-selection')

    def cancel_drag(self):
        if self.drag is not None or self.draft is not None:
            self.drag = self.draft = None
            self.request_redraw()

    def press(self, event):
        if not self.active:
            return
        panning = self.mode.get() == 'pan' or event.num != 1
        self.drag = (event.x, event.y, self.center, panning)
        if self.load_timer:
            self.canvas.after_cancel(self.load_timer)
            self.load_timer = None

    def move(self, event):
        if not self.drag:
            return
        x, y, (cx, cy), panning = self.drag
        if panning:
            self.center = cx + x - event.x, cy + y - event.y
            self.request_redraw(load=False)
        else:
            self.draft = x, y, event.x, event.y
            self.draw_selection()

    def release(self, event):
        if not self.drag:
            return
        x, y, _, panning = self.drag
        self.drag = self.draft = None
        if not panning and abs(x - event.x) >= 4 and abs(y - event.y) >= 4:
            left, top = self.origin()
            west, north = self.unproject(left + min(x, event.x), top + min(y, event.y))
            east, south = self.unproject(left + max(x, event.x), top + max(y, event.y))
            if west < east and south < north:
                self.selection = west, south, east, north
                self.on_selection()
        self.redraw()

    def change_zoom(self, step, x=None, y=None):
        if not self.active or self.drag:
            return
        new_zoom = max(1, min(19, self.zoom + step))
        if new_zoom == self.zoom:
            return
        half_w, half_h = self.canvas.winfo_width() / 2, self.canvas.winfo_height() / 2
        x = half_w if x is None else x
        y = half_h if y is None else y
        left, top = self.origin()
        scale = 2 ** (new_zoom - self.zoom)
        self.center = (left + x) * scale + half_w - x, (top + y) * scale + half_h - y
        self.zoom = new_zoom
        self.redraw()

    def close(self):
        for timer in (self.load_timer, self.poll_timer, self.redraw_timer):
            if timer:
                self.canvas.after_cancel(timer)
        self.executor.shutdown(wait=False, cancel_futures=True)


def launch_gui():
    try:
        import tkinter as tk
        from tkinter import filedialog, messagebox, ttk
    except ImportError:
        raise SystemExit('图形界面需要带 Tkinter 的 Python。请更换 Python 解释器，或使用 --help 查看命令行用法。') from None

    from queue import Empty, SimpleQueue
    from threading import Event, Thread

    try:
        root = tk.Tk()
    except tk.TclError as error:
        raise SystemExit(f'无法打开图形界面：{error}') from error
    root.title('PhotoFactory 离线地图打包')
    width = min(1040, root.winfo_screenwidth() - 60)
    height = min(740, root.winfo_screenheight() - 100)
    root.geometry(f'{width}x{height}')
    root.minsize(620, 460)
    root.columnconfigure(0, weight=1)
    root.rowconfigure(0, weight=1)
    body = ttk.Frame(root, padding=12)
    body.grid(sticky='nsew')
    body.columnconfigure(0, weight=1)
    body.rowconfigure(1, weight=1)
    map_tools = ttk.Frame(body)
    map_tools.grid(row=0, column=0, sticky='ew', pady=(0, 8))
    mode = tk.StringVar(value='select')
    mode_help = tk.StringVar(value='拖出选区 · 滚轮缩放')
    controls = []
    for text, value in [('框选范围', 'select'), ('移动地图', 'pan')]:
        button = ttk.Radiobutton(map_tools, text=text, variable=mode, value=value)
        button.pack(side='left', padx=(0, 6))
        controls.append(button)
    ttk.Label(map_tools, textvariable=mode_help).pack(side='left', padx=(8, 0))
    canvas = tk.Canvas(body, background='#e4ebf2', highlightthickness=0, cursor='crosshair')
    canvas.grid(row=1, column=0, sticky='nsew')
    map_footer = ttk.Frame(body)
    map_footer.grid(row=2, column=0, sticky='ew', pady=(4, 0))
    map_info = tk.StringVar(value='正在加载底图…')
    ttk.Label(map_footer, textvariable=map_info).pack(side='left')
    selection_credit = '选区底图 © OpenStreetMap contributors'
    map_credit = tk.StringVar(value=selection_credit)
    ttk.Label(map_footer, textvariable=map_credit).pack(side='right')
    bottom = ttk.Frame(body)
    bottom.grid(row=3, column=0, sticky='ew', pady=(8, 0))
    bottom.columnconfigure(0, weight=1)
    form = ttk.Frame(bottom, padding=(0, 8))
    form.columnconfigure(1, weight=1)

    nasa, custom, local = 'NASA 卫星（0–8）', '自定义 XYZ 网址', '本地 XYZ 目录'
    standard, satellite, both = '标准地图', '卫星实景地图', '两种地图'
    source = tk.StringVar(value=nasa)
    layer = tk.StringVar(value=satellite)
    source_value = tk.StringVar()
    attribution = tk.StringVar()
    satellite_source = tk.StringVar()
    satellite_credit = tk.StringVar()
    satellite_low, satellite_high = tk.StringVar(value='2'), tk.StringVar(value='8')
    name = tk.StringVar()
    min_zoom, max_zoom = tk.StringVar(value='2'), tk.StringVar(value='8')
    limit = tk.StringVar(value='20000')
    output = tk.StringVar()
    status = tk.StringVar()
    selection_info = tk.StringVar(value='在地图上拖出要保存的区域。')
    def label(row, text):
        ttk.Label(form, text=text).grid(row=row, column=0, sticky='w', padx=(0, 12), pady=4)

    def entry(parent, variable, **options):
        widget = ttk.Entry(parent, textvariable=variable, **options)
        controls.append(widget)
        return widget

    def choices(row, text, variable, options, on_change):
        label(row, text)
        group = ttk.Frame(form)
        group.grid(row=row, column=1, columnspan=2, sticky='ew', pady=4)
        buttons = {}
        for option in options:
            button = ttk.Radiobutton(group, text=option, value=option, variable=variable, command=on_change)
            button.pack(side='left', padx=(0, 10), pady=2)
            controls.append(button)
            buttons[option] = button
        return buttons

    source_buttons = choices(0, '地图来源', source, (nasa, custom, local), lambda: source_changed())
    label(1, '瓦片网址或目录')
    source_entry = entry(form, source_value)
    source_entry.grid(row=1, column=1, sticky='ew', pady=4)

    def choose_directory():
        path = filedialog.askdirectory(parent=root, title='选择包含 z/x/y 瓦片的目录')
        if path:
            source_value.set(path)

    directory_button = ttk.Button(form, text='浏览…', command=choose_directory)
    directory_button.grid(row=1, column=2, padx=(6, 0))
    controls.append(directory_button)
    label(2, '地图来源署名')
    credit_entry = entry(form, attribution)
    credit_entry.grid(row=2, column=1, columnspan=2, sticky='ew', pady=4)
    choices(3, '打包图层', layer, (standard, satellite, both), lambda: layer_changed())
    label(4, '地图包名称')
    entry(form, name).grid(row=4, column=1, columnspan=2, sticky='ew', pady=4)

    label(5, '缩放层级')
    zooms = ttk.Frame(form)
    zooms.grid(row=5, column=1, columnspan=2, sticky='w', pady=4)
    entry(zooms, min_zoom, width=5).pack(side='left')
    ttk.Label(zooms, text='至', padding=(6, 0)).pack(side='left')
    entry(zooms, max_zoom, width=5).pack(side='left')
    ttk.Label(zooms, text='瓦片上限', padding=(14, 0, 6, 0)).pack(side='left')
    entry(zooms, limit, width=10).pack(side='left')

    satellite_form = ttk.Frame(form)
    satellite_form.columnconfigure(1, weight=1)
    ttk.Label(satellite_form, text='卫星来源').grid(row=0, column=0, sticky='w', padx=(0, 12))
    entry(satellite_form, satellite_source).grid(row=0, column=1, sticky='ew')

    def choose_satellite_directory():
        path = filedialog.askdirectory(parent=root, title='选择卫星瓦片目录')
        if path:
            satellite_source.set(path)

    satellite_directory_button = ttk.Button(satellite_form, text='浏览…', command=choose_satellite_directory)
    satellite_directory_button.grid(row=0, column=2, padx=(6, 0))
    controls.append(satellite_directory_button)
    ttk.Label(satellite_form, text='卫星来源署名').grid(row=1, column=0, sticky='w', pady=4)
    entry(satellite_form, satellite_credit).grid(row=1, column=1, columnspan=2, sticky='ew')
    ttk.Label(satellite_form, text='卫星缩放层级').grid(row=2, column=0, sticky='w')
    satellite_zooms = ttk.Frame(satellite_form)
    satellite_zooms.grid(row=2, column=1, sticky='w')
    entry(satellite_zooms, satellite_low, width=5).pack(side='left')
    ttk.Label(satellite_zooms, text='至', padding=(6, 0)).pack(side='left')
    entry(satellite_zooms, satellite_high, width=5).pack(side='left')
    ttk.Label(satellite_form, text='上方来源和层级用于标准地图。卫星来源填 XYZ 网址或目录，留空使用 NASA（0–8）。',
              wraplength=580).grid(row=3, column=0, columnspan=3, sticky='w', pady=4)

    def choose_output():
        extension = '.pfmap' if layer.get() == both else '.mbtiles'
        path = filedialog.asksaveasfilename(
            parent=root, title='保存离线地图包', defaultextension=extension,
            filetypes=[('双图层地图包' if extension == '.pfmap' else '单图层地图包', '*' + extension)],
            initialfile='offline-map' + extension,
        )
        if path:
            output.set(path)

    bar = ttk.Progressbar(bottom, mode='determinate')
    bar.grid(row=3, column=0, sticky='ew', pady=(6, 4))
    ttk.Label(bottom, textvariable=status, wraplength=720, justify='left').grid(row=4, column=0, sticky='w')
    output_notice = tk.StringVar()
    ttk.Label(bottom, textvariable=output_notice, wraplength=720).grid(row=5, column=0, sticky='w')

    def show_output_path(*_):
        path = output.get()
        output_notice.set(f'保存位置：{path}' if path else '')

    output.trace_add('write', show_output_path)

    source_hint = tk.StringVar()
    ttk.Label(form, textvariable=source_hint).grid(row=6, column=0, columnspan=3, sticky='w')
    source_drafts = {}
    current_source = source.get()
    estimate_timer = None

    def source_changed():
        nonlocal current_source
        kind = source.get()
        if kind != current_source:
            source_drafts[current_source] = (source_value.get(), attribution.get())
            current_source = kind
            value, credit = source_drafts.get(kind, ('', ''))
            source_value.set(value)
            attribution.set(credit)
        source_entry.state(['disabled'] if kind == nasa else ['!disabled'])
        credit_entry.state(['disabled'] if kind == nasa else ['!disabled'])
        directory_button.state(['!disabled'] if kind == local else ['disabled'])
        source_hint.set({
            nasa: '全球卫星概览，无需配置网址。',
            custom: '网址须包含 {z}、{x}、{y}，并填写来源署名。',
            local: '选择包含 z/x/y.png、.jpg 或 .webp 的目录。',
        }[kind])
        request_estimate()

    def layer_changed():
        chosen = layer.get()
        source_buttons[nasa].state(['!disabled'] if chosen == satellite else ['disabled'])
        if chosen != satellite and source.get() == nasa:
            source.set(local)
        if chosen == both:
            satellite_form.grid(row=7, column=0, columnspan=3, sticky='ew', pady=(6, 0))
        else:
            satellite_form.grid_remove()
        extension = '.pfmap' if chosen == both else '.mbtiles'
        if output.get() and Path(output.get()).suffix.lower() != extension:
            output.set('')
        source_changed()

    def read_form(require_output):
        kind = source.get()
        value = source_value.get().strip()
        if kind != nasa and not value:
            raise ValueError('请填写瓦片网址或选择瓦片目录。')
        if picker.selection is None:
            raise ValueError('在地图上拖出要保存的区域。')
        bbox = picker.selection
        try:
            low, high, max_tiles = int(min_zoom.get()), int(max_zoom.get()), int(limit.get())
        except ValueError as error:
            raise ValueError('层级和瓦片上限须为整数。') from error
        if not 0 <= low <= high <= (8 if kind == nasa else 19) or max_tiles < 1:
            raise ValueError(f'层级须为 0–{8 if kind == nasa else 19}，最低层级不能高于最高层级，瓦片上限须大于零。')
        package_name = name.get().strip()
        path = output.get().strip()
        dual = layer.get() == both
        extension = '.pfmap' if dual else '.mbtiles'
        if require_output and (not path or Path(path).suffix.lower() != extension):
            raise ValueError(f'请选择 {extension} 保存位置。')
        satellite_value = satellite_source.get().strip()
        satellite_url = satellite_value if satellite_value.lower().startswith(('http://', 'https://')) else None
        satellite_dir = Path(satellite_value).expanduser() if satellite_value and not satellite_url else None
        try:
            satellite_min_zoom = int(satellite_low.get()) if dual else None
            satellite_max_zoom = int(satellite_high.get()) if dual else None
        except ValueError as error:
            raise ValueError('卫星缩放层级须为整数。') from error
        args = argparse.Namespace(
            name=package_name or (Path(path).stem if path else '离线地图'), bbox=bbox, min_zoom=low, max_zoom=high,
            max_tiles=max_tiles, delay=0.25, output=Path(path).expanduser(),
            layer='both' if dual else ('satellite' if layer.get() == satellite else 'standard'),
            attribution=attribution.get().strip(), tile_url=value if kind == custom else None,
            tile_dir=Path(value).expanduser() if kind == local else None,
            satellite_url=satellite_url, satellite_dir=satellite_dir,
            satellite_attribution=satellite_credit.get().strip(),
            satellite_min_zoom=satellite_min_zoom, satellite_max_zoom=satellite_max_zoom,
        )
        plans = plan_layers(args)
        return args, plans, sum(count for _, _, count in plans)

    def request_estimate(*_):
        nonlocal estimate_timer
        if not picker.selection:
            return
        if estimate_timer is not None:
            root.after_cancel(estimate_timer)
        estimate_timer = root.after(80, estimate)

    def estimate():
        nonlocal estimate_timer
        estimate_timer = None
        try:
            args, _, total = read_form(False)
            suffix = f'，超过上限 {args.max_tiles:,}' if total > args.max_tiles else ''
            selection_info.set(f'已选范围 · {total:,} 张瓦片{suffix}')
        except ValueError as error:
            selection_info.set(str(error))

    picker = MapPicker(tk, canvas, mode, request_estimate, map_info)

    def change_mode(*_):
        picker.cancel_drag()
        moving = mode.get() == 'pan'
        canvas.configure(cursor='fleur' if moving else 'crosshair')
        mode_help.set('拖动地图 · 滚轮缩放' if moving else '拖出选区 · 滚轮缩放')

    mode.trace_add('write', change_mode)
    root.bind('<Escape>', lambda _event: picker.cancel_drag(), add='+')
    for label_text, command, button_width in [
        ('重试底图', picker.retry, None),
        ('−', lambda: picker.change_zoom(-1), 3),
        ('+', lambda: picker.change_zoom(1), 3),
    ]:
        button = ttk.Button(map_tools, text=label_text, command=command, width=button_width)
        button.pack(side='right', padx=3 if button_width else 0)
        controls.append(button)
    for value in (source_value, attribution, min_zoom, max_zoom, limit,
                  satellite_source, satellite_credit, satellite_low, satellite_high):
        value.trace_add('write', request_estimate)
    layer_changed()

    messages = SimpleQueue()
    stop = Event()
    worker = None
    closing = False
    scan_credits = {}

    def set_busy(busy):
        picker.active = not busy
        for widget in controls:
            widget.state(['disabled'] if busy else ['!disabled'])
        cancel_button.state(['!disabled'] if busy else ['disabled'])
        if not busy:
            layer_changed()

    def show_progress():
        nonlocal worker
        try:
            while True:
                kind, value = messages.get_nowait()
                if kind == 'scan':
                    map_credit.set(scan_credits.get(value[0]) or '所选地图来源')
                    picker.show_scan_tile(*value)
                    continue
                if kind == 'progress':
                    done, total = value
                    bar.configure(maximum=total, value=done)
                    if not stop.is_set():
                        status.set(f'正在打包 {done:,} / {total:,} 张瓦片' if done < total else '瓦片已准备，正在保存地图包…')
                    continue
                worker = None
                picker.end_scan()
                map_credit.set(selection_credit)
                set_busy(False)
                status.set(value)
                if kind == 'success':
                    output.set('')
                if closing:
                    destroy_window()
                return
        except Empty:
            root.after(100, show_progress)

    def start():
        nonlocal worker, scan_credits
        try:
            args, plans, total = read_form(False)
            if total > args.max_tiles:
                raise ValueError(f'需要 {total:,} 张瓦片，超过上限 {args.max_tiles:,}。请缩小范围、降低层级或调高上限。')
        except ValueError as error:
            status.set(str(error))
            return
        if not output.get():
            choose_output()
            if not output.get():
                return
        try:
            args, plans, total = read_form(True)
        except ValueError as error:
            status.set(str(error))
            return
        stop.clear()
        scan_credits = {plan.layer: plan.attribution for plan, _, _ in plans}
        map_credit.set('正在准备所选地图来源…')
        set_busy(True)
        picker.begin_scan()
        bar.configure(maximum=total, value=0)
        status.set(f'正在准备 {total:,} 张瓦片…')

        def build():
            last_update = 0.0
            last_view = 0.0
            last_level = None

            def on_tile(layer, zoom, x, y, data):
                nonlocal last_view, last_level
                now = time.monotonic()
                level = layer, zoom
                if level != last_level or now - last_view >= 0.15:
                    messages.put(('scan', (layer, zoom, x, y, data)))
                    last_view, last_level = now, level

            def progress(done, total):
                nonlocal last_update
                now = time.monotonic()
                if now - last_update >= 0.1 or done == total:
                    messages.put(('progress', (done, total)))
                    last_update = now

            try:
                path = build_map(args, plans, total, progress=progress, stop=stop, on_tile=on_tile)
                messages.put(('success', f'已生成 {total:,} 张瓦片\n{path}'))
            except BuildCancelled:
                messages.put(('finished', '已停止。使用相同设置再次开始，可继续打包。'))
            except Exception as error:
                messages.put(('finished', f'打包失败：{error}'))

        worker = Thread(target=build)
        worker.start()
        root.after(100, show_progress)

    def cancel():
        stop.set()
        cancel_button.state(['disabled'])
        status.set('正在停止。当前瓦片请求结束后会保存进度。')

    def destroy_window():
        if estimate_timer is not None:
            root.after_cancel(estimate_timer)
        picker.close()
        root.destroy()

    def close():
        nonlocal closing
        if worker is None:
            destroy_window()
        elif messagebox.askyesno('退出打包工具', '停止当前打包并关闭窗口？', parent=root):
            closing = True
            cancel()

    ttk.Label(bottom, textvariable=selection_info).grid(row=0, column=0, sticky='w')
    actions = ttk.Frame(bottom)
    actions.grid(row=1, column=0, sticky='ew', pady=(6, 0))

    settings_open = False

    def toggle_settings():
        nonlocal settings_open
        settings_open = not settings_open
        if settings_open:
            form.grid(row=2, column=0, sticky='ew')
        else:
            form.grid_remove()
        settings_button.configure(text='收起设置' if settings_open else '更多设置')

    settings_button = ttk.Button(actions, text='更多设置', command=toggle_settings)
    settings_button.pack(side='left')
    save_button = ttk.Button(actions, text='另选保存位置', command=choose_output)
    save_button.pack(side='left', padx=(6, 0))
    cancel_button = ttk.Button(actions, text='停止', command=cancel, state='disabled')
    cancel_button.pack(side='right', padx=(6, 0))
    start_button = ttk.Button(actions, text='开始打包', command=start)
    start_button.pack(side='right')
    controls.extend([settings_button, save_button, start_button])
    root.protocol('WM_DELETE_WINDOW', close)
    root.mainloop()


def main():
    if len(sys.argv) == 1 or sys.argv[1:] in (['--web'], ['--web-no-browser'], ['--gui']):
        from offline_map_web import serve
        serve(sys.modules[__name__], open_browser=sys.argv[1:] != ['--web-no-browser'])
        return
    if sys.argv[1:] == ['--tk']:
        launch_gui()
        return
    parser = argparse.ArgumentParser(description=__doc__, epilog="Run with --web or without arguments to open the local browser UI.")
    parser.add_argument('--name', required=True, help='region/package label shown in PhotoFactory')
    parser.add_argument('--bbox', required=True, type=bounds_arg, help='west,south,east,north in WGS84 degrees; use --bbox=... for negative values')
    parser.add_argument('--min-zoom', required=True, type=int)
    parser.add_argument('--max-zoom', required=True, type=int)
    parser.add_argument('--output', required=True, type=Path)
    sources = parser.add_mutually_exclusive_group()
    sources.add_argument('--tile-url', help='offline-authorized Web Mercator XYZ URL containing {z}, {x}, {y}; default: NASA Blue Marble overview (0–8)')
    sources.add_argument('--tile-dir', type=Path, help='local Web Mercator XYZ directory: z/x/y.png (or jpg/webp)')
    parser.add_argument('--layer', choices=('standard', 'satellite', 'both'), help='target map layer; default: satellite for NASA, standard for custom sources')
    satellite_sources = parser.add_mutually_exclusive_group()
    satellite_sources.add_argument('--satellite-url', help='XYZ URL for the satellite layer in --layer both')
    satellite_sources.add_argument('--satellite-dir', type=Path, help='XYZ tile directory for the satellite layer in --layer both')
    parser.add_argument('--satellite-attribution', help='credit for the satellite source')
    parser.add_argument('--satellite-min-zoom', type=int)
    parser.add_argument('--satellite-max-zoom', type=int)
    parser.add_argument('--attribution', help='source credit, required for a custom URL')
    parser.add_argument('--max-tiles', type=int, default=20_000, help='maximum requested tile count, default 20,000')
    parser.add_argument('--delay', type=float, default=0.25, help='pause between HTTP tile downloads in seconds, minimum 0.1')
    parser.add_argument('--dry-run', action='store_true', help='count tiles without creating a file or making HTTP requests')
    args = parser.parse_args()
    try:
        plans = plan_layers(args)
        total = sum(count for _, _, count in plans)
    except ValueError as error:
        parser.error(str(error))
    for layer, _, count in plans:
        print(f'{layer.name}: zoom {layer.min_zoom}–{layer.max_zoom}, {count:,} tiles ({layer.layer})', flush=True)
    if len(plans) > 1:
        print(f'Total: {total:,} tiles', flush=True)
    if total > args.max_tiles:
        parser.error(f'{total:,} exceeds --max-tiles {args.max_tiles:,}; shrink the region or raise the limit')
    if not args.dry_run:
        try:
            result = build_map(args, plans, total)
            if args.layer == "both":
                print(f"Ready: {result}")
        except (ValueError, OSError, sqlite3.Error) as error:
            parser.exit(1, f'Error: {error}\n')
        except KeyboardInterrupt:
            parser.exit(130, '\nInterrupted; rerun the same command to resume the .part file.\n')


if __name__ == '__main__':
    main()
