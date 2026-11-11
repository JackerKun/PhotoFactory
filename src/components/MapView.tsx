import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { MapContainer, useMapEvents, useMap, Marker, Popup, Polyline } from "react-leaflet";
import { convertFileSrc } from "@tauri-apps/api/core";
import Supercluster from "supercluster";
import type { Photo } from "../types";
import * as api from "../api/tauri";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import CachedTileLayer from "./CachedTileLayer";
import MapLayerToggle from "./MapLayerToggle";
import MapSearch from "./MapSearch";
import OfflineMapPanel from "./OfflineMapPanel";
import PhotoTrackPanel from "./PhotoTrackPanel";
import Icon from "./Icon";
import type { OfflineMapPackage } from "../api/tauri";
import type { MapSearchResult } from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import { useOfflineMapPackages, useOfflineMapStore } from "../hooks/useOfflineMaps";
import { mapPinIcon } from "./mapPin";
import { buildSpiderOffsets, photoThumbnailIcon } from "../utils/mapSpider";

const thumbnailCache = new Map<number, string>();
const MAX_MARKER_THUMBNAILS = 256;
const SPIDER_PAGE_SIZE = 20;

function rememberThumbnail(photoId: number, url: string) {
  if (thumbnailCache.has(photoId)) thumbnailCache.delete(photoId);
  thumbnailCache.set(photoId, url);
  while (thumbnailCache.size > MAX_MARKER_THUMBNAILS) {
    const oldest = thumbnailCache.keys().next().value;
    if (oldest === undefined) break;
    thumbnailCache.delete(oldest);
  }
}

type Viewport = { center: L.LatLngTuple; zoom: number };
const WORLD_VIEW: Viewport = { center: [20, 0], zoom: 2 };
const VIEWPORT_KEY = "photofactory.mapViewport";
let sessionViewport = WORLD_VIEW;

function readViewport(): Viewport {
  try {
    const value = localStorage.getItem(VIEWPORT_KEY);
    if (!value) return sessionViewport;
    const saved: Partial<Viewport> | null = JSON.parse(value);
    const { center, zoom } = saved ?? {};
    if (Array.isArray(center) && center.length === 2 && center.every(Number.isFinite) &&
        Math.abs(center[0]) <= 90 && Math.abs(center[1]) <= 180 &&
        typeof zoom === "number" && zoom >= 0 && zoom <= 19) {
      return { center, zoom };
    }
  } catch {
    return sessionViewport;
  }
  return WORLD_VIEW;
}

interface Props {
  onSelectPhoto: (id: number) => void;
  onOpenLightbox?: (id: number) => void;
  photoDetailsOpen?: boolean;
}

function MapViewport({ onBoundsChange }: { onBoundsChange: (bounds: L.LatLngBounds) => void }) {
  const map = useMapEvents({
    moveend: () => {
      const { lat, lng } = map.wrapLatLng(map.getCenter());
      sessionViewport = { center: [lat, lng], zoom: map.getZoom() };
      try { localStorage.setItem(VIEWPORT_KEY, JSON.stringify(sessionViewport)); }
      catch { /* Keep the session position when storage is unavailable. */ }
      onBoundsChange(map.getBounds());
    },
  });

  useEffect(() => {
    // Leaflet doesn't emit moveend on mount. Load photos in the initial view.
    onBoundsChange(map.getBounds());
  }, [map, onBoundsChange]);

  return null;
}

function OfflinePackageFocus({ target }: { target: OfflineMapPackage | null }) {
  const map = useMap();
  useEffect(() => {
    if (!target?.bounds) return;
    const [west, south, east, north] = target.bounds;
    map.fitBounds([[south, west], [north, east]], { maxZoom: target.max_zoom, padding: [16, 16], animate: false });
    if (map.getZoom() < target.min_zoom) map.setZoom(target.min_zoom, { animate: false });
  }, [map, target]);
  return null;
}

function SearchTarget({ target }: { target: MapSearchResult | null }) {
  const map = useMap();

  useEffect(() => {
    if (!target) return;
    map.setView([target.lat, target.lng], 16, { animate: false });
  }, [map, target]);

  if (!target) return null;
  return <Marker icon={mapPinIcon} position={[target.lat, target.lng]} zIndexOffset={2000} />;
}

function RequestedPhotoFocus({ request, onHandled }: {
  request: { lat: number; lng: number; photoId: number; requestId: number } | null;
  onHandled: () => void;
}) {
  const map = useMap();

  useEffect(() => {
    if (!request) return;
    // Center the requested photo at a useful neighborhood scale, without
    // zooming out if the user was already looking more closely.
    map.setView([request.lat, request.lng], Math.max(map.getZoom(), 15), { animate: false });
    onHandled();
  }, [map, onHandled, request]);

  return null;
}

function getClusterColor(count: number): string {
  if (count <= 2) return "#f97316";
  if (count <= 5) return "#eab308";
  if (count <= 10) return "#ef4444";
  return "#dc2626";
}

function clusterIconHtml(count: number): string {
  const color = getClusterColor(count);
  return `<div style="background:${color};border:2px solid white;border-radius:50%;width:40px;height:40px;display:flex;align-items:center;justify-content:center;color:white;font-weight:700;font-size:14px;box-shadow:0 2px 6px rgba(0,0,0,0.3)">${count}</div>`;
}

function PhotoMarker({ photo, onSelectPhoto, onOpenLightbox, map, thumbnailMarker, photoDetailsOpen }: {
  photo: Photo;
  onSelectPhoto: (id: number) => void;
  onOpenLightbox?: (id: number) => void;
  map: L.Map;
  thumbnailMarker?: boolean;
  photoDetailsOpen: boolean;
}) {
  const photoId = photo.id!;
  const [thumbUrl, setThumbUrl] = useState<string | null>(thumbnailCache.get(photoId) || null);
  const needsThumbnail = thumbnailMarker || !photoDetailsOpen;

  useEffect(() => {
    if (!needsThumbnail || thumbUrl) return;
    // Never load the original into a base64 string here. A 30 MB photo can expand to
    // ~40 MB in JS memory; the cached small thumbnail is enough for this popup.
    api.getThumbnailPath(photoId, "small").then((path) => {
      const url = convertFileSrc(path);
      rememberThumbnail(photoId, url);
      setThumbUrl(url);
    }).catch(console.error);
  }, [needsThumbnail, photoId, thumbUrl]);

  const thumbnailIcon = useMemo(
    () => thumbnailMarker ? photoThumbnailIcon(thumbUrl) : undefined,
    [thumbUrl, thumbnailMarker],
  );

  const stopPopupEvent = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    L.DomEvent.stopPropagation(event.nativeEvent);
  };

  return (
    <Marker
      position={[photo.latitude!, photo.longitude!]}
      icon={thumbnailIcon ?? mapPinIcon}
      zIndexOffset={thumbnailMarker ? 1000 : 0}
      eventHandlers={{
        click: (event) => {
          if (!photoDetailsOpen) return;
          // When the details panel is already visible, selecting a marker should
          // update that panel in place instead of opening another floating card.
          L.DomEvent.stopPropagation(event.originalEvent);
          map.closePopup();
          onSelectPhoto(photoId);
        },
        popupopen: (event) => {
          const popup = event.popup.getElement();
          if (popup) L.DomEvent.disableClickPropagation(popup);
        },
      }}
    >
      {!photoDetailsOpen && <Popup maxWidth={180}>
        <div className="text-center">
          {thumbUrl ? (
            <button
              type="button"
              className="block w-full mb-1"
              title={onOpenLightbox ? "打开大图" : undefined}
              onClick={(event) => {
                if (!onOpenLightbox) return;
                stopPopupEvent(event);
                map.closePopup();
                onOpenLightbox(photoId);
              }}
            >
              <img src={thumbUrl} alt={photo.filename} className="w-full h-24 object-cover rounded" />
            </button>
          ) : (
            <div className="w-full h-24 bg-gray-800 rounded mb-1 flex items-center justify-center text-gray-500 text-xs">正在加载…</div>
          )}
          <p className="font-medium text-xs truncate">{photo.filename}</p>
          <div className="flex gap-2 mt-2 justify-center">
            <button
              className="h-8 w-8 rounded-full bg-gray-100 hover:bg-blue-100 text-blue-600 dark:text-blue-300 inline-flex items-center justify-center transition-colors"
              title="查看详情"
              aria-label="查看详情"
              onClick={(event) => { stopPopupEvent(event); map.closePopup(); onSelectPhoto(photo.id!); }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></svg>
            </button>
            {onOpenLightbox && (
              <button
                className="h-8 w-8 rounded-full bg-gray-100 hover:bg-blue-100 text-blue-600 dark:text-blue-300 inline-flex items-center justify-center transition-colors"
                title="大图预览"
                aria-label="大图预览"
                onClick={(event) => { stopPopupEvent(event); map.closePopup(); onOpenLightbox(photo.id!); }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 5h18v14H3z"/><circle cx="9" cy="10" r="2"/><path d="m3 17 5-5 4 4 3-3 6 6"/></svg>
              </button>
            )}
          </div>
        </div>
      </Popup>}
    </Marker>
  );
}

type PhotoProps = { id: number; filename: string; path: string; file_size: number };
type ClusterType = Supercluster.ClusterFeature<PhotoProps> | Supercluster.PointFeature<PhotoProps>;
type ExpandedCluster = {
  id: number;
  center: [number, number];
  count: number;
  page: number;
};

function ExpandedClusterPager({ expanded, pageCount, onPageChange, onClose }: {
  expanded: ExpandedCluster;
  pageCount: number;
  onPageChange: (page: number) => void;
  onClose: () => void;
}) {
  const controlRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!controlRef.current) return;
    // React's delegated click handler runs on the map container. Leaflet can see
    // that native event first, so isolate this control at the DOM node itself.
    L.DomEvent.disableClickPropagation(controlRef.current);
    L.DomEvent.disableScrollPropagation(controlRef.current);
  }, []);

  return (
    <div
      ref={controlRef}
      className="leaflet-control absolute bottom-6 left-1/2 z-[1000] flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/80 bg-bg-secondary/95 px-2 py-1.5 text-sm text-gray-700 shadow-xl backdrop-blur"
    >
      <button
        type="button"
        className="h-8 w-8 rounded-full text-lg hover:bg-gray-100 disabled:opacity-30"
        disabled={expanded.page === 0}
        aria-label="上一组照片"
        onClick={() => onPageChange(expanded.page - 1)}
      >
        ‹
      </button>
      <span className="min-w-28 text-center tabular-nums">
        {expanded.page * SPIDER_PAGE_SIZE + 1}–{Math.min((expanded.page + 1) * SPIDER_PAGE_SIZE, expanded.count)} / {expanded.count}
      </span>
      <button
        type="button"
        className="h-8 w-8 rounded-full text-lg hover:bg-gray-100 disabled:opacity-30"
        disabled={expanded.page >= pageCount - 1}
        aria-label="下一组照片"
        onClick={() => onPageChange(expanded.page + 1)}
      >
        ›
      </button>
      <button
        type="button"
        className="h-8 w-8 rounded-full text-lg text-gray-500 hover:bg-gray-100"
        aria-label="收起照片"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}

function ClusterLayer({ photos, onSelectPhoto, onOpenLightbox, photoDetailsOpen }: {
  photos: Photo[];
  onSelectPhoto: (id: number) => void;
  onOpenLightbox?: (id: number) => void;
  photoDetailsOpen: boolean;
}) {
  const map = useMap();
  const indexRef = useRef<Supercluster<PhotoProps, PhotoProps> | null>(null);
  const [clusters, setClusters] = useState<ClusterType[]>([]);
  const [zoom, setZoom] = useState(map.getZoom());
  const [bounds, setBounds] = useState<L.LatLngBounds>(map.getBounds());
  const [indexVersion, setIndexVersion] = useState(0);
  const [expanded, setExpanded] = useState<ExpandedCluster | null>(null);

  useEffect(() => {
    const points: Supercluster.PointFeature<PhotoProps>[] = photos
      .filter((p) => p.latitude != null && p.longitude != null)
      .map((p) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.longitude!, p.latitude!] as [number, number] },
        properties: { id: p.id!, filename: p.filename, path: p.path, file_size: p.file_size },
      }));
    const index = new Supercluster<PhotoProps, PhotoProps>({ radius: 50, maxZoom: 16 });
    index.load(points);
    indexRef.current = index;
    setIndexVersion((version) => version + 1);
    setExpanded(null);
  }, [photos]);

  useEffect(() => {
    if (!indexRef.current) return;
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const bbox: [number, number, number, number] = [sw.lng, sw.lat, ne.lng, ne.lat];
    const result = indexRef.current.getClusters(bbox, zoom);
    setClusters(result as ClusterType[]);
  }, [zoom, bounds, indexVersion]);

  useMapEvents({
    zoomstart: () => setExpanded(null),
    dragstart: () => setExpanded(null),
    click: () => setExpanded(null),
    zoomend: (e) => setZoom(e.target.getZoom()),
    moveend: (e) => setBounds(e.target.getBounds()),
  });

  const handleClusterClick = useCallback((
    event: L.LeafletMouseEvent,
    clusterId: number,
    coordinates: [number, number],
    count: number,
  ) => {
    L.DomEvent.stopPropagation(event.originalEvent);
    map.closePopup();
    setExpanded((current) => current?.id === clusterId
      ? null
      : { id: clusterId, center: [coordinates[1], coordinates[0]], count, page: 0 });
  }, [map]);

  const expandedPhotos = useMemo(() => {
    const index = indexRef.current;
    if (!expanded || !index) return [];
    return index
      .getLeaves(expanded.id, SPIDER_PAGE_SIZE, expanded.page * SPIDER_PAGE_SIZE)
      .map((leaf) => ({
        ...leaf.properties,
        latitude: leaf.geometry.coordinates[1],
        longitude: leaf.geometry.coordinates[0],
      } as Photo));
  }, [expanded, indexVersion]);

  const spiderPhotos = useMemo(() => {
    if (!expanded) return [];
    const centerPoint = map.project(L.latLng(expanded.center), zoom);
    return buildSpiderOffsets(expandedPhotos.length).map(([x, y], index) => ({
      photo: expandedPhotos[index],
      position: map.unproject(centerPoint.add(L.point(x, y)), zoom),
    }));
  }, [expanded, expandedPhotos, map, zoom]);

  const pageCount = expanded ? Math.ceil(expanded.count / SPIDER_PAGE_SIZE) : 0;

  return (
    <>
      {clusters.map((cluster) => {
        const props = cluster.properties as { cluster?: boolean; cluster_id?: number; point_count?: number } & PhotoProps;
        if (props.cluster) {
          return (
            <Marker
              key={props.cluster_id}
              position={[cluster.geometry.coordinates[1], cluster.geometry.coordinates[0]]}
              icon={L.divIcon({
                html: clusterIconHtml(props.point_count!),
                className: "",
                iconSize: [40, 40],
              })}
              eventHandlers={{
                click: (event) => handleClusterClick(
                  event,
                  props.cluster_id!,
                  cluster.geometry.coordinates as [number, number],
                  props.point_count!,
                ),
              }}
            />
          );
        }
        const p = cluster.properties as PhotoProps;
        const photo: Photo = {
          ...p,
          latitude: cluster.geometry.coordinates[1],
          longitude: cluster.geometry.coordinates[0],
        } as Photo;
        return (
          <PhotoMarker
            key={`photo-${photo.id}`}
            photo={photo}
            onSelectPhoto={onSelectPhoto}
            onOpenLightbox={onOpenLightbox}
            map={map}
            photoDetailsOpen={photoDetailsOpen}
          />
        );
      })}
      {expanded && spiderPhotos.map(({ photo, position }) => (
        <React.Fragment key={`spider-${expanded.id}-${expanded.page}-${photo.id}`}>
          <Polyline
            positions={[expanded.center, [position.lat, position.lng]]}
            pathOptions={{ color: "#64748b", weight: 1.25, opacity: 0.55 }}
            interactive={false}
          />
          <PhotoMarker
            photo={{ ...photo, latitude: position.lat, longitude: position.lng }}
            onSelectPhoto={onSelectPhoto}
            onOpenLightbox={onOpenLightbox}
            map={map}
            thumbnailMarker
            photoDetailsOpen={photoDetailsOpen}
          />
        </React.Fragment>
      ))}
      {expanded && createPortal(
        <ExpandedClusterPager
          expanded={expanded}
          pageCount={pageCount}
          onPageChange={(page) => setExpanded((current) => current ? { ...current, page } : current)}
          onClose={() => setExpanded(null)}
        />,
        map.getContainer(),
      )}
    </>
  );
}

export default React.memo(function MapView({ onSelectPhoto, onOpenLightbox, photoDetailsOpen = false }: Props) {
  const [initialViewport] = useState(readViewport);
  const mapLayer = useOfflineMapStore((state) => state.layer);
  const setMapLayer = useOfflineMapStore((state) => state.setLayer);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [bounds, setBounds] = useState<L.LatLngBounds | null>(null);
  const [searchTarget, setSearchTarget] = useState<MapSearchResult | null>(null);
  const [offlineTarget, setOfflineTarget] = useState<OfflineMapPackage | null>(null);
  const [trackOpen, setTrackOpen] = useState(false);
  const projectPath = useStore((state) => state.project?.root_path);
  const mapFocusRequest = useStore((state) => state.mapFocusRequest);
  const clearMapFocusRequest = useStore((state) => state.clearMapFocusRequest);

  const offlineMaps = useOfflineMapPackages();
  const viewOfflinePack = useCallback((pack: OfflineMapPackage) => {
    setMapLayer(pack.layer);
    setOfflineTarget({ ...pack });
  }, [setMapLayer]);

  useEffect(() => {
    if (!bounds) return;
    let cancelled = false;
    // Coalesce rapid pan/zoom updates. The cancellation guard prevents a slower,
    // stale query from replacing data for the current viewport.
    const timer = window.setTimeout(() => {
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      api.getPhotosWithGps(sw.lat, ne.lat, sw.lng, ne.lng, 5000)
        .then((next) => { if (!cancelled) setPhotos(next); })
        .catch((error) => { if (!cancelled) console.error(error); });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bounds]);

  return (
    <div className="relative isolate h-full">
      <MapContainer center={initialViewport.center} zoom={initialViewport.zoom} className="absolute inset-0 z-0 h-full w-full">
        <CachedTileLayer layer={mapLayer} />
        <MapViewport onBoundsChange={setBounds} />
        <RequestedPhotoFocus request={mapFocusRequest} onHandled={clearMapFocusRequest} />
        <SearchTarget target={searchTarget} />
        <OfflinePackageFocus target={offlineTarget} />
        {trackOpen && projectPath ? <PhotoTrackPanel key={projectPath}
          onClose={() => setTrackOpen(false)}
          onViewPhoto={onOpenLightbox ?? onSelectPhoto}
        /> : <ClusterLayer
          photos={photos}
          onSelectPhoto={onSelectPhoto}
          onOpenLightbox={onOpenLightbox}
          photoDetailsOpen={photoDetailsOpen}
        />}
      </MapContainer>
      <MapSearch
        className="absolute left-1/2 top-3 z-[1200] w-[min(620px,calc(100%-250px))] -translate-x-1/2"
        onSelect={setSearchTarget}
      />
      <MapLayerToggle value={mapLayer} onChange={setMapLayer}>
        <OfflineMapPanel maps={offlineMaps} layer={mapLayer} onView={viewOfflinePack} />
        <button type="button" title="拍摄轨迹" aria-label="拍摄轨迹" aria-expanded={trackOpen} disabled={!projectPath}
          className={`flex h-8 items-center rounded-md px-2.5 disabled:opacity-50 ${trackOpen ? "bg-accent-primary text-white" : "text-gray-600 hover:bg-text-primary/5"}`}
          onClick={() => setTrackOpen((open) => !open)}><Icon name="route" size={17} /></button>
      </MapLayerToggle>
    </div>
  );
});
