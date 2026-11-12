import { Component, useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import { HashRouter, Routes, Route, Navigate, useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import Sidebar from "./components/Sidebar";
import AppUpdates from "./components/AppUpdates";
import PhotoGrid from "./components/PhotoGrid";
import PhotoDetail, { GpsBatchEditor } from "./components/PhotoDetail";
import MapView from "./components/MapView";
import FaceView from "./components/FaceView";
import TagView from "./components/TagView";
import SmartAlbumView from "./components/SmartAlbumView";
import LibraryToolsView from "./components/LibraryToolsView";
import ImportModal from "./components/ImportModal";
import Lightbox from "./components/Lightbox";
import { useStore } from "./hooks/usePhotos";
import { usePreparePhotoMemories } from "./hooks/usePhotoMemories";
import { useKeyboardNavigation } from "./hooks/useKeyboardNavigation";
import type { AiProcessingStatus, ViewMode } from "./types";
import * as api from "./api/tauri";
import { photoFilterFromSearchParams, photoRouteForTag, photoSearchParamsFromFilter } from "./utils/photoRoutes";

class GpsEditorErrorBoundary extends Component<
  { children: ReactNode; onClose: () => void },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("GPS editor crashed:", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fixed inset-0 z-[70] flex items-center justify-center bg-bg-primary p-8">
        <div className="max-w-lg rounded-2xl border border-red-200 bg-white p-6 shadow-xl">
          <h2 className="text-lg font-semibold text-text-primary">坐标编辑器无法打开</h2>
          <p className="mt-2 break-words text-sm text-red-600">{this.state.error.message}</p>
          <button type="button" className="mt-4 rounded-lg bg-accent-primary px-4 py-2 text-sm text-white" onClick={this.props.onClose}>返回照片</button>
        </div>
      </div>
    );
  }
}

/** Sync URL query params ↔ Zustand filter. Load photos when route or params change. */
function FilterSync() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { filter, setFilter, loadPhotos, project, setPhotoRoute } = useStore();
  const isPhotoRoute = location.pathname === "/" || location.pathname === "/grid";
  const syncingFromUrl = useRef(false);
  const urlFilter = useMemo(() => photoFilterFromSearchParams(searchParams), [searchParams]);
  const urlFilterKey = JSON.stringify(urlFilter);
  const filterKey = JSON.stringify(filter);

  // Initialize filter from URL when route/params change
  useEffect(() => {
    if (!project || !isPhotoRoute) return;
    const filterChanged = urlFilterKey !== filterKey;
    if (filterChanged) {
      // Both synchronization effects run for the same render. Mark this before
      // changing Zustand so the stale store value cannot immediately erase the
      // just-opened URL and start an infinite navigation loop.
      syncingFromUrl.current = true;
      setFilter(urlFilter, true);
      loadPhotos();
    } else {
      const state = useStore.getState();
      if (state.photos.length === 0 && !state.loading) loadPhotos();
    }
    setPhotoRoute(`${location.pathname}${location.search}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.search, project, urlFilterKey]);

  // Sync Zustand filter changes back to URL
  // With HashRouter, location.search is always empty — query params are in the hash.
  // So we build the full search string from filter state, preserving any non-filter params
  // (like "tab" from FaceView) by reading them from the current hash.
  useEffect(() => {
    if (!isPhotoRoute) return;
    if (syncingFromUrl.current) {
      if (filterKey === urlFilterKey) syncingFromUrl.current = false;
      return;
    }
    const params = photoSearchParamsFromFilter(filter, searchParams);

    const finalQs = params.toString();
    const target = `${location.pathname}${finalQs ? "?" + finalQs : ""}`;
    if (`${location.pathname}${location.search}` !== target) {
      navigate(target, { replace: true });
    }
  }, [filterKey, urlFilterKey, isPhotoRoute, location.pathname, location.search, navigate, searchParams]);

  return null;
}

/** Shared layout: Sidebar + main content + detail panel + lightbox + import modal */
function AppLayout({ children, viewMode }: { children: React.ReactNode; viewMode: ViewMode }) {
  const { project, setProject, lightboxPhotoId, setLightboxPhotoId, selectedPhotoId, setSelectedPhotoId, photos, gpsBatchSession, closeGpsBatchEditor, batchGpsPending, setBatchGpsPending } = useStore();
  const updatePhotoInList = useStore((s) => s.updatePhotoInList);
  const navigate = useNavigate();
  const hasStandalonePhotoDetail = viewMode === "grid" || viewMode === "albums" || viewMode === "map";
  const [showImport, setShowImport] = useState(!project);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem("photofactory.sidebarWidth"));
    return Number.isFinite(stored) && stored >= 220 && stored <= 480 ? stored : 256;
  });
  const [detailWidth, setDetailWidth] = useState(() => {
    const stored = Number(localStorage.getItem("photofactory.detailWidth"));
    return Number.isFinite(stored) && stored >= 320 && stored <= 720 ? stored : 384;
  });

  const beginResize = useCallback((panel: "sidebar" | "detail", event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel === "sidebar" ? sidebarWidth : detailWidth;
    const min = panel === "sidebar" ? 220 : 320;
    const max = panel === "sidebar" ? 480 : Math.max(320, Math.min(720, window.innerWidth - sidebarWidth - 280));
    const oldCursor = document.body.style.cursor;
    const oldSelection = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const move = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const candidate = startWidth + (panel === "sidebar" ? delta : -delta);
      const next = Math.round(Math.max(min, Math.min(max, candidate)));
      if (panel === "sidebar") setSidebarWidth(next);
      else setDetailWidth(next);
    };
    const finish = () => {
      document.body.style.cursor = oldCursor;
      document.body.style.userSelect = oldSelection;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
  }, [detailWidth, sidebarWidth]);

  useEffect(() => localStorage.setItem("photofactory.sidebarWidth", String(sidebarWidth)), [sidebarWidth]);
  useEffect(() => localStorage.setItem("photofactory.detailWidth", String(detailWidth)), [detailWidth]);

  useEffect(() => {
    if (project) return;
    api.getProject().then((p) => {
      if (p) {
        setProject(p);
        // Auto-start thumbnail batch + AI if there are pending photos
        api.startThumbnailBatch().then(() => {}).catch(() => {});
        api.triggerAutoAi().then(() => {}).catch(() => {});
      }
      else {
        api.getLastProjectPath().then((path) => {
          if (path) {
            api.openProject(path).then((p2) => {
              if (p2) {
                setProject(p2);
                api.startThumbnailBatch().then(() => {}).catch(() => {});
                api.triggerAutoAi().then(() => {}).catch(() => {});
              }
            }).catch(console.error);
          }
        }).catch(console.error);
      }
    }).catch(console.error);
  }, [project, setProject]);

  // Lightweight polling keeps local folders, NAS mounts and removable drives
  // current without introducing a platform-specific watcher dependency.
  useEffect(() => {
    if (!project) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    let disposed = false;
    api.getLibrarySettings().then((settings) => {
      if (disposed || settings.folder_monitor_enabled !== "true") return;
      const seconds = Math.max(15, Number(settings.folder_monitor_interval) || 60);
      timer = setInterval(async () => {
        try {
          const result = await api.incrementalScan();
          if (result.added || result.updated || result.restored) {
            await Promise.all([api.startThumbnailBatch(), api.triggerAutoAi()]);
          }
        } catch { /* disconnected storage is reflected in the storage panel */ }
      }, seconds * 1000);
    }).catch(() => {});
    return () => { disposed = true; if (timer) clearInterval(timer); };
  }, [project]);

  // The lightbox also uses the selection for its embedded detail panel.
  useEffect(() => {
    if (!hasStandalonePhotoDetail && !lightboxPhotoId && selectedPhotoId) {
      setSelectedPhotoId(null);
    }
  }, [hasStandalonePhotoDetail, lightboxPhotoId, selectedPhotoId, setSelectedPhotoId]);

  // Listen for AI status events
  useEffect(() => {
    let unsub: (() => void) | undefined;
    listen("ai_status_changed", (event) => {
      const payload = event.payload as any;
      const stage = payload.stage as AiProcessingStatus["stage"];
      useStore.getState().setAiProcessingStatus({
        status: payload.status,
        stage,
        processed: payload.processed,
        total: payload.total,
        failed: payload.failed,
      });
    }).then((unsubFn) => { unsub = unsubFn; });
    return () => { unsub?.(); };
  }, []);

  const handleImported = useCallback(() => {
    setShowImport(false);
    api.startThumbnailBatch().catch(() => {});
    api.triggerAutoAi().catch(() => {});
  }, []);
  const handleViewModeChange = useCallback((mode: ViewMode) => {
    if (mode !== "grid") {
      navigate(`/${mode}`);
      return;
    }
    const state = useStore.getState();
    const hasContextFilter = state.filter.person_id != null
      || !!state.filter.tag
      || state.filter.year != null
      || state.filter.month != null
      || state.filter.has_gps != null
      || state.filter.has_favorite != null
      || !!state.filter.keyword
      || !!state.filter.format
      || !!state.filter.camera
      || state.filter.iso_min != null
      || state.filter.iso_max != null
      || state.filter.aperture_min != null
      || state.filter.aperture_max != null
      || !!state.filter.exposure_time
      || !!state.filter.orientation_kind
      || state.filter.rating_min != null
      || state.filter.rating_max != null;
    if (hasContextFilter) {
      state.clearPhotoFilters();
      navigate("/");
    } else {
      navigate(state.photoRoute);
    }
  }, [navigate]);

  const sourcePhoto = gpsBatchSession?.sourcePhoto;
  const gpsPhotos = sourcePhoto && !photos.some((photo) => photo.id === sourcePhoto.id)
    ? [sourcePhoto, ...photos]
    : photos;
  return (
    <div className="app-shell flex h-screen w-screen bg-bg-primary text-text-primary">
      <FilterSync />
      <Sidebar width={sidebarWidth} viewMode={viewMode} onViewModeChange={handleViewModeChange} project={project} onImport={() => setShowImport(true)} />
      <div
        role="separator"
        aria-label="调整左侧栏宽度"
        aria-orientation="vertical"
        className="relative z-20 w-1 flex-none cursor-col-resize bg-transparent hover:bg-accent-primary/25 active:bg-accent-primary/40"
        onPointerDown={(event) => beginResize("sidebar", event)}
      ><span className="absolute inset-y-0 -left-1 -right-1" /></div>
      <main className="flex-1 overflow-hidden">{children}</main>
      {hasStandalonePhotoDetail && selectedPhotoId && !lightboxPhotoId && (
        <>
          <div
            role="separator"
            aria-label="调整照片详情栏宽度"
            aria-orientation="vertical"
            className="fixed top-0 bottom-0 z-[1002] w-1 cursor-col-resize bg-transparent hover:bg-accent-primary/30 active:bg-accent-primary/50"
            style={{ right: detailWidth - 2 }}
            onPointerDown={(event) => beginResize("detail", event)}
          ><span className="absolute inset-y-0 -left-1 -right-1" /></div>
          <PhotoDetail width={detailWidth} photoId={selectedPhotoId} onClose={() => setSelectedPhotoId(null)} />
        </>
      )}
      {lightboxPhotoId && !gpsBatchSession && <Lightbox photoId={lightboxPhotoId} onClose={() => setLightboxPhotoId(null)} />}
      {showImport && <ImportModal onImported={handleImported} onClose={() => setShowImport(false)} />}
      {gpsBatchSession && (
        <GpsEditorErrorBoundary onClose={closeGpsBatchEditor}>
        <GpsBatchEditor
          photos={gpsPhotos}
          currentPhotoId={gpsBatchSession.photoId}
          initialMode={gpsBatchSession.mode}
          initialSelectedIds={gpsBatchSession.selectedPhotoIds}
          photoLocations={(() => {
            const map = new Map<number, { lat: number; lng: number }>(
              gpsPhotos
                .filter((p) => p.latitude != null && p.longitude != null)
                .map((p) => [p.id!, { lat: p.latitude!, lng: p.longitude! }])
            );
            for (const [id, loc] of batchGpsPending) {
              map.set(id, loc);
            }
            return map;
          })()}
          onApply={async (ids, lat, lng) => {
            await api.updatePhotosGps(ids, lat, lng);
            ids.forEach((id) => updatePhotoInList(id, { latitude: lat, longitude: lng }));
            const newPending = new Map(batchGpsPending);
            ids.forEach((id) => newPending.delete(id));
            setBatchGpsPending(newPending);
          }}
          onApplyIndividual={async (updates) => {
            await api.updatePhotosGpsIndividual(updates);
            updates.forEach(({ photoId, latitude, longitude }) => {
              updatePhotoInList(photoId, { latitude, longitude });
            });
            const newPending = new Map(batchGpsPending);
            updates.forEach(({ photoId }) => newPending.delete(photoId));
            setBatchGpsPending(newPending);
          }}
          onClose={closeGpsBatchEditor}
        />
        </GpsEditorErrorBoundary>
      )}
    </div>
  );
}

function GridPage() {
  const { photos, thumbnailSize, lightboxPhotoId, selectedPhotoId, setSelectedPhotoId } = useStore();
  const project = useStore((s) => s.project);
  const gpsEditorOpen = useStore((s) => s.gpsBatchSession !== null);
  const setLightboxPhotoId = useStore((s) => s.setLightboxPhotoId);
  const updatePhotoInList = useStore((s) => s.updatePhotoInList);

  const handleSelectPhoto = useCallback((id: number) => {
    setSelectedPhotoId(id === -1 ? null : id);
  }, [setSelectedPhotoId]);

  const photoIds = useMemo(() => photos.map((p) => p.id!).filter(Boolean), [photos]);
  const columnCount = useMemo(() => {
    const mainWidth = window.innerWidth - 256 - (selectedPhotoId ? 384 : 0);
    return Math.max(1, Math.floor((mainWidth + 8) / (thumbnailSize + 8)));
  }, [selectedPhotoId, thumbnailSize]);

  const handleOpenPhoto = useCallback((id: number) => {
    setSelectedPhotoId(null);
    setLightboxPhotoId(id);
  }, [setLightboxPhotoId, setSelectedPhotoId]);

  const handleRatePhoto = useCallback(async (id: number, rating: number) => {
    await api.updatePhotosRating([id], rating);
    updatePhotoInList(id, { rating });
  }, [updatePhotoInList]);

  const handleToggleFavorite = useCallback(async (id: number) => {
    const isFavorite = await api.togglePhotoFavorite(id);
    updatePhotoInList(id, { is_favorite: isFavorite });
  }, [updatePhotoInList]);

  useKeyboardNavigation({
    selectedPhotoId,
    onSelectPhoto: handleSelectPhoto,
    photoIds,
    columnCount,
    enabled: !!project && !gpsEditorOpen,
    isLightboxOpen: !!lightboxPhotoId,
    onOpenPhoto: handleOpenPhoto,
    onRatePhoto: handleRatePhoto,
    onToggleFavorite: handleToggleFavorite,
  });

  return (
    <AppLayout viewMode="grid">
      <PhotoGrid
        onSelectPhoto={handleSelectPhoto}
        onDoubleClickPhoto={handleOpenPhoto}
        selectedPhotoId={selectedPhotoId}
      />
    </AppLayout>
  );
}

function MapPage() {
  const setLightboxPhotoId = useStore((s) => s.setLightboxPhotoId);
  const setSelectedPhotoId = useStore((s) => s.setSelectedPhotoId);
  const photoDetailsOpen = useStore((s) => s.selectedPhotoId != null);
  return (
    <AppLayout viewMode="map">
      <MapView
        onSelectPhoto={setSelectedPhotoId}
        onOpenLightbox={setLightboxPhotoId}
        photoDetailsOpen={photoDetailsOpen}
      />
    </AppLayout>
  );
}

function FacesPage() {
  return (
    <AppLayout viewMode="faces">
      <FaceView />
    </AppLayout>
  );
}

function TagsPage() {
  const navigate = useNavigate();
  const handleSelectTag = useCallback((label: string) => {
    navigate(photoRouteForTag(label));
  }, [navigate]);
  return (
    <AppLayout viewMode="tags">
      <TagView onSelectTag={handleSelectTag} />
    </AppLayout>
  );
}

function AlbumsPage() {
  const setSelectedPhotoId = useStore((s) => s.setSelectedPhotoId);
  return (
    <AppLayout viewMode="albums">
      <SmartAlbumView onSelectPhoto={setSelectedPhotoId} />
    </AppLayout>
  );
}

function LibraryPage() {
  return <AppLayout viewMode="library"><LibraryToolsView /></AppLayout>;
}

export default function App() {
  usePreparePhotoMemories();
  return (
    <AppUpdates>
      <HashRouter>
        <Routes>
          <Route path="/" element={<GridPage />} />
          <Route path="/grid" element={<GridPage />} />
          <Route path="/map" element={<MapPage />} />
          <Route path="/faces" element={<FacesPage />} />
          <Route path="/tags" element={<TagsPage />} />
          <Route path="/albums" element={<AlbumsPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </AppUpdates>
  );
}
