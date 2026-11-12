import React, { useEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { MapContainer, Marker, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import type { Photo, FaceDetection, FaceCluster, CustomAttribute, ManualTag } from "../types";
import { imageErrorMessage } from "../utils/imageError";
import { formatDate, formatDateTime, formatFileSize } from "../utils/format";
import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import { convertFileSrc } from "@tauri-apps/api/core";
import CachedTileLayer from "./CachedTileLayer";
import MapLayerToggle from "./MapLayerToggle";
import ContextMenu from "./ContextMenu";
import MapSearch from "./MapSearch";
import type { MapLayerStyle } from "../api/tauri";
import { useNavigate } from "react-router-dom";
import { MAP_PIN_ICON_URL, MAP_PIN_SHADOW_URL, mapPinIcon } from "./mapPin";
import StarRating from "./StarRating";

const MAP_CENTER: [number, number] = [39.9, 116.4];
const MAP_ZOOM = 4;
const FILMSTRIP_HEIGHT = 90;
const THUMB_SIZE = 64;
const THUMB_GAP = 4;

interface Props {
  photoId: number;
  onClose: () => void;
  width?: number;
  embedded?: boolean;
  onEditingFaceChange?: (faceId: number | null) => void;
}

// ---- Map helpers ----

function MapViewport({ center }: { center: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    // A non-animated pan preserves the user's zoom and the existing map
    // instance, while avoiding WKWebView's marker-pane transform race. Size is
    // stable in this fullscreen editor, so invalidating it here is unnecessary.
    map.stop();
    map.panTo(center, { animate: false });
  }, [center[0], center[1], map]);
  return null;
}

function MapInstanceBridge({ onReady }: { onReady: (map: L.Map | null) => void }) {
  const map = useMap();
  useEffect(() => {
    onReady(map);
    return () => onReady(null);
  }, [map, onReady]);
  return null;
}

/**
 * Render the editable GPS pin outside Leaflet's panes.
 *
 * WKWebView can temporarily promote the asynchronously loaded tile pane above
 * Leaflet's marker/control panes while zooming. The old Marker therefore still
 * existed in React state, but was visually covered after a few draft edits.
 * Keeping the pin in our own sibling overlay avoids that compositor race.
 */
function StableGpsOverlay({
  map,
  location,
}: {
  map: L.Map | null;
  location: { lat: number; lng: number } | null;
}) {
  const [point, setPoint] = useState<L.Point | null>(null);

  useEffect(() => {
    if (!map || !location) {
      setPoint(null);
      return;
    }

    const update = () => {
      setPoint(map.latLngToContainerPoint([location.lat, location.lng]));
    };

    update();
    map.on("move zoom resize viewreset moveend zoomend", update);
    return () => {
      map.off("move zoom resize viewreset moveend zoomend", update);
    };
  }, [location?.lat, location?.lng, map]);

  if (!point || !location) return null;
  return (
    <div
      data-testid="gps-overlay-marker"
      aria-label={`GPS ${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`}
      className="pointer-events-none absolute z-30 h-[41px] w-[41px]"
      style={{ left: point.x, top: point.y, transform: "translate(-12px, -41px)" }}
    >
      <img src={MAP_PIN_SHADOW_URL} alt="" aria-hidden="true" className="absolute inset-0 h-[41px] w-[41px] max-w-none" />
      <img src={MAP_PIN_ICON_URL} alt="" aria-hidden="true" className="absolute left-0 top-0 h-[41px] w-[25px] max-w-none" />
    </div>
  );
}

function TileEvents({ onGpsChange }: { onGpsChange: (lat: number, lng: number) => void }) {
  useMapEvents({ click(e) { onGpsChange(e.latlng.lat, e.latlng.lng); } });
  return null;
}

// Cache for batch editor thumbnails
const batchThumbCache = new Map<number, string>();

// ---- Fullscreen Batch GPS Editor ----

export function GpsBatchEditor({
  photos,
  currentPhotoId,
  initialMode = "single",
  initialSelectedIds = [],
  photoLocations,
  onApply,
  onApplyIndividual,
  onClose,
}: {
  photos: Photo[];
  currentPhotoId: number;
  initialMode?: "single" | "batch";
  initialSelectedIds?: number[];
  photoLocations: Map<number, { lat: number; lng: number }>;
  onApply: (photoIds: number[], lat: number | null, lng: number | null) => Promise<void>;
  onApplyIndividual: (updates: Array<{ photoId: number; latitude: number | null; longitude: number | null }>) => Promise<void>;
  onClose: () => void;
}) {
  // The editor is a self-contained session. Thumbnail/AI refreshes in the
  // parent must not replace or briefly empty the filmstrip while draft GPS
  // coordinates are being edited.
  const [editorPhotos] = useState(() => photos);
  // Keep the focused photo by its stable database id. The parent photo list can
  // be refreshed while thumbnails/AI metadata are arriving; an array index can
  // then briefly point at another photo and make its GPS marker disappear.
  const [focusedPhotoId, setFocusedPhotoId] = useState<number | null>(() =>
    editorPhotos.find((p) => p.id === currentPhotoId)?.id ?? editorPhotos[0]?.id ?? null
  );
  const focusedIdx = editorPhotos.findIndex((photo) => photo.id === focusedPhotoId);
  const currentIdx = focusedIdx >= 0 ? focusedIdx : 0;
  const currentPhoto = editorPhotos[currentIdx] || null;
  const [editMode, setEditMode] = useState(initialMode);

  // Preserve every coordinate observed during this editor session. App-level
  // photo refreshes may temporarily omit metadata; treating that transient gap
  // as "no GPS" caused the marker and info overlay to flash and vanish.
  const [knownLocations, setKnownLocations] = useState(() => new Map(photoLocations));
  useEffect(() => {
    setKnownLocations((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [photoId, location] of photoLocations) {
        const existing = next.get(photoId);
        if (!existing || existing.lat !== location.lat || existing.lng !== location.lng) {
          next.set(photoId, location);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [photoLocations]);

  const initialLoc = currentPhoto ? knownLocations.get(currentPhoto.id!) : null;
  const [mapCenter, setMapCenter] = useState<[number, number]>(
    initialLoc ? [initialLoc.lat, initialLoc.lng] : MAP_CENTER
  );
  const [targetLocation, setTargetLocation] = useState<{ lat: number; lng: number } | null>(initialLoc ?? null);
  const [draftLocations, setDraftLocations] = useState<Map<number, { lat: number; lng: number } | null>>(new Map());
  const [selectedIds, setSelectedIds] = useState(() => {
    const ids = new Set(initialSelectedIds);
    const selection = new Set(editorPhotos.flatMap((photo) => photo.id != null && ids.has(photo.id) ? [photo.id] : []));
    if (selection.size === 0 && currentPhoto?.id != null) selection.add(currentPhoto.id);
    return selection;
  });
  const selectionAnchorRef = useRef(currentIdx);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [mapLayer, setMapLayer] = useState<MapLayerStyle>("standard");
  const [mapInstance, setMapInstance] = useState<L.Map | null>(null);
  const handleMapReady = useCallback((map: L.Map | null) => setMapInstance(map), []);

  const filmstripRef = useRef<HTMLDivElement>(null);

  const currentPhotoIdValue = currentPhoto?.id;
  const currentSingleLocation = currentPhotoIdValue == null
    ? null
    : draftLocations.has(currentPhotoIdValue)
      ? draftLocations.get(currentPhotoIdValue) ?? null
      : knownLocations.get(currentPhotoIdValue) ?? null;
  const displayedLocation = editMode === "single" ? currentSingleLocation : targetLocation;

  // Navigate between photos (without moving map)
  const navigate = useCallback((dir: -1 | 1) => {
    const nextIdx = Math.max(0, Math.min(editorPhotos.length - 1, currentIdx + dir));
    setFocusedPhotoId(editorPhotos[nextIdx]?.id ?? null);
  }, [currentIdx, editorPhotos]);

  // Selecting a different thumbnail never moves the map. This makes it possible
  // to keep one target pin while assembling a group from the filmstrip.
  const navigateToPhoto = useCallback((idx: number) => {
    setFocusedPhotoId(editorPhotos[idx]?.id ?? null);
  }, [editorPhotos]);

  useEffect(() => {
    if (editMode !== "single" || !currentSingleLocation) return;
    setMapCenter([currentSingleLocation.lat, currentSingleLocation.lng]);
  }, [currentIdx, currentSingleLocation?.lat, currentSingleLocation?.lng, editMode]);

  const toggleSelection = useCallback((idx: number, range: boolean) => {
    const photoId = editorPhotos[idx]?.id;
    if (photoId == null) return;
    setFocusedPhotoId(photoId);
    setStatusMessage("");
    setSelectedIds((current) => {
      const next = new Set(current);
      if (range) {
        const start = Math.min(selectionAnchorRef.current, idx);
        const end = Math.max(selectionAnchorRef.current, idx);
        for (let item = start; item <= end; item += 1) {
          const id = editorPhotos[item]?.id;
          if (id != null) next.add(id);
        }
      } else if (next.has(photoId)) {
        next.delete(photoId);
      } else {
        next.add(photoId);
      }
      return next;
    });
    if (!range) selectionAnchorRef.current = idx;
  }, [editorPhotos]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key === "Escape" && !saving) {
        e.preventDefault();
        onClose();
        return;
      }
      if (target?.matches("input, textarea, select, button, [contenteditable='true']")) return;
      switch (e.key) {
        case "ArrowRight": e.preventDefault(); navigate(1); break;
        case "ArrowLeft": e.preventDefault(); navigate(-1); break;
        case "Escape": e.preventDefault(); onClose(); break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate, onClose]);

  const handleGpsChange = useCallback((lat: number, lng: number) => {
    if (editMode === "single" && currentPhotoIdValue != null) {
      setDraftLocations((current) => new Map(current).set(currentPhotoIdValue, { lat, lng }));
    } else {
      setTargetLocation({ lat, lng });
    }
    setStatusMessage("");
  }, [currentPhotoIdValue, editMode]);

  const advanceAfterApply = useCallback((ids: number[]) => {
    const applied = new Set(ids);
    const lastIdx = editorPhotos.reduce((last, photo, idx) => applied.has(photo.id!) ? idx : last, currentIdx);
    const nextIdx = Math.min(editorPhotos.length - 1, lastIdx + 1);
    const nextId = editorPhotos[nextIdx]?.id;
    setFocusedPhotoId(nextId ?? null);
    selectionAnchorRef.current = nextIdx;
    setSelectedIds(new Set(nextId != null ? [nextId] : []));
  }, [currentIdx, editorPhotos]);

  const handleConfirm = useCallback(async () => {
    if (saving) return;
    if (editMode === "single") {
      if (currentPhotoIdValue == null || !draftLocations.has(currentPhotoIdValue)) return;
      const location = draftLocations.get(currentPhotoIdValue) ?? null;
      setSaving(true);
      try {
        await onApplyIndividual([{ photoId: currentPhotoIdValue, latitude: location?.lat ?? null, longitude: location?.lng ?? null }]);
        setKnownLocations((current) => {
          const next = new Map(current);
          if (location) next.set(currentPhotoIdValue, location);
          else next.delete(currentPhotoIdValue);
          return next;
        });
        setDraftLocations((current) => { const next = new Map(current); next.delete(currentPhotoIdValue); return next; });
        setStatusMessage("已保存当前照片坐标");
        navigate(1);
      } catch (error) {
        setStatusMessage(`保存失败：${String(error)}`);
      } finally {
        setSaving(false);
      }
      return;
    }
    if (!targetLocation || selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    setSaving(true);
    try {
      await onApply(ids, targetLocation.lat, targetLocation.lng);
      setKnownLocations((current) => {
        const next = new Map(current);
        ids.forEach((photoId) => next.set(photoId, targetLocation));
        return next;
      });
      setStatusMessage(`已将同一坐标应用到 ${ids.length} 张照片`);
      advanceAfterApply(ids);
    } catch (error) {
      setStatusMessage(`保存失败：${String(error)}`);
    } finally {
      setSaving(false);
    }
  }, [advanceAfterApply, currentPhotoIdValue, draftLocations, editMode, navigate, onApply, onApplyIndividual, saving, selectedIds, targetLocation]);

  const handleSaveAllDrafts = useCallback(async () => {
    if (saving || draftLocations.size === 0) return;
    const updates = Array.from(draftLocations, ([photoId, location]) => ({
      photoId,
      latitude: location?.lat ?? null,
      longitude: location?.lng ?? null,
    }));
    setSaving(true);
    try {
      await onApplyIndividual(updates);
      setKnownLocations((current) => {
        const next = new Map(current);
        updates.forEach(({ photoId, latitude, longitude }) => {
          if (latitude == null || longitude == null) next.delete(photoId);
          else next.set(photoId, { lat: latitude, lng: longitude });
        });
        return next;
      });
      setDraftLocations(new Map());
      setStatusMessage(`已保存 ${updates.length} 张照片的独立坐标`);
    } catch (error) {
      setStatusMessage(`保存失败：${String(error)}`);
    } finally {
      setSaving(false);
    }
  }, [draftLocations, onApplyIndividual, saving]);

  const handleClear = useCallback(async () => {
    if (saving) return;
    if (editMode === "single") {
      if (currentPhotoIdValue == null) return;
      setDraftLocations((current) => new Map(current).set(currentPhotoIdValue, null));
      setStatusMessage("已暂存清除操作，尚未保存");
      return;
    }
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    setSaving(true);
    try {
      await onApply(ids, null, null);
      setKnownLocations((current) => {
        const next = new Map(current);
        ids.forEach((photoId) => next.delete(photoId));
        return next;
      });
      setStatusMessage(`已清除 ${ids.length} 张照片的坐标`);
      advanceAfterApply(ids);
    } catch (error) {
      setStatusMessage(`清除失败：${String(error)}`);
    } finally {
      setSaving(false);
    }
  }, [advanceAfterApply, currentPhotoIdValue, editMode, onApply, saving, selectedIds]);

  // Keyboard shortcuts for confirm/clear
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      switch (e.key) {
        case "Enter": e.preventDefault(); handleConfirm(); break;
        case "Delete": e.preventDefault(); handleClear(); break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleConfirm, handleClear, onClose, saving]);

  // Auto-scroll filmstrip
  useEffect(() => {
    const filmstrip = filmstripRef.current;
    if (!filmstrip) return;
    const left = currentIdx * (THUMB_SIZE + THUMB_GAP) - filmstrip.clientWidth / 2 + THUMB_SIZE / 2;
    // WKWebView versions differ in support for Element.scrollTo. Assigning
    // scrollLeft is universally supported and prevents the editor from taking
    // down the entire React tree on older runtimes.
    if (typeof filmstrip.scrollTo === "function") {
      filmstrip.scrollTo({ left, behavior: "smooth" });
    } else {
      filmstrip.scrollLeft = left;
    }
  }, [currentIdx]);

  return (
    <div className="fixed inset-0 bg-bg-primary z-[60] flex flex-col">
      {/* Top bar: search + close */}
      <div className="ui-toolbar shrink-0 border-b border-surface-secondary bg-bg-secondary p-[var(--ui-gap)]">
        <div className="ui-segments" role="group" aria-label="坐标编辑模式">
          <button type="button" aria-pressed={editMode === "single"} onClick={() => setEditMode("single")} className="ui-segment">逐张定位</button>
          <button type="button" aria-pressed={editMode === "batch"} onClick={() => {
            setEditMode("batch");
            if (!targetLocation && currentSingleLocation) setTargetLocation(currentSingleLocation);
          }} className="ui-segment">统一位置</button>
        </div>
        <MapSearch
          className="min-w-[min(100%,12rem)] flex-1"
          onSelect={(result) => {
            handleGpsChange(result.lat, result.lng);
            setMapCenter([result.lat, result.lng]);
            mapInstance?.setView([result.lat, result.lng], 16, { animate: false });
          }}
        />
        <button type="button" onClick={onClose} disabled={saving} aria-label="关闭坐标管理"
          className="ui-button ui-icon-button text-xl" title="关闭（Esc）">
          &times;
        </button>
      </div>

      {/* Map */}
      <div className="flex-1 relative isolate">
        <MapContainer
          center={mapCenter}
          zoom={displayedLocation ? 13 : MAP_ZOOM}
          className="absolute inset-0 z-0 h-full w-full"
          zoomControl={true}
          zoomAnimation={false}
          fadeAnimation={false}
          markerZoomAnimation={false}
        >
          <MapInstanceBridge onReady={handleMapReady} />
          <MapViewport center={mapCenter} />
          <TileEvents onGpsChange={handleGpsChange} />
          <CachedTileLayer layer={mapLayer} />
        </MapContainer>
        <StableGpsOverlay map={mapInstance} location={displayedLocation} />
        <MapLayerToggle value={mapLayer} onChange={setMapLayer} />

        {/* Current photo info overlay */}
        {currentPhoto && (
          <div className="absolute top-3 left-3 bg-bg-secondary/95 rounded-xl px-3 py-2 shadow-lg z-[1000] min-w-56">
            <p className="text-text-primary text-xs font-medium truncate max-w-[200px]">{currentPhoto.filename}</p>
            <p className="text-text-muted text-xs">
              {editMode === "single" ? "本张" : "统一目标"}：{displayedLocation ? `${displayedLocation.lat.toFixed(6)}, ${displayedLocation.lng.toFixed(6)}` : "请在地图上选点"}
            </p>
            <div className="mt-1 flex items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${editMode === "single" ? "bg-orange-100 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300" : "bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300"}`}>
                {editMode === "single" ? `未保存 ${draftLocations.size} 张` : `已选 ${selectedIds.size} 张`}
              </span>
              {editMode === "batch" && currentPhoto && knownLocations.has(currentPhoto.id!) && (
                <button type="button" className="text-xs text-accent-link hover:underline" onClick={() => {
                  const currentLoc = knownLocations.get(currentPhoto.id!);
                  if (!currentLoc) return;
                  setTargetLocation(currentLoc);
                  setMapCenter([currentLoc.lat, currentLoc.lng]);
                }}>使用当前照片坐标</button>
              )}
            </div>
          </div>
        )}

        {/* Nav arrows — these DON'T move the map */}
        {currentIdx > 0 && (
          <button onClick={() => navigate(-1)}
            className="absolute left-3 top-1/2 -translate-y-1/2 z-10 bg-bg-secondary/80 hover:bg-bg-secondary text-white/80 text-3xl px-2 py-4 rounded transition-colors">
            &#8249;
          </button>
        )}
        {currentIdx < editorPhotos.length - 1 && (
          <button onClick={() => navigate(1)}
            className="absolute right-3 top-1/2 -translate-y-1/2 z-10 bg-bg-secondary/80 hover:bg-bg-secondary text-white/80 text-3xl px-2 py-4 rounded transition-colors">
            &#8250;
          </button>
        )}
      </div>

      {/* Filmstrip area */}
      <div className="relative bg-bg-secondary border-t border-surface-secondary flex-shrink-0 flex items-center gap-2 px-3" style={{ height: FILMSTRIP_HEIGHT }}>
        {/* Action buttons */}
        <div className="flex flex-col gap-1 flex-shrink-0 pr-3 border-r border-surface-secondary">
          <button onClick={handleConfirm} disabled={saving || (editMode === "single" ? currentPhotoIdValue == null || !draftLocations.has(currentPhotoIdValue) : selectedIds.size === 0 || !targetLocation)}
            className="bg-green-600 hover:bg-green-500 text-white px-3 py-1 rounded text-xs font-semibold whitespace-nowrap disabled:opacity-40"
            title="确认（Enter）">
            {saving ? "保存中…" : editMode === "single" ? "保存当前" : `应用到 ${selectedIds.size} 张`}
          </button>
          <button onClick={handleClear} disabled={saving || (editMode === "batch" && selectedIds.size === 0)}
            className="bg-red-600 hover:bg-red-500 text-white px-3 py-1 rounded text-xs font-semibold whitespace-nowrap disabled:opacity-40"
            title="清除并查看下一张（Delete）">
            {editMode === "single" ? "清除当前" : `清除 ${selectedIds.size} 张`}
          </button>
        </div>

        {/* Selection controls */}
        <div className="flex-shrink-0 text-xs text-text-muted whitespace-nowrap space-y-1">
          <div>{currentIdx + 1} / {editorPhotos.length} · {editMode === "single" ? `草稿 ${draftLocations.size}` : `已选 ${selectedIds.size}`}</div>
          {editMode === "single" ? (
            <>
              <button type="button" disabled={saving || draftLocations.size === 0} className="text-accent-link hover:underline disabled:opacity-40" onClick={handleSaveAllDrafts}>保存全部草稿 ({draftLocations.size})</button>
              <div className="text-xs text-text-muted">橙色：未保存 · 绿色：已有坐标</div>
            </>
          ) : (
            <>
              <div className="flex gap-2">
                <button type="button" className="text-accent-link hover:underline" onClick={() => setSelectedIds(new Set(editorPhotos.flatMap((photo) => photo.id != null ? [photo.id] : [])))}>全选</button>
                <button type="button" className="text-text-muted hover:text-text-primary" onClick={() => setSelectedIds(new Set())}>取消选择</button>
              </div>
              <div className="text-xs text-text-muted">点圆圈选择 · Shift 连选</div>
            </>
          )}
        </div>

        {/* Thumbnails */}
        <div ref={filmstripRef} className="flex-1 overflow-x-auto">
          <div className="flex items-center h-full gap-1" style={{ minWidth: "max-content" }}>
            {editorPhotos.map((photo, idx) => {
              const isSelected = idx === currentIdx;
              const isBatchSelected = selectedIds.has(photo.id!);
              const hasDraft = draftLocations.has(photo.id!);
              const draftLocation = draftLocations.get(photo.id!);
              const hasLoc = hasDraft ? draftLocation != null : knownLocations.has(photo.id!);
              return (
                <div
                  key={photo.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`切换到 ${photo.filename}`}
                  className={`relative cursor-pointer overflow-hidden rounded flex-shrink-0 transition-all ${
                    isSelected ? "ring-2 ring-accent-primary" : `ring-1 ring-surface-secondary ${editMode === "single" || isBatchSelected ? "opacity-100" : "opacity-60 hover:opacity-100"}`
                  }`}
                  style={{ width: THUMB_SIZE, height: THUMB_SIZE }}
                  onClick={() => navigateToPhoto(idx)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      navigateToPhoto(idx);
                    }
                  }}
                >
                  <BatchThumb photo={photo} />
                  {editMode === "batch" && (
                    <button
                      type="button"
                      aria-label={isBatchSelected ? `取消选择 ${photo.filename}` : `选择 ${photo.filename}`}
                      className={`absolute top-1 left-1 z-10 h-4 w-4 rounded-full border flex items-center justify-center text-xs font-bold shadow-sm ${
                        isBatchSelected ? "border-blue-500 bg-blue-500 text-white" : "border-white bg-black/30 text-transparent"
                      }`}
                      onClick={(event) => { event.stopPropagation(); toggleSelection(idx, event.shiftKey); }}
                    >
                      ✓
                    </button>
                  )}
                  {hasDraft ? (
                    <div className="absolute top-0 right-0 w-4 h-4 bg-orange-500 rounded-bl text-xs leading-4 text-center text-white" title={draftLocation ? "坐标已修改，尚未保存" : "坐标将被清除，尚未保存"}>●</div>
                  ) : hasLoc ? (
                    <div className="absolute top-0 right-0 w-3 h-3 bg-green-500 rounded-bl" title="已有 GPS" />
                  ) : null}
                  <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5">
                    <p className="text-white text-[8px] truncate">{photo.filename}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {statusMessage && (
          <div className={`absolute bottom-[94px] left-1/2 z-[1000] -translate-x-1/2 rounded-full px-4 py-2 text-xs shadow-lg ${statusMessage.includes("失败") ? "bg-red-600 text-white" : "bg-bg-secondary text-gray-700"}`}>
            {statusMessage}
          </div>
        )}
      </div>
    </div>
  );
}

function BatchThumb({ photo }: { photo: Photo }) {
  const [url, setUrl] = useState<string | null>(() => batchThumbCache.get(photo.id!) ?? null);

  useEffect(() => {
    if (batchThumbCache.has(photo.id!)) return;
    let cancelled = false;
    // Always use the normalized WebP cache. Direct file URLs do not render
    // HEIC/HEIF reliably and force WebKit to decode the full-resolution file.
    api.getThumbnailPath(photo.id!, "small").then((path) => {
      if (!cancelled) {
        const u = convertFileSrc(path);
        batchThumbCache.set(photo.id!, u);
        setUrl(u);
      }
    }).catch(() => { if (!cancelled) setUrl(null); });
    return () => { cancelled = true; };
  }, [photo.id]);

  return url ? (
    <img src={url} alt={photo.filename} className="w-full h-full object-cover" />
  ) : (
    <div className="w-full h-full bg-surface-primary flex items-center justify-center text-text-muted text-[8px]">...</div>
  );
}

// ---- Read-only map ----

function ReadOnlyGpsMap({ lat, lng, onEditClick }: {
  lat: number; lng: number; onEditClick: () => void;
}) {
  return (
    <div className="h-32 rounded-lg overflow-hidden border border-surface-secondary cursor-pointer" onClick={onEditClick}>
      <MapContainer key={`ro-map-${lat}-${lng}`} center={[lat, lng]} zoom={13} className="w-full h-full" zoomControl={false} dragging={false} scrollWheelZoom={false}>
        <CachedTileLayer />
        <Marker icon={mapPinIcon} position={[lat, lng]} />
      </MapContainer>
    </div>
  );
}

// ---- Editable map with fullscreen button ----

function EditableGpsMap({ currentLat, currentLng, onGpsChange, onFullscreen }: {
  currentLat: number | null;
  currentLng: number | null;
  onGpsChange: (lat: number, lng: number) => void;
  onFullscreen?: () => void;
}) {
  const hasCoordinates = currentLat != null && currentLng != null;
  const center: [number, number] = hasCoordinates ? [currentLat, currentLng] : MAP_CENTER;
  const zoom = hasCoordinates ? 15 : MAP_ZOOM;

  return (
    <div>
      <MapSearch className="mb-2" compact onSelect={(result) => onGpsChange(result.lat, result.lng)} />
      <div className="rounded-lg overflow-hidden border border-surface-secondary relative">
        <MapContainer key={`edit-map-${currentLat}-${currentLng}`} center={center} zoom={zoom} className="w-full h-40" zoomControl={false}>
          <MapViewport center={center} />
          <TileEvents onGpsChange={onGpsChange} />
          <CachedTileLayer />
          {hasCoordinates && (
            <Marker icon={mapPinIcon} position={[currentLat, currentLng]} draggable={true}
              eventHandlers={{ dragend: (e) => { const { lat, lng } = e.target.getLatLng(); onGpsChange(lat, lng); } }} />
          )}
        </MapContainer>
        {onFullscreen && (
          <button
            onClick={onFullscreen}
            className="absolute bottom-2 left-2 z-[1100] bg-accent-primary hover:bg-accent-primary/80 text-white px-3 py-1.5 rounded text-xs font-semibold shadow-lg transition-colors flex items-center gap-1.5"
            title="批量编辑模式"
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 5V1.5h3.5M9 1.5h3.5V5M1 9v3.5h3.5M13 9v3.5H9.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            批量编辑
          </button>
        )}
      </div>
    </div>
  );
}

// ---- Location Section ----

function LocationSection({ photo, onGpsSaved, dirtyRef, pendingRef, onOpenBatchEditor, onShowNearby }: {
  photo: Photo;
  onGpsSaved: (lat: number | null, lng: number | null) => void;
  dirtyRef: React.MutableRefObject<boolean>;
  pendingRef: React.MutableRefObject<{ lat: number | null; lng: number | null }>;
  onOpenBatchEditor: () => void;
  onShowNearby: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pendingLat, setPendingLat] = useState<number | null>(null);
  const [pendingLng, setPendingLng] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // Sync pending coords when photo changes or exiting edit mode
  useEffect(() => {
    if (!editing) {
      setPendingLat(photo.latitude);
      setPendingLng(photo.longitude);
    }
  }, [photo.id, photo.latitude, photo.longitude, editing]);

  // Expose dirty state and pending coords to parent
  useEffect(() => {
    dirtyRef.current = editing && (pendingLat !== photo.latitude || pendingLng !== photo.longitude);
    pendingRef.current = { lat: pendingLat, lng: pendingLng };
  }, [editing, pendingLat, pendingLng, photo.latitude, photo.longitude]);

  const handleGpsChange = (lat: number, lng: number) => {
    setPendingLat(lat);
    setPendingLng(lng);
  };

  const handleConfirm = async () => {
    setSaving(true);
    try {
      await api.updatePhotoGps(photo.id!, pendingLat, pendingLng);
      onGpsSaved(pendingLat, pendingLng);
      setEditing(false);
      setPendingLat(null);
      setPendingLng(null);
    } catch (err) {
      alert("GPS 保存失败：" + err);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditing(false);
    setPendingLat(null);
    setPendingLng(null);
  };

  const handleClear = () => {
    setPendingLat(null);
    setPendingLng(null);
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleEdit = (_clickLat?: number, _clickLng?: number) => {
    if (_clickLat !== undefined && _clickLng !== undefined) {
      setPendingLat(_clickLat);
      setPendingLng(_clickLng);
    } else {
      setPendingLat(photo.latitude);
      setPendingLng(photo.longitude);
    }
    setEditing(true);
  };

  // === View mode ===
  if (!editing) {
    if (photo.latitude != null && photo.longitude != null) {
      return (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-text-muted text-xs uppercase font-semibold">拍摄位置</h3>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={onShowNearby}
                className="inline-flex h-7 w-7 items-center justify-center rounded-full text-accent-link hover:bg-accent-primary/10"
                title="在地图中查看附近照片"
                aria-label="在地图中查看附近照片"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>
              </button>
              <button onClick={() => handleEdit()} className="px-1 text-xs text-accent-link hover:underline">编辑</button>
            </div>
          </div>
          <p className="text-text-secondary text-xs mb-2">
            {photo.latitude.toFixed(6)}, {photo.longitude.toFixed(6)}
          </p>
          <ReadOnlyGpsMap lat={photo.latitude} lng={photo.longitude} onEditClick={() => handleEdit()} />
        </div>
      );
    }
    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-text-muted text-xs uppercase font-semibold">拍摄位置</h3>
          <button onClick={() => handleEdit()} className="text-xs text-accent-link hover:underline">编辑</button>
        </div>
      </div>
    );
  }

  // === Edit mode ===
  const displayLat = pendingLat ?? photo.latitude;
  const displayLng = pendingLng ?? photo.longitude;
  const isDirty = (pendingLat !== null || pendingLng !== null)
    && (pendingLat !== photo.latitude || pendingLng !== photo.longitude);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-text-muted text-xs uppercase font-semibold">拍摄位置</h3>
        <button onClick={handleCancel} className="text-xs text-text-muted hover:text-text-primary">取消</button>
      </div>
      <p className="text-text-muted text-xs mb-2">保存后会将坐标写入原照片的 EXIF 信息。</p>

      {photo.latitude != null && photo.longitude != null && !isDirty && (
        <div className="flex items-center justify-between mb-2">
          <p className="text-text-secondary text-xs">{photo.latitude.toFixed(6)}, {photo.longitude.toFixed(6)}</p>
          <button onClick={handleClear} className="text-xs text-red-400 hover:text-red-300">清除</button>
        </div>
      )}

      {isDirty && (
        <div className="mb-2 px-2 py-1 bg-yellow-900/30 border border-yellow-700/50 rounded text-xs text-yellow-300">
          Pending: {displayLat!.toFixed(6)}, {displayLng!.toFixed(6)}
        </div>
      )}

      <EditableGpsMap
        currentLat={displayLat}
        currentLng={displayLng}
        onGpsChange={handleGpsChange}
        onFullscreen={onOpenBatchEditor}
      />

      <div className="flex gap-2 mt-3">
        <button onClick={handleConfirm} disabled={saving}
          className="flex-1 bg-green-600 text-white py-1.5 rounded text-xs font-semibold disabled:opacity-50">
          {saving ? "正在保存…" : "确认"}
        </button>
        <button onClick={handleCancel} disabled={saving}
          className="flex-1 bg-red-600 text-white py-1.5 rounded text-xs font-semibold disabled:opacity-50">
          取消
        </button>
      </div>
    </div>
  );
}

// ---- Main PhotoDetail ----

export default React.memo(function PhotoDetail({ photoId, onClose, width = 384, embedded = false, onEditingFaceChange }: Props) {
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [faces, setFaces] = useState<FaceDetection[]>([]);
  const [faceClusters, setFaceClusters] = useState<FaceCluster[]>([]);
  const [editingFaceId, setEditingFaceId] = useState<number | null>(null);
  const [faceTargetId, setFaceTargetId] = useState<number | null>(null);
  const [facePersonName, setFacePersonName] = useState("");
  const [faceSaving, setFaceSaving] = useState(false);
  const [faceError, setFaceError] = useState<string | null>(null);
  const [attributes, setAttributes] = useState<CustomAttribute[]>([]);
  const [allManualTags, setAllManualTags] = useState<ManualTag[]>([]);
  const [manualTags, setManualTags] = useState<ManualTag[]>([]);
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [tagSaving, setTagSaving] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [previewErrorText, setPreviewErrorText] = useState("预览加载失败");
  const [actionError, setActionError] = useState("");
  const [favoriteSaving, setFavoriteSaving] = useState(false);
  const [previewRetryToken, setPreviewRetryToken] = useState(0);
  const previewDecodeRetriesRef = useRef(0);
  const previewDecodeTimerRef = useRef<number | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const { setLightboxPhotoId } = useStore();
  const requestMapFocus = useStore((state) => state.requestMapFocus);
  const faceDataRevision = useStore((state) => state.faceDataRevision);
  const markFaceDataChanged = useStore((state) => state.markFaceDataChanged);
  const updatePhotoInList = useStore((s) => s.updatePhotoInList);
  const listPhoto = useStore((state) => state.photos.find((item) => item.id === photoId));
  const navigate = useNavigate();

  const dirtyRef = React.useRef(false);
  const pendingRef = React.useRef<{ lat: number | null; lng: number | null }>({ lat: null, lng: null });
  const prevPhotoIdRef = React.useRef<number | null>(null);
  const [unsavedDialog, setUnsavedDialog] = useState<{ prevId: number } | null>(null);

  useEffect(() => {
    onEditingFaceChange?.(editingFaceId);
    return () => onEditingFaceChange?.(null);
  }, [editingFaceId, onEditingFaceChange]);

  useEffect(() => {
    let cancelled = false;
    setPhoto(null);
    setFaces([]);
    setPreviewUrl(null);
    setPreviewError(false);
    previewDecodeRetriesRef.current = 0;
    setShowTagPicker(false);
    setTagError(null);
    setFaceError(null);
    setEditingFaceId(null);
    setFaceTargetId(null);
    setFacePersonName("");
    setMenuPos(null);
    Promise.all([
      api.getPhoto(photoId),
      api.getPhotoAttributes(photoId),
      api.getManualTags().catch(() => []),
      api.getPhotoManualTags(photoId).catch(() => []),
    ]).then(([nextPhoto, nextAttributes, nextAllManualTags, nextManualTags]) => {
      if (cancelled) return;
      setPhoto(nextPhoto);
      setAttributes(nextAttributes);
      setAllManualTags(nextAllManualTags);
      setManualTags(nextManualTags);
    }).catch(console.error);
    return () => {
      cancelled = true;
      if (previewDecodeTimerRef.current != null) {
        window.clearTimeout(previewDecodeTimerRef.current);
        previewDecodeTimerRef.current = null;
      }
    };
  }, [photoId]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getPhotoFaces(photoId), api.getClusters()])
      .then(([nextFaces, nextClusters]) => {
        if (cancelled) return;
        setFaces(nextFaces);
        setFaceClusters(nextClusters);
      })
      .catch((error) => {
        if (!cancelled) setFaceError(`读取人脸失败：${String(error)}`);
      });
    return () => { cancelled = true; };
  }, [photoId, faceDataRevision]);

  // Keyboard shortcuts and card actions update the shared list first. Keep an
  // already-open detail drawer visually in sync with those optimistic changes.
  useEffect(() => {
    if (!listPhoto) return;
    setPhoto((current) => current ? {
      ...current,
      rating: listPhoto.rating,
      is_favorite: listPhoto.is_favorite,
    } : current);
  }, [listPhoto?.rating, listPhoto?.is_favorite]);

  // The detail preview always uses a bounded large thumbnail. The previous
  // implementation deliberately rendered nothing for files over 10 MB.
  useEffect(() => {
    if (!photo) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setPreviewUrl(null);
    setPreviewError(false);
    const load = (attempt: number) => {
      api.getThumbnailPath(photoId, "large")
        .then((path) => { if (!cancelled) setPreviewUrl(convertFileSrc(path)); })
        .catch((error) => {
          if (cancelled) return;
          if (attempt < 3) {
            retryTimer = setTimeout(() => load(attempt + 1), 250 * attempt);
            return;
          }
          console.error("Failed to load detail preview:", error);
          setPreviewErrorText(imageErrorMessage(error));
          setPreviewError(true);
        });
    };
    load(1);
    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
  }, [photoId, photo?.path, previewRetryToken]);

  const handlePreviewDecodeError = useCallback(() => {
    if (previewDecodeRetriesRef.current < 2) {
      previewDecodeRetriesRef.current += 1;
      setPreviewUrl(null);
      setPreviewError(false);
      previewDecodeTimerRef.current = window.setTimeout(() => {
        previewDecodeTimerRef.current = null;
        setPreviewRetryToken((value) => value + 1);
      }, 250 * previewDecodeRetriesRef.current);
      return;
    }
    setPreviewUrl(null);
    setPreviewErrorText("预览图片无法显示");
    setPreviewError(true);
  }, []);

  useEffect(() => {
    const prevId = prevPhotoIdRef.current;
    if (prevId !== null && prevId !== photoId && dirtyRef.current) {
      setUnsavedDialog({ prevId });
    } else {
      prevPhotoIdRef.current = photoId;
    }
  }, [photoId]);

  const handleAddAttribute = async () => {
    if (!newKey.trim()) return;
    await api.setPhotoAttribute(photoId, newKey.trim(), newValue.trim());
    const attrs = await api.getPhotoAttributes(photoId);
    setAttributes(attrs);
    setNewKey("");
    setNewValue("");
  };

  const handleReassignFace = async (faceId: number) => {
    if (faceSaving || faceTargetId == null) return;
    setFaceSaving(true);
    setFaceError(null);
    try {
      await api.reassignPhotoFace(faceId, faceTargetId);
      markFaceDataChanged();
      setEditingFaceId(null);
      setFaceTargetId(null);
    } catch (error) {
      setFaceError(`修改人物失败：${String(error)}`);
    } finally {
      setFaceSaving(false);
    }
  };

  const handleMergeFaceGroup = async (sourceId: number) => {
    const targetId = faceTargetId;
    if (faceSaving || targetId == null || targetId === sourceId) return;
    const projectPath = useStore.getState().project?.root_path;
    setFaceSaving(true);
    setFaceError(null);
    try {
      const mergedId = await api.mergeClustersBatch([sourceId], undefined, targetId);
      const state = useStore.getState();
      if (state.project?.root_path !== projectPath) return;
      if (state.filter.person_id === sourceId) {
        state.setFilter({ person_id: mergedId });
      } else if (state.filter.person_id === mergedId) {
        void state.loadPhotos();
      }
      markFaceDataChanged();
      setEditingFaceId(null);
      setFaceTargetId(null);
    } catch (error) {
      setFaceError(`合并人物组失败：${String(error)}`);
    } finally {
      setFaceSaving(false);
    }
  };

  const handleSaveFaceName = async (face: FaceDetection, separatePerson = false) => {
    const name = facePersonName.trim();
    if (faceSaving || !name || face.id == null) return;
    setFaceSaving(true);
    setFaceError(null);
    try {
      if (face.person_id != null && !separatePerson) {
        await api.renameCluster(face.person_id, name);
      } else {
        await api.createNamedPersonForFace(face.id, name);
      }
      markFaceDataChanged();
      setEditingFaceId(null);
      setFaceTargetId(null);
      setFacePersonName("");
    } catch (error) {
      setFaceError(`保存姓名失败：${String(error)}`);
    } finally {
      setFaceSaving(false);
    }
  };

  const handleDeleteFace = async (face: FaceDetection) => {
    if (faceSaving || face.id == null) return;
    const name = faceClusters.find((cluster) => cluster.id === face.person_id)?.name?.trim() || "这条人脸记录";
    if (!window.confirm(`确定取消“${name}”在这张照片中的人脸识别吗？\n\n只会删除本照片中的识别结果，不会删除原照片或该人物的其他照片。`)) return;
    setFaceSaving(true);
    setFaceError(null);
    try {
      await api.deletePhotoFace(face.id);
      markFaceDataChanged();
      setEditingFaceId(null);
      setFaceTargetId(null);
    } catch (error) {
      setFaceError(`取消人脸识别失败：${String(error)}`);
    } finally {
      setFaceSaving(false);
    }
  };

  const handleToggleManualTag = async (tag: ManualTag) => {
    if (tagSaving) return;
    setTagError(null);
    const currentIds = new Set(manualTags.map((item) => item.id));
    if (currentIds.has(tag.id)) currentIds.delete(tag.id);
    else currentIds.add(tag.id);
    const next = allManualTags.filter((item) => currentIds.has(item.id));
    setManualTags(next);
    setTagSaving(true);
    try {
      await api.setPhotoManualTags(photoId, Array.from(currentIds));
    } catch (error) {
      console.error("Failed to update manual tags:", error);
      setTagError("标签保存失败，请重试");
      try {
        setManualTags(await api.getPhotoManualTags(photoId));
      } catch {
        setManualTags(manualTags);
      }
    } finally {
      setTagSaving(false);
    }
  };

  const handleUpdateGps = (lat: number | null, lng: number | null) => {
    setPhoto((prev) => prev ? { ...prev, latitude: lat, longitude: lng } : null);
    if (photoId) {
      updatePhotoInList(photoId, { latitude: lat, longitude: lng });
    }
  };

  const handleRating = async (rating: number) => {
    setActionError("");
    try {
      await api.updatePhotosRating([photoId], rating);
      setPhoto((current) => current ? { ...current, rating } : null);
      updatePhotoInList(photoId, { rating });
    } catch (error) { setActionError(`评分保存失败：${String(error)}`); }
  };

  const handleUnsavedSave = async () => {
    if (unsavedDialog) {
      try {
        await api.updatePhotoGps(unsavedDialog.prevId, pendingRef.current.lat, pendingRef.current.lng);
        setUnsavedDialog(null);
        prevPhotoIdRef.current = photoId;
      } catch (e) {
        alert("GPS 保存失败：" + e);
      }
    }
  };

  const handleUnsavedDiscard = () => {
    setUnsavedDialog(null);
    prevPhotoIdRef.current = photoId;
  };

  const handleUnsavedStay = () => {
    useStore.getState().setSelectedPhotoId(unsavedDialog!.prevId);
    setUnsavedDialog(null);
  };

  const toggleFavorite = async () => {
    setActionError("");
    setFavoriteSaving(true);
    try {
      const is_favorite = await api.togglePhotoFavorite(photoId);
      setPhoto((value) => value ? { ...value, is_favorite } : value);
      updatePhotoInList(photoId, { is_favorite });
    } catch (error) { setActionError(`收藏操作失败：${String(error)}`); }
    finally { setFavoriteSaving(false); }
  };

  if (!photo) return null;

  const panel = (
    <div
      className={embedded
        ? "h-full w-full bg-bg-secondary border-l border-surface-secondary overflow-y-auto"
        : "fixed right-0 top-0 h-full bg-bg-secondary border-l border-surface-secondary shadow-xl overflow-y-auto z-[1001]"}
      style={embedded ? undefined : { width }}
    >
      <div className="sticky top-0 bg-bg-secondary z-10 flex items-center justify-between p-4 border-b border-surface-secondary">
        <h2 className="font-semibold">照片详情</h2>
        <button onClick={onClose} aria-label="关闭照片详情" className="ui-button">&times;</button>
      </div>

      <div className="p-4 space-y-4">
        {/* Preview */}
        {!embedded && (
          <div
            className="aspect-[4/3] bg-surface-primary rounded-lg overflow-hidden cursor-zoom-in"
            onDoubleClick={() => setLightboxPhotoId(photoId)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setMenuPos({ x: event.clientX, y: event.clientY });
            }}
          >
            {previewUrl ? (
              <img src={previewUrl} alt={photo.filename} className="w-full h-full object-contain" onError={handlePreviewDecodeError} />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-sm text-text-secondary" role="status">
                <span>{previewError ? previewErrorText : "正在加载预览…"}</span>
                {previewError && <button type="button" className="ui-button" onClick={(event) => { event.stopPropagation(); previewDecodeRetriesRef.current = 0; setPreviewRetryToken((value) => value + 1); }}>重新加载</button>}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {!embedded && <button type="button" className="ui-button" onClick={() => setLightboxPhotoId(photoId)}>查看大图</button>}
          <button type="button" className="ui-button" onClick={() => api.revealInFileManager(photo.path).catch((error) => setActionError(String(error)))}>文件位置</button>
        </div>
          <div className="flex items-center gap-3 border-t border-surface-secondary pt-2">
            <span className="font-medium text-text-primary">星级:</span>
            <StarRating value={photo.rating} onChange={handleRating} />
            <button type="button" aria-pressed={photo.is_favorite} disabled={favoriteSaving} onClick={() => void toggleFavorite()} className="ui-button ml-auto">{photo.is_favorite ? "取消收藏" : "收藏"}</button>
          </div>
        {actionError && <p role="alert" className="text-sm text-red-500">{actionError}</p>}
        {/* Info */}
        <div className="space-y-2 text-sm">
          <h3 className="text-text-muted text-xs uppercase font-semibold">基本信息</h3>
          <p className="text-text-secondary"><span className="text-text-primary font-medium">文件名：</span> {photo.filename}</p>
          <p className="text-text-secondary"><span className="text-text-primary font-medium">大小：</span> {formatFileSize(photo.file_size)}</p>
          <p className="text-text-secondary"><span className="text-text-primary font-medium">拍摄时间：</span> {formatDate(photo.taken_at)}</p>
          <p className="text-text-secondary"><span className="text-text-primary font-medium">修改时间：</span> {formatDateTime(photo.file_mtime)}</p>

        </div>

        <details className="rounded-xl border border-surface-secondary p-3">
          <summary className="cursor-pointer text-sm font-medium">相机与 EXIF</summary>
          <div className="mt-3 space-y-2 text-sm">
          {photo.camera_make && (
            <p className="text-text-secondary"><span className="text-text-primary font-medium">相机：</span> {photo.camera_make} {photo.camera_model}</p>
          )}
          {photo.width && photo.height && (
            <p className="text-text-secondary"><span className="text-text-primary font-medium">尺寸：</span> {photo.width} × {photo.height}</p>
          )}
          {photo.exposure_time && (
            <p className="text-text-secondary"><span className="text-text-primary font-medium">快门：</span> {photo.exposure_time}s</p>
          )}
          {photo.f_number && (
            <p className="text-text-secondary"><span className="text-text-primary font-medium">光圈：</span> f/{photo.f_number}</p>
          )}
          {photo.iso && (
            <p className="text-text-secondary"><span className="text-text-primary font-medium">ISO:</span> {photo.iso}</p>
          )}

          </div>
        </details>

        {/* Location (edit with confirm/cancel) */}
        <LocationSection photo={photo} onGpsSaved={handleUpdateGps} dirtyRef={dirtyRef} pendingRef={pendingRef} onShowNearby={() => {
          if (photo.latitude == null || photo.longitude == null || photo.id == null) return;
          requestMapFocus(photo.latitude, photo.longitude, photo.id);
          onClose();
          navigate("/map");
        }} onOpenBatchEditor={() => {
          // Save any pending single-edit GPS changes to the batch editor state
          if (pendingRef.current.lat != null && pendingRef.current.lng != null && photo.id != null) {
            const store = useStore.getState();
            const newPending = new Map(store.batchGpsPending);
            newPending.set(photo.id!, { lat: pendingRef.current.lat, lng: pendingRef.current.lng });
            store.setBatchGpsPending(newPending);
          }
          onClose();
          useStore.getState().openGpsBatchEditor({ photoId: photo.id!, mode: "single", sourcePhoto: photo });
        }} />

        {/* Unified tags: AI-created and user-created tags are edited identically. */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-text-muted text-xs uppercase font-semibold">标签</h3>
            <button onClick={() => setShowTagPicker((value) => !value)} className="text-accent-link text-xs font-medium">{showTagPicker ? "完成" : "＋ 添加"}</button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {manualTags.map((tag) => (
              <button key={tag.id} onClick={() => handleToggleManualTag(tag)} disabled={tagSaving} className="inline-flex items-center gap-1.5 rounded-full border border-text-primary/[0.06] bg-bg-secondary px-2.5 py-1 text-xs text-text-primary shadow-sm disabled:opacity-50" title="点击移除">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: tag.color }} />{tag.name}<span className="text-text-muted">×</span>
              </button>
            ))}
            {manualTags.length === 0 && !showTagPicker && <span className="text-xs text-text-muted">尚未添加标签</span>}
          </div>
          {showTagPicker && (
            <div className="mt-2 rounded-xl border border-text-primary/[0.07] bg-bg-secondary/70 p-2 max-h-40 overflow-y-auto">
              {allManualTags.length > 0 ? allManualTags.map((tag) => {
                const checked = manualTags.some((item) => item.id === tag.id);
                return <button key={tag.id} onClick={() => handleToggleManualTag(tag)} disabled={tagSaving} className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-text-primary/[0.04] disabled:opacity-50"><span className="w-3 h-3 rounded-full" style={{ backgroundColor: tag.color }} /><span className="flex-1 text-left truncate">{tag.name}</span><span className={checked ? "text-accent-link" : "text-transparent"}>✓</span></button>;
              }) : <p className="p-2 text-xs text-text-muted">请先到“标签”页面创建标签。</p>}
            </div>
          )}
          {tagError && <p className="mt-2 text-xs text-red-500">{tagError}</p>}
        </div>

        {/* Faces */}
        {faces.length > 0 && (
          <div>
            <h3 className="text-text-muted text-xs uppercase font-semibold mb-2">人脸 ({faces.length})</h3>
            <div className="space-y-2">
              {faces.map((face) => {
                const person = faceClusters.find((cluster) => cluster.id === face.person_id);
                const personName = person?.name?.trim() || (face.person_id == null ? "待整理人脸" : `人物 ${face.person_id}`);
                const grouped = face.person_id != null;
                const editing = editingFaceId === face.id;
                return (
                  <div
                    key={face.id ?? `${face.photo_id}-${face.bbox_x}-${face.bbox_y}`}
                    className={`rounded-lg border p-2.5 text-sm transition-colors ${
                      editing
                        ? "border-emerald-500 bg-emerald-50/80 dark:bg-emerald-950/40 shadow-[0_0_0_1px_rgba(16,185,129,0.15)]"
                        : "border-text-primary/[0.05] bg-surface-primary"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{personName}</span>
                      <div className="flex shrink-0 items-center gap-2 text-xs">
                        <button
                          type="button"
                          disabled={faceSaving || face.id == null}
                          onClick={() => {
                            setEditingFaceId(editing ? null : face.id);
                            setFaceTargetId(null);
                            setFacePersonName(person?.name ?? "");
                            setFaceError(null);
                          }}
                          className="text-accent-link hover:underline disabled:opacity-50"
                        >{editing ? "收起" : "修改"}</button>
                        <button type="button" disabled={faceSaving || face.id == null} onClick={() => void handleDeleteFace(face)} className="text-red-500 hover:underline disabled:opacity-50">取消识别</button>
                      </div>
                    </div>
                    {editing && face.id != null && (
                      <div className="mt-2 space-y-2">
                        {grouped && <p className="text-xs text-text-secondary">
                          {person?.photo_count ? `组名将应用于该组的 ${person.photo_count} 张照片。` : "组名将应用于该组的所有照片。"}
                        </p>}
                        <div className="flex items-center gap-2">
                          <input
                            value={facePersonName}
                            onChange={(event) => setFacePersonName(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" && !event.nativeEvent.isComposing) void handleSaveFaceName(face);
                            }}
                            aria-label={grouped ? "人物组姓名" : "新人物姓名"}
                            placeholder={grouped ? "输入人物组姓名…" : "输入新人物姓名…"}
                            className="min-w-0 flex-1 rounded-lg border border-text-primary/10 bg-bg-secondary px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-accent-primary/25"
                          />
                          <button type="button" disabled={faceSaving || !facePersonName.trim()}
                            onClick={() => void handleSaveFaceName(face)}
                            className="rounded-lg bg-accent-primary px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
                            {grouped ? "保存组名" : "新建人物"}
                          </button>
                        </div>
                        <div className="flex items-center gap-2">
                          <select
                            aria-label={grouped ? "选择整组合并到的人物" : "为这张脸选择已有姓名"}
                            value={faceTargetId ?? ""}
                            disabled={faceSaving}
                            onChange={(event) => setFaceTargetId(event.target.value ? Number(event.target.value) : null)}
                            className="min-w-0 flex-1 rounded-lg border border-text-primary/10 bg-bg-secondary px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-accent-primary/25"
                          >
                            <option value="">选择已有姓名…</option>
                            {faceClusters.filter((cluster) => cluster.name?.trim() && cluster.id != null && cluster.id !== face.person_id).map((cluster) => (
                              <option key={cluster.id} value={cluster.id!}>{cluster.name}</option>
                            ))}
                          </select>
                          <button type="button" disabled={faceSaving || faceTargetId == null}
                            onClick={() => {
                              if (face.person_id == null) void handleReassignFace(face.id!);
                              else void handleMergeFaceGroup(face.person_id);
                            }}
                            className="shrink-0 rounded-lg bg-accent-primary px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
                            {grouped ? "整组合并" : "仅更正这张脸"}
                          </button>
                        </div>
                        {grouped && <div className="flex flex-wrap gap-x-3 gap-y-1">
                          <button type="button" disabled={faceSaving || faceTargetId == null}
                            onClick={() => void handleReassignFace(face.id!)}
                            className="text-xs text-text-secondary hover:text-accent-link hover:underline disabled:opacity-40">
                            仅更正这张脸
                          </button>
                          <button type="button" disabled={faceSaving || !facePersonName.trim()}
                            onClick={() => void handleSaveFaceName(face, true)}
                            className="text-xs text-text-secondary hover:text-accent-link hover:underline disabled:opacity-40">
                            用输入的姓名仅为这张脸新建人物
                          </button>
                        </div>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {faceError && <p role="alert" className="text-xs text-red-500">{faceError}</p>}

        {/* Custom Attributes */}
        <details className="rounded-xl border border-surface-secondary p-3">
          <summary className="mb-2 cursor-pointer text-sm font-medium">自定义属性</summary>
          {attributes.map((a) => (
            <div key={a.key} className="flex items-center justify-between bg-surface-primary rounded px-2 py-1 mb-1 text-sm">
              <span className="text-text-primary font-medium">{a.key}</span>
              <span className="text-text-secondary">{a.value}</span>
            </div>
          ))}
          <div className="flex gap-2 mt-2">
            <input value={newKey} onChange={(e) => setNewKey(e.target.value)}
              placeholder="属性名" className="flex-1 bg-surface-primary border border-surface-secondary rounded px-2 py-1 text-sm text-text-primary" />
            <input value={newValue} onChange={(e) => setNewValue(e.target.value)}
              placeholder="属性值" className="flex-1 bg-surface-primary border border-surface-secondary rounded px-2 py-1 text-sm text-text-primary" />
            <button onClick={handleAddAttribute} className="bg-accent-primary text-white px-3 py-1 rounded text-sm">添加</button>
          </div>
        </details>
      </div>

      {unsavedDialog && (
        <div className="fixed inset-0 bg-black/50 z-[1002] flex items-center justify-center"
          onClick={(e) => { if (e.target === e.currentTarget) handleUnsavedStay(); }}>
          <div className="bg-bg-secondary rounded-xl p-6 w-80 shadow-2xl">
            <h3 className="text-lg font-semibold mb-2 text-text-primary">定位修改尚未保存</h3>
            <p className="text-text-secondary text-sm mb-4">是否保存本次定位修改？</p>
            <div className="flex gap-2">
              <button onClick={handleUnsavedSave}
                className="flex-1 bg-green-600 text-white py-2 rounded text-sm font-semibold hover:bg-green-500">保存</button>
              <button onClick={handleUnsavedDiscard}
                className="flex-1 bg-red-600 text-white py-2 rounded text-sm font-semibold hover:bg-red-500">放弃修改</button>
              <button onClick={handleUnsavedStay}
                className="flex-1 bg-surface-primary border border-surface-secondary text-text-primary py-2 rounded text-sm hover:bg-surface-primary/80">继续编辑</button>
            </div>
          </div>
        </div>
      )}
      {menuPos && (
        <ContextMenu
          x={menuPos.x}
          y={menuPos.y}
          items={[{
            label: /Mac|iPhone|iPad/.test(navigator.platform) ? "在 Finder 中显示" : "在资源管理器中显示",
            action: () => { api.revealInFileManager(photo.path).catch(console.error); },
          }]}
          onClose={() => setMenuPos(null)}
        />
      )}
    </div>
  );
  return embedded ? panel : createPortal(panel, document.body);
});
