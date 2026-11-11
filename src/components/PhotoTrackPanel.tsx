import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleMarker, Marker, Polyline, Rectangle, Tooltip, useMap, useMapEvents } from "react-leaflet";
import { convertFileSrc } from "@tauri-apps/api/core";
import L from "leaflet";
import * as api from "../api/tauri";
import type { SavedTrack, TrackBounds, TrackPhoto, TrackSettings } from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import { buildTrackDays, dateRange, trackGap } from "../utils/photoTracks";
import type { TrackDay, TrackPoint } from "../utils/photoTracks";
import { buildSpiderOffsets, photoThumbnailIcon, FIRST_PHOTO_RING_RADIUS, PHOTO_THUMBNAIL_SIZE } from "../utils/mapSpider";
import Icon from "./Icon";

const BLUE = "#2563eb";
const FAN_PAGE_SIZE = 8;
const NEARBY_POINT_PIXELS = 56;
const PANEL_WIDTH = 360;
const PANEL_INSET = 12;
const TIME = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const position = (point: TrackPoint): L.LatLngTuple => [point.latitude, point.longitude];

type ExpandedPoint = { anchor: TrackPoint; photos: TrackPhoto[]; page: number };

function leafletBounds([west, south, east, north]: TrackBounds): L.LatLngBoundsExpression {
  return [[south, west], [north, east]];
}

function TrackSelection({ onFinish, onCancel }: {
  onFinish: (bounds: L.LatLngBounds) => void;
  onCancel: () => void;
}) {
  const map = useMap();
  const start = useRef<{ id: number; x: number; y: number; latLng: L.LatLng } | null>(null);
  const [preview, setPreview] = useState<L.LatLngBounds | null>(null);
  useEffect(() => {
    const dragging = map.dragging.enabled();
    map.dragging.disable();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      if (dragging) map.dragging.enable();
    };
  }, [map, onCancel]);

  const coordinate = (event: React.PointerEvent) => map.mouseEventToLatLng(event.nativeEvent);
  return <>
    {preview && <Rectangle bounds={preview} pathOptions={{ color: BLUE, weight: 2, fillOpacity: 0.08 }} interactive={false} />}
    {createPortal(
      <div className="absolute inset-0 z-[900] cursor-crosshair touch-none" aria-hidden="true"
        onPointerDown={(event) => {
          if (event.button !== 0 || start.current) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          start.current = { id: event.pointerId, x: event.clientX, y: event.clientY, latLng: coordinate(event) };
        }}
        onPointerMove={(event) => {
          if (start.current?.id === event.pointerId) setPreview(L.latLngBounds(start.current.latLng, coordinate(event)));
        }}
        onPointerUp={(event) => {
          const origin = start.current;
          if (!origin || origin.id !== event.pointerId) return;
          start.current = null;
          setPreview(null);
          if (Math.abs(event.clientX - origin.x) >= 8 && Math.abs(event.clientY - origin.y) >= 8) {
            onFinish(L.latLngBounds(origin.latLng, coordinate(event)));
          }
        }}
        onPointerCancel={() => { start.current = null; setPreview(null); }}
      />,
      map.getContainer(),
    )}
  </>;
}

function Direction({ from, to }: { from: L.LatLngTuple; to: L.LatLngTuple }) {
  const a = L.CRS.EPSG3857.project(L.latLng(from));
  const b = L.CRS.EPSG3857.project(L.latLng(to));
  const center = L.CRS.EPSG3857.unproject(a.add(b).divideBy(2));
  const angle = Math.atan2(a.y - b.y, b.x - a.x) * 180 / Math.PI;
  const icon = L.divIcon({
    className: "",
    html: `<span aria-hidden="true" style="display:block;transform:rotate(${angle}deg);color:${BLUE};font-size:16px;line-height:16px;text-shadow:0 0 3px white">▶</span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
  return <Marker position={center} icon={icon} interactive={false} keyboard={false} />;
}

function useTrackThumbnail(id: number) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.getThumbnailPath(id, "small").then((path) => {
      if (live) setUrl(convertFileSrc(path));
    }).catch(() => {});
    return () => { live = false; };
  }, [id]);
  return url;
}

function TrackThumbnail({ photo, onView }: { photo: TrackPhoto; onView: () => void }) {
  const url = useTrackThumbnail(photo.id);
  return <button type="button" className="flex w-full items-center gap-2 rounded-md bg-surface-primary p-2 text-left hover:bg-surface-secondary" onClick={onView}>
    {url && <img src={url} alt="" className="h-12 w-16 shrink-0 rounded object-cover" />}
    <span className="min-w-0 flex-1 truncate">{photo.filename}</span><span className="shrink-0 text-accent-link">查看照片</span>
  </button>;
}

function TrackPhotoMarker({ photo, displayPosition, selected, onView }: {
  photo: TrackPhoto;
  displayPosition: L.LatLng;
  selected: boolean;
  onView: () => void;
}) {
  const url = useTrackThumbnail(photo.id);
  const icon = useMemo(() => photoThumbnailIcon(url, selected), [url, selected]);
  return <>
    <Polyline positions={[[photo.latitude, photo.longitude], displayPosition]}
      pathOptions={{ color: "#475569", weight: 1.5, opacity: 0.75 }} interactive={false} />
    <Marker position={displayPosition} icon={icon} title={`查看照片：${photo.filename}`}
      zIndexOffset={selected ? 1200 : 1000} eventHandlers={{ click: onView }} />
  </>;
}

export default function PhotoTrackPanel({ onClose, onViewPhoto }: {
  onClose: () => void;
  onViewPhoto: (id: number) => void;
}) {
  const map = useMap();
  const panelContentId = useId();
  const [collapsed, setCollapsed] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [bounds, setBounds] = useState<TrackBounds | null>(null);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [joined, setJoined] = useState<string[]>([]);
  const [days, setDays] = useState<TrackDay[]>([]);
  const [date, setDate] = useState("");
  const [selectedPhoto, setSelectedPhoto] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<ExpandedPoint | null>(null);
  const [saved, setSaved] = useState<SavedTrack[]>([]);
  const [savedId, setSavedId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const timeline = useRef<HTMLOListElement>(null);
  const day = days.find((item) => item.date === date);
  const points = day?.points ?? [];
  const photo = points.flatMap((point) => point.photos).find((item) => item.id === selectedPhoto);
  useMapEvents({
    click: () => setExpanded(null),
    zoomstart: () => setExpanded(null),
    dragstart: () => setExpanded(null),
  });

  useEffect(() => {
    if (!expanded) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !useStore.getState().lightboxPhotoId) setExpanded(null);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [expanded]);

  useEffect(() => {
    mounted.current = true;
    if (panel.current) {
      L.DomEvent.disableClickPropagation(panel.current);
      L.DomEvent.disableScrollPropagation(panel.current);
    }
    let live = true;
    api.listPhotoTracks().then((tracks) => { if (live) setSaved(tracks); })
      .catch((reason) => { if (live) setError(String(reason)); });
    return () => { live = false; mounted.current = false; };
  }, []);

  const invalidateResult = () => {
    setExpanded(null);
    setDays([]);
    setSelectedPhoto(null);
    setJoined([]);
    setNotice("");
    setError("");
  };

  const finishSelection = (selection: L.LatLngBounds) => {
    setDrawing(false);
    const west = selection.getWest();
    const east = selection.getEast();
    const offset = Math.floor(((west + east) / 2 + 180) / 360) * 360;
    if (west - offset < -180 || east - offset > 180) {
      setError("请在日期变更线两侧分别框选。");
      return;
    }
    setBounds([west - offset, selection.getSouth(), east - offset, selection.getNorth()]);
    if (offset) {
      const center = map.getCenter();
      map.panTo([center.lat, center.lng - offset], { animate: false });
    }
    invalidateResult();
  };

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try { await operation(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  async function loadTrack(settings: TrackSettings, track: SavedTrack | null = null) {
    await run(async () => {
      const { startAt, endBefore } = dateRange(settings.start_date, settings.end_date);
      const result = buildTrackDays(await api.getTrackPhotos(settings.bounds, startAt, endBefore));
      if (!mounted.current) return;
      setBounds(settings.bounds);
      setStartDate(settings.start_date);
      setEndDate(settings.end_date);
      setJoined(settings.joined_gaps);
      setExpanded(null);
      setDays(result);
      setDate(result[0]?.date ?? "");
      setSelectedPhoto(result[0]?.points[0]?.photos[0].id ?? null);
      if (track) {
        setSavedId(track.id);
        setName(track.name);
        map.fitBounds(leafletBounds(settings.bounds), { maxZoom: 17 });
      }
      if (!result.length) setNotice("这个选区和日期范围内没有同时带拍摄时间和坐标的照片。");
    });
  }

  const settings = bounds && { bounds, start_date: startDate, end_date: endDate, joined_gaps: joined };

  function selectPhoto(id: number, pointId: number) {
    setSelectedPhoto(id);
    timeline.current?.querySelector(`[data-point-id="${pointId}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function choosePoint(point: TrackPoint) {
    const id = point.photos[0].id;
    selectPhoto(id, id);
    if (expanded?.anchor === point) {
      setExpanded(null);
      return;
    }
    const anchor = map.latLngToContainerPoint(position(point));
    const nearby = points.filter((candidate) =>
      map.latLngToContainerPoint(position(candidate)).distanceTo(anchor) <= NEARBY_POINT_PIXELS,
    );
    const photos = nearby.flatMap((candidate) => candidate.photos)
      .sort((a, b) => a.taken_at - b.taken_at || a.id - b.id);
    const page = Math.floor(photos.findIndex((item) => item.id === id) / FAN_PAGE_SIZE);
    setExpanded({ anchor: point, photos, page });
  }

  const first = (expanded?.page ?? 0) * FAN_PAGE_SIZE;
  const fanPhotos = expanded?.photos.slice(first, first + FAN_PAGE_SIZE) ?? [];
  const fanOffsets = buildSpiderOffsets(fanPhotos.length);
  const fanCenter = expanded && map.latLngToContainerPoint(position(expanded.anchor));
  if (fanCenter) {
    const size = map.getSize();
    const margin = FIRST_PHOTO_RING_RADIUS + PHOTO_THUMBNAIL_SIZE / 2 + 8;
    const right = collapsed ? size.x : size.x - Math.min(PANEL_WIDTH, size.x - 2 * PANEL_INSET) - PANEL_INSET;
    const clamp = (value: number, extent: number) => extent > 2 * margin
      ? Math.min(extent - margin, Math.max(margin, value)) : extent / 2;
    fanCenter.x = clamp(fanCenter.x, right > 2 * margin ? right : size.x);
    fanCenter.y = clamp(fanCenter.y, size.y);
  }

  return <>
    {bounds && <Rectangle bounds={leafletBounds(bounds)} interactive={false}
      pathOptions={{ color: BLUE, weight: 1.5, dashArray: "5 5", fillOpacity: 0.03 }} />}
    {drawing && <TrackSelection onFinish={finishSelection} onCancel={() => setDrawing(false)} />}
    {points.map((point, index) => {
      const previous = points[index - 1];
      const gap = previous && trackGap(previous, point);
      const endpoint = index === 0 ? (points.length === 1 ? "拍摄点" : "起点") : index === points.length - 1 ? "终点" : "";
      const selected = point.photos.some((item) => item.id === selectedPhoto);
      return <TrackPointLayer key={point.photos[0].id} point={point} previous={previous}
        connected={!!gap && (!gap.reason || joined.includes(gap.id))}
        showDirection={points.length <= 60 || index % Math.ceil(points.length / 60) === 0}
        endpoint={endpoint} selected={selected} showTooltip={!expanded} onClick={() => choosePoint(point)} />;
    })}
    {fanCenter && fanPhotos.map((item, index) => <TrackPhotoMarker key={item.id} photo={item}
      displayPosition={map.containerPointToLatLng(fanCenter.add(L.point(fanOffsets[index])))}
      selected={item.id === selectedPhoto} onView={() => {
        const pointId = points.find((point) => point.photos.some((candidate) => candidate.id === item.id))?.photos[0].id;
        selectPhoto(item.id, pointId ?? item.id);
        onViewPhoto(item.id);
      }} />)}
    {createPortal(
      <section ref={panel} aria-label="拍摄轨迹" className="absolute top-14 z-[1100] flex max-h-[calc(100%-4.5rem)] flex-col gap-3 overflow-auto rounded-xl border border-surface-secondary bg-bg-secondary p-3 text-sm text-text-primary shadow-xl"
        style={{ right: PANEL_INSET, maxWidth: `calc(100% - ${2 * PANEL_INSET}px)`, width: collapsed ? "max-content" : PANEL_WIDTH }}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">拍摄轨迹</h2>
          <div className="flex items-center gap-2">
            <button type="button" className="ui-button h-8 w-8 p-0"
              aria-label={collapsed ? "展开拍摄轨迹面板" : "折叠拍摄轨迹面板"}
              title={collapsed ? "展开面板" : "折叠面板"}
              aria-expanded={!collapsed} aria-controls={panelContentId} onClick={() => {
                if (!collapsed) setDrawing(false);
                setCollapsed(!collapsed);
              }}>
              <Icon name="chevronUp" size={16} className={collapsed ? "rotate-180" : ""} />
            </button>
            {!collapsed && <button type="button" className="ui-button" onClick={onClose} aria-label="关闭拍摄轨迹">关闭</button>}
          </div>
        </div>
        <div id={panelContentId} hidden={collapsed} className={collapsed ? undefined : "flex flex-col gap-3"}>
          {saved.length > 0 && <label className="flex items-center gap-2">已保存
            <select className="ui-button min-w-0 flex-1" disabled={busy || drawing} value={savedId ?? ""} onChange={(event) => {
              const track = saved.find((item) => item.id === Number(event.target.value));
              if (track) void loadTrack(track.settings, track);
              else {
                setSavedId(null);
                setName("");
                setBounds(null);
                setStartDate("");
                setEndDate("");
                invalidateResult();
              }
            }}>
              <option value="">新轨迹</option>
              {saved.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}
            </select>
          </label>}
          <div className="flex items-center gap-2">
            <button className="ui-button" disabled={busy} onClick={() => { setDrawing(!drawing); setExpanded(null); }}>{drawing ? "取消框选" : bounds ? "重新框选" : "框选区域"}</button>
            <span className="text-xs text-text-secondary">{drawing ? "在地图上拖出一个矩形" : bounds ? "已选定区域" : "先缩放到景区，再框选"}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="min-w-0">开始日期<input className="ui-button mt-1 w-full" type="date" disabled={busy} value={startDate}
              onChange={(event) => { setStartDate(event.target.value); invalidateResult(); }} /></label>
            <label className="min-w-0">结束日期<input className="ui-button mt-1 w-full" type="date" disabled={busy} min={startDate || undefined} value={endDate}
              onChange={(event) => { setEndDate(event.target.value); invalidateResult(); }} /></label>
          </div>
          <p className="text-xs text-text-secondary">日期留空时，使用选区内所有拍摄日期。</p>
          <button className="ui-button bg-accent-primary text-white" disabled={!settings || drawing || busy}
            onClick={() => { if (settings) void loadTrack(settings); }}>{busy ? "处理中…" : "生成轨迹"}</button>
          {error && <p role="alert" className="break-words text-sm text-red-600">{error}</p>}
          {notice && <p role="status" className="text-text-secondary">{notice}</p>}
          {day && settings && <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2">查看日期
                <select className="ui-button" value={date} onChange={(event) => {
                  const next = days.find((item) => item.date === event.target.value);
                  if (next) { setExpanded(null); setDate(next.date); setSelectedPhoto(next.points[0].photos[0].id); }
                }}>
                  {days.map((item) => <option key={item.date}>{item.date}</option>)}
                </select>
              </label>
              <span className="text-xs text-text-secondary">{points.length} 个点 · {points.reduce((count, point) => count + point.photos.length, 0)} 张照片</span>
            </div>
            <p className="text-xs text-text-secondary">连线按照片拍摄顺序推算。点轨迹上的圆点展开缩略图。</p>
            {expanded && <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="flex-1">缩略图 {first + 1}–{first + fanPhotos.length} / {expanded.photos.length}</span>
              {expanded.photos.length > FAN_PAGE_SIZE && <>
                <button type="button" className="ui-button" disabled={expanded.page === 0}
                  onClick={() => setExpanded({ ...expanded, page: expanded.page - 1 })}>上一组</button>
                <button type="button" className="ui-button" disabled={first + fanPhotos.length === expanded.photos.length}
                  onClick={() => setExpanded({ ...expanded, page: expanded.page + 1 })}>下一组</button>
              </>}
              <button type="button" className="ui-button" onClick={() => setExpanded(null)}>收起缩略图</button>
            </div>}
            <ol ref={timeline} className="max-h-60 space-y-2 overflow-auto">
              {points.map((point, index) => {
                const gap = index > 0 ? trackGap(points[index - 1], point) : null;
                const anchor = point.photos[0];
                const selected = point.photos.some((item) => item.id === selectedPhoto);
                return <li key={anchor.id} data-point-id={anchor.id} className={`rounded-md border p-2 ${selected ? "border-accent-primary" : "border-surface-secondary"}`}>
                  {gap?.reason && <div className="mb-1 flex flex-wrap items-center justify-between gap-1 text-xs">
                    <span className="text-text-secondary">{gap.reason}</span>
                    <button className="ui-button" disabled={busy} onClick={() => setJoined((current) =>
                      current.includes(gap.id) ? current.filter((id) => id !== gap.id) : [...current, gap.id])}>
                      {joined.includes(gap.id) ? "断开" : "连接此段"}
                    </button>
                  </div>}
                  <div className="mb-1 text-xs font-medium">{index + 1}. {TIME.format(anchor.taken_at * 1000)} · {point.photos.length} 张</div>
                  {point.photos.map((item) => <button key={item.id} title={item.filename}
                    className={`block w-full truncate rounded px-1.5 py-0.5 text-left text-xs hover:bg-surface-primary ${item.id === selectedPhoto ? "text-accent-link" : ""}`}
                    onClick={() => { setExpanded(null); setSelectedPhoto(item.id); map.panTo([item.latitude, item.longitude]); }}>{item.filename}</button>)}
                </li>;
              })}
            </ol>
            {photo && <TrackThumbnail key={photo.id} photo={photo} onView={() => onViewPhoto(photo.id)} />}
            <label>轨迹名称<input className="ui-button mt-1 w-full" maxLength={100} placeholder="例如：黄山 · 1 月 2 日" value={name}
              disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
            <div className="flex gap-2">
              <button className="ui-button" disabled={busy || !name.trim()} onClick={() => void run(async () => {
                const record = await api.savePhotoTrack(savedId, name, settings);
                setSaved((current) => [record, ...current.filter((item) => item.id !== record.id)]);
                setSavedId(record.id);
                setNotice("轨迹已保存。");
              })}>保存轨迹</button>
              {savedId !== null && <button className="ui-button" disabled={busy} onClick={() => void run(async () => {
                await api.deletePhotoTrack(savedId);
                setSaved((current) => current.filter((item) => item.id !== savedId));
                setSavedId(null);
                setNotice("已移除保存的轨迹。");
              })}>移除保存</button>}
            </div>
          </>}
        </div>
      </section>,
      map.getContainer(),
    )}
  </>;
}

function TrackPointLayer({ point, previous, connected, showDirection, endpoint, selected, showTooltip, onClick }: {
  point: TrackPoint;
  previous?: TrackPoint;
  connected: boolean;
  showDirection: boolean;
  endpoint: string;
  selected: boolean;
  showTooltip: boolean;
  onClick: () => void;
}) {
  const current = position(point);
  const start = previous && position(previous);
  const color = endpoint === "起点" ? "#047857" : endpoint === "终点" ? "#b91c1c" : BLUE;
  return <>
    {connected && start && <>
      <Polyline positions={[start, current]} pathOptions={{ color: BLUE, weight: 4, opacity: 0.8 }} interactive={false} />
      {showDirection && (start[0] !== current[0] || start[1] !== current[1]) && <Direction from={start} to={current} />}
    </>}
    <CircleMarker center={current} radius={selected ? 9 : endpoint ? 7 : 6} bubblingMouseEvents={false}
      pathOptions={{ color: "white", weight: 2, fillColor: color, fillOpacity: 1 }} eventHandlers={{ click: onClick }}>
      {showTooltip && <Tooltip permanent={!!endpoint} direction="top" offset={[0, -8]}>{endpoint || `${point.photos.length} 张照片`}</Tooltip>}
    </CircleMarker>
  </>;
}
