'use strict';

const token = location.hash.slice(1);
const $ = (id) => document.getElementById(id);
const form = $('settings');
const field = (name) => form.elements.namedItem(name);
const status = $('status');
const map = L.map('map', { boxZoom: false, maxZoom: 19 }).setView([35, 105], 4);
let baseLayer, previewGeneration = 0, previewStatus = '', viewLoading = false;
const scans = L.layerGroup().addTo(map);
let selected, selection, draft, startPoint, pointer, scanKey, latest, savedView;
let autoDownloadId, scanId, scanStage;
let selecting = false, active = false, seen = 0, failures = 0, pendingAction = false;
const previews = new Map();
const boundsStyle = { color: '#1769dc', weight: 2, fillOpacity: 0.1, interactive: false };

function clearScans() {
  scans.clearLayers();
  for (const preview of previews.values()) URL.revokeObjectURL(preview.url);
  previews.clear();
  scanKey = null;
}

function updateMapHint() {
  $('map-hint').textContent = selecting ? '拖出矩形选区。滚轮仍可缩放。'
    : `第 ${map.getZoom()} 级 · ${previewStatus || '滚轮缩放，拖动地图'}`;
}

async function showBase() {
  const generation = ++previewGeneration;
  if (baseLayer && map.hasLayer(baseLayer)) map.removeLayer(baseLayer);
  clearScans();
  const layer = $('preview').value === 'satellite' ? 'satellite' : 'standard';
  const secondary = layer === 'satellite' && field('layer').value === 'both';
  const source = field(secondary ? 'satelliteSource' : 'source').value;
  const config = {
    layer, source,
    sourceValue: field(secondary ? 'satelliteValue' : 'sourceValue').value,
    credit: field(secondary ? 'satelliteCredit' : 'credit').value,
  };
  previewStatus = '正在加载地图…';
  viewLoading = true;
  updateMapHint();
  try {
    const result = await (await request('/api/source', config)).json();
    if (generation !== previewGeneration || (active && $('follow').checked)) return;
    map.setMaxZoom(result.maxZoom);
    const attribution = document.createElement('span');
    attribution.textContent = result.attribution || '';
    let missing = 0;
    let tileError = '';
    const TileLayer = L.GridLayer.extend({
      createTile({ z, x, y }, done) {
        const tile = document.createElement('img');
        tile.alt = '';
        const abort = new AbortController();
        tile.cancelRequest = () => abort.abort();
        const path = `/api/browse/${result.source}/${z}/${x}/${y}`;
        fetch(path, {
          signal: abort.signal, headers: { 'X-Offline-Token': token },
        }).then(async (response) => {
          if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || '瓦片不可用');
          }
          if (response.headers.get('Content-Type') !== 'application/x-protobuf') return response.blob();
          const blob = await renderStreetTile(await response.arrayBuffer(), { z, x, y }, result.nativeZoom);
          const saved = await fetch(path, {
            method: 'POST', body: blob, signal: abort.signal, headers: { 'X-Offline-Token': token },
          });
          if (!saved.ok) throw new Error('未能保存街道瓦片');
          return blob;
        }).then(async (blob) => {
          const url = URL.createObjectURL(blob);
          try {
            tile.src = url;
            await tile.decode();
            if (!abort.signal.aborted) done(null, tile);
          } finally {
            URL.revokeObjectURL(url);
          }
        }).catch((error) => {
          if (!abort.signal.aborted) done(error, tile);
        });
        return tile;
      },
    });
    baseLayer = new TileLayer({ minZoom: 0, maxZoom: result.maxZoom, attribution: attribution.innerHTML });
    baseLayer.on('tileunload', ({ tile }) => tile.cancelRequest());
    baseLayer.on('loading', () => {
      missing = 0;
      tileError = '';
      viewLoading = true;
      previewStatus = '正在加载地图…';
      updateMapHint();
    });
    baseLayer.on('tileerror', ({ error }) => {
      missing += 1;
      tileError = error?.message || tileError;
    });
    baseLayer.on('load', () => {
      viewLoading = false;
      previewStatus = missing ? `${missing} 张瓦片未加载 · ${tileError || '可应用地图源后重试'}` : '当前画面已保存';
      updateMapHint();
    });
    baseLayer.addTo(map);
  } catch (error) {
    if (generation !== previewGeneration) return;
    viewLoading = false;
    previewStatus = error.message;
    updateMapHint();
  }
}
map.on('zoomend', updateMapHint);

function setMode(mode) {
  selecting = mode === 'select';
  $('select').setAttribute('aria-pressed', String(selecting));
  $('pan').setAttribute('aria-pressed', String(!selecting));
  $('map').classList.toggle('drawing', selecting);
  if (selecting) map.dragging.disable();
  else map.dragging.enable();
  updateMapHint();
}
$('pan').onclick = () => setMode('pan');
$('select').onclick = () => setMode('select');
$('preview').onchange = showBase;
$('refresh-preview').onclick = showBase;
$('clear-selection').onclick = () => {
  if (selection) map.removeLayer(selection);
  selected = selection = null;
  $('fit').disabled = $('clear-selection').disabled = true;
};
$('fit').onclick = () => { if (selected) map.fitBounds(selected, { padding: [24, 24] }); };

const surface = $('map');
function point(event) {
  const rect = surface.getBoundingClientRect();
  return map.containerPointToLatLng(L.point(
    Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
    Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
  ));
}
surface.addEventListener('pointerdown', (event) => {
  if (!selecting || active || pointer != null || event.button !== 0 || event.target.closest('.leaflet-control')) return;
  event.preventDefault();
  pointer = event.pointerId;
  surface.setPointerCapture(pointer);
  startPoint = point(event);
  draft = L.rectangle([startPoint, startPoint], boundsStyle).addTo(map);
});
surface.addEventListener('pointermove', (event) => {
  if (event.pointerId === pointer && draft) draft.setBounds([startPoint, point(event)]);
});
function endSelection(event, commit) {
  if (event.pointerId !== pointer) return;
  if (commit && draft) {
    const candidate = L.latLngBounds(startPoint, point(event));
    if (candidate.getEast() - candidate.getWest() > 0.000001 && candidate.getNorth() - candidate.getSouth() > 0.000001) {
      if (selection) map.removeLayer(selection);
      selected = candidate;
      selection = L.rectangle(selected, boundsStyle).addTo(map);
      $('fit').disabled = $('clear-selection').disabled = false;
      status.textContent = '选区已就绪，可以估算或开始打包。';
      setMode('pan');
    }
  }
  if (draft) map.removeLayer(draft);
  draft = null;
  pointer = null;
}
surface.addEventListener('pointerup', (event) => endSelection(event, true));
surface.addEventListener('pointercancel', (event) => endSelection(event, false));
surface.addEventListener('lostpointercapture', (event) => endSelection(event, false));

function updateSource() {
  const layer = field('layer').value;
  const satellite = layer === 'satellite';
  const source = field('source');
  source.querySelector('[value=nasa]').disabled = !satellite;
  source.querySelector('[value=streets]').disabled = satellite;
  source.querySelector('[value=natural-earth]').disabled = satellite;
  if (source.selectedOptions[0]?.disabled) source.value = satellite ? 'nasa' : 'streets';
  $('source-label').querySelector('span').textContent = layer === 'both' ? '标准地图来源' : '地图来源';
  const overview = source.value === 'natural-earth' || source.value === 'nasa';
  const streets = source.value === 'streets';
  const satelliteSource = field('satelliteSource').value;
  $('source-hint').hidden = !streets && !overview && !(layer === 'both' && satelliteSource === 'nasa');
  $('source-hint').textContent = streets
    ? '放大查看道路、建筑和地名。浏览过的瓦片可直接打包，每包最多 3,000 张、50 MB。'
    : '概览源适合查看大范围位置。需要更清晰的卫星影像时，可选用支持离线打包的 XYZ 源。';
  field('mode').querySelector('[value=scan]').disabled = streets;
  if (streets) field('mode').value = 'viewed';
  $('preview').querySelector('[value=street]').disabled = satellite;
  $('preview').querySelector('[value=satellite]').disabled = layer === 'standard';
  if ($('preview').selectedOptions[0]?.disabled) $('preview').value = satellite ? 'satellite' : 'street';
  $('primary-source').hidden = !['url', 'directory'].includes(source.value);
  $('satellite-settings').hidden = layer !== 'both';
  $('satellite-settings').disabled = layer !== 'both';
  $('satellite-source').hidden = !['url', 'directory'].includes(satelliteSource);
  setZoomLimit('minZoom', 'maxZoom', source.value === 'natural-earth' ? 6 : source.value === 'nasa' ? 8 : 19);
  setZoomLimit('satelliteMinZoom', 'satelliteMaxZoom', satelliteSource === 'nasa' ? 8 : 19);
  for (const [name, id] of [['source', 'primary-value-label'], ['satelliteSource', 'satellite-value-label']]) {
    $(id).textContent = field(name).value === 'directory' ? '本机瓦片目录路径' : '瓦片网址（含 {z}、{x}、{y}）';
  }
}

function setZoomLimit(minName, maxName, limit) {
  const maximum = field(maxName);
  if (Number(maximum.max) !== limit && maximum.valueAsNumber === Number(maximum.max)) maximum.value = limit;
  for (const name of [minName, maxName]) {
    const control = field(name);
    if (Number(control.max) !== limit && control.valueAsNumber > limit) control.value = limit;
    control.max = limit;
  }
}
form.addEventListener('change', (event) => {
  const name = event.target.name;
  if (['layer', 'source', 'satelliteSource'].includes(name)) {
    updateSource();
    const secondary = $('preview').value === 'satellite' && field('layer').value === 'both';
    if (name === 'layer' || name === (secondary ? 'satelliteSource' : 'source')) void showBase();
  }
});
updateSource();

async function request(path, data) {
  const response = await fetch(path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'X-Offline-Token': token, 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || '本地工具未响应，请确认启动终端仍在运行。');
  }
  return response;
}

function input() {
  if (field('mode').value === 'viewed' && viewLoading) throw new Error('请等当前地图加载完成后再打包。');
  if (!selected) {
    if (field('mode').value === 'scan') throw new Error('请先在地图上框选范围。');
    return { ...Object.fromEntries(new FormData(form)), bounds: '-180,-85.0511287798066,180,85.0511287798066' };
  }
  const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value));
  if (selected.getWest() < -180 || selected.getEast() > 180) {
    throw new Error('选区超出地图经度范围。跨越 ±180° 的区域请分开打包。');
  }
  const bounds = [selected.getWest(), clamp(selected.getSouth(), 85.0511287798066),
    selected.getEast(), clamp(selected.getNorth(), 85.0511287798066)];
  return { ...Object.fromEntries(new FormData(form)), bounds: bounds.join(',') };
}

function setBusy(busy) {
  active = busy;
  for (const control of form.elements) control.disabled = busy;
  $('preview').disabled = $('refresh-preview').disabled = busy;
  $('select').disabled = busy;
  $('fit').disabled = $('clear-selection').disabled = busy || !selected;
  $('stop').disabled = !busy;
  if (!busy) updateSource();
}

$('estimate').onclick = async () => {
  if (pendingAction) return;
  pendingAction = true;
  try {
    const result = await (await request('/api/plan', input())).json();
    const cached = result.layers.filter((layer) => layer.cached).map((layer) => {
      const name = layer.layer === 'satellite' ? '卫星' : '标准';
      const levels = layer.minZoom === layer.maxZoom ? layer.maxZoom : `${layer.minZoom}–${layer.maxZoom}`;
      return `${name}已浏览 ${layer.count.toLocaleString()} 张（${levels} 级）`;
    });
    status.textContent = cached.length ? `预计 ${result.total.toLocaleString()} 张瓦片 · ${cached.join(' · ')}`
      : `预计 ${result.total.toLocaleString()} 张瓦片。`;
  } catch (error) { status.textContent = error.message; }
  finally { pendingAction = false; }
};

form.onsubmit = async (event) => {
  event.preventDefault();
  if (active || pendingAction) return;
  pendingAction = true;
  try {
    const data = input();
    const job = await (await request('/api/start', data)).json();
    autoDownloadId = job.download;
    savedView = [map.getCenter(), map.getZoom()];
    $('download').hidden = true;
    seen = 0;
    scanStage = null;
    latest = null;
    setMode('pan');
    setBusy(true);
    status.textContent = '正在准备选区…';
  } catch (error) { status.textContent = error.message; }
  finally { pendingAction = false; }
};

$('stop').onclick = async () => {
  $('stop').disabled = true;
  try {
    await request('/api/stop', {});
    status.textContent = '正在停止，已取得的瓦片会保留。';
  } catch (error) {
    status.textContent = error.message;
    $('stop').disabled = false;
  }
};

async function showTile(tile) {
  if (!$('follow').checked || !active) return;
  const level = `${tile.layer}:${tile.z}`;
  const key = `${tile.x}:${tile.y}`;
  if (scanKey === level && previews.has(key)) return;
  const id = scanId;
  let url;
  try {
    const response = await request(`/api/tile?sequence=${tile.sequence}&id=${encodeURIComponent(id)}`);
    url = URL.createObjectURL(await response.blob());
    const image = new Image();
    image.src = url;
    await image.decode();
    if (scanId !== id || latest?.sequence !== tile.sequence || !active || !$('follow').checked) return;
    if (scanKey !== level) {
      clearScans();
      scanKey = level;
    }
    if (previews.has(key)) return;
    if (baseLayer && map.hasLayer(baseLayer)) map.removeLayer(baseLayer);
    const nw = map.unproject(L.point(tile.x * 256, tile.y * 256), tile.z);
    const se = map.unproject(L.point((tile.x + 1) * 256, (tile.y + 1) * 256), tile.z);
    const tileBounds = L.latLngBounds(nw, se);
    const overlay = L.imageOverlay(image, tileBounds, { interactive: false });
    previews.set(key, { url, overlay: overlay.addTo(scans) });
    url = null;
    map.setMaxZoom(19);
    map.setView(tileBounds.getCenter(), tile.z, { animate: false });
    if (previews.size > 48) {
      const oldest = previews.keys().next().value;
      const item = previews.get(oldest);
      scans.removeLayer(item.overlay);
      URL.revokeObjectURL(item.url);
      previews.delete(oldest);
    }
  } catch { /* A failed preview does not affect the saved tiles. */ }
  finally { if (url) URL.revokeObjectURL(url); }
}
$('follow').onchange = () => {
  if (!$('follow').checked) showBase();
  else if (latest) void showTile(latest);
};
$('pan').addEventListener('click', () => {
  if (active) {
    $('follow').checked = false;
    showBase();
  }
});

async function poll() {
  try {
    if (pendingAction) return;
    const state = await (await request('/api/status')).json();
    if (pendingAction) return;
    failures = 0;
    if (state.status === 'running' || state.status === 'stopping') {
      if (!active) {
        savedView = [map.getCenter(), map.getZoom()];
        setMode('pan');
        setBusy(true);
      }
      $('stop').disabled = state.status === 'stopping';
      $('progress').max = state.total || 1;
      $('progress').value = state.done || 0;
      if (state.download !== scanId || state.stage !== scanStage) {
        scanId = state.download;
        scanStage = state.stage;
        seen = 0;
      }
      latest = state.tile;
      const label = scanStage === 'satellite' ? '卫星实景地图' : '标准地图';
      const count = `${state.done.toLocaleString()} / ${state.total.toLocaleString()} 张`;
      const zoom = state.network?.z ?? latest?.z;
      const retry = state.network?.retryWait;
      const networkStatus = retry != null ? ' · 连接中断或服务繁忙，等待重试'
        : state.network ? ` · 正在下载（第 ${state.network.attempt}/3 次）` : '';
      status.textContent = state.status === 'stopping'
        ? '正在停止，已取得的瓦片会保留。'
        : scanStage === 'bundle' ? '两层扫描完成，正在合并地图包…'
        : scanStage ? `正在扫描${label}${zoom != null ? ` · 第 ${zoom} 级` : ''} · ${count}${networkStatus}`
        : `正在准备选区… · ${count}`;
      if (latest && latest.sequence !== seen) {
        seen = latest.sequence;
        void showTile(latest);
      }
    } else if (state.status !== 'idle' && (active || state.status === 'done' && $('download').hidden)) {
      if (active) {
        setBusy(false);
        showBase();
        if (savedView) map.setView(...savedView, { animate: false });
      }
      if (state.status === 'done') {
        $('progress').max = state.total || 1;
        $('progress').value = state.total;
        $('download').href = `/download?id=${encodeURIComponent(state.download)}`;
        $('download').hidden = false;
        status.textContent = `已完成，共 ${state.total.toLocaleString()} 张瓦片。`;
        if (autoDownloadId === state.download) $('download').click();
      } else {
        status.textContent = state.status === 'stopped' ? '已停止。保持原设置再开始，可继续打包。' : (state.message || '打包失败。');
      }
      autoDownloadId = null;
    }
  } catch {
    if (++failures >= 2 && !pendingAction) {
      status.textContent = '无法连接本地工具，请确认启动终端仍在运行。';
    }
  } finally {
    setTimeout(poll, active ? 220 : 800);
  }
}

if (token) {
  void showBase();
  void poll();
}
else {
  status.textContent = '请从启动终端打开完整的工具地址。';
  setBusy(true);
  $('stop').disabled = true;
}
