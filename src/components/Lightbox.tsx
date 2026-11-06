import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useStore } from "../hooks/usePhotos";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as api from "../api/tauri";
import type { FaceCluster, FaceDetection, Photo, PhotoEdit } from "../types";
import ContextMenu from "./ContextMenu";
import KeyboardShortcutsDialog from "./KeyboardShortcutsDialog";
import PhotoDetail from "./PhotoDetail";
import { faceBoxForDisplay } from "../utils/faceGeometry";

const FILMSTRIP_HEIGHT = 80;
const THUMB_SIZE = 60;
const THUMB_GAP = 4;
const DETAIL_WIDTH = 390;

// Cache thumbnail URLs per session
const thumbCache = new Map<number, string>();

interface Props { photoId: number; onClose: () => void }

export default React.memo(function Lightbox({ photoId, onClose }: Props) {
  const { photos: storePhotos, setLightboxPhotoId, selectedPhotoId, setSelectedPhotoId, updatePhotoInList } = useStore();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [currentPhoto, setCurrentPhotoState] = useState<Photo | null>(null);
  const currentIndex = useMemo(() => photos.findIndex((p) => p.id === photoId), [photos, photoId]);
  const prevPhotoIdRef = useRef(photoId);

  // When the lightbox navigates, keep the detail drawer in sync
  useEffect(() => {
    if (selectedPhotoId === prevPhotoIdRef.current && prevPhotoIdRef.current !== photoId) {
      setSelectedPhotoId(photoId);
    }
    prevPhotoIdRef.current = photoId;
  }, [photoId, selectedPhotoId, setSelectedPhotoId]);

  // Build a stable, folder-local navigation context. Map markers are loaded by
  // viewport and the main grid is paged, so neither collection is suitable for
  // a lightbox filmstrip.
  useEffect(() => {
    const existing = photos.find((photo) => photo.id === photoId);
    if (existing) {
      setCurrentPhotoState(existing);
      return;
    }

    let cancelled = false;
    setCurrentPhotoState(null);
    Promise.allSettled([api.getPhoto(photoId), api.getLightboxPhotos(photoId)])
      .then(([photoResult, siblingsResult]) => {
        if (cancelled) return;
        if (photoResult.status === "rejected") throw photoResult.reason;
        const photo = photoResult.value;
        const siblings = siblingsResult.status === "fulfilled" ? siblingsResult.value : [];
        const context = siblings.some((item) => item.id === photoId) ? siblings : [photo];
        setPhotos(context);
        setCurrentPhotoState(photo);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error(error);
        const fallback = storePhotos.find((photo) => photo.id === photoId);
        if (fallback) {
          setPhotos(storePhotos);
          setCurrentPhotoState(fallback);
        }
      });
    return () => { cancelled = true; };
  }, [photoId, photos, storePhotos]);

  // Navigate
  const navigate = useCallback((direction: -1 | 1) => {
    const newPhoto = photos[currentIndex + direction];
    if (newPhoto?.id) setLightboxPhotoId(newPhoto.id);
  }, [photos, currentIndex, setLightboxPhotoId]);

  // Filmstrip virtualizer
  const filmstripRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: photos.length,
    getScrollElement: () => filmstripRef.current,
    estimateSize: () => THUMB_SIZE + THUMB_GAP,
    horizontal: true,
    overscan: 10,
  });

  // Auto-scroll filmstrip to current
  useEffect(() => {
    if (currentIndex >= 0) {
      virtualizer.scrollToIndex(currentIndex, { align: "center", behavior: "smooth" });
    }
  }, [currentIndex, virtualizer]);

  const [preview, setPreview] = useState<{ url: string; original: boolean } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [faces, setFaces] = useState<FaceDetection[]>([]);
  const [faceClusters, setFaceClusters] = useState<FaceCluster[]>([]);
  const [editingFaceId, setEditingFaceId] = useState<number | null>(null);
  const [showFaceBoxes, setShowFaceBoxes] = useState(() => localStorage.getItem("photofactory.lightboxFaceBoxes") !== "false");
  const [decodedDimensions, setDecodedDimensions] = useState<{ width: number; height: number } | null>(null);
  const [savedEdit, setSavedEdit] = useState<PhotoEdit | null>(null);
  const isPanningRef = useRef(false);
  const [isPanning, setIsPanning] = useState(false);
  const [isWheelZooming, setIsWheelZooming] = useState(false);
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const panOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const wheelEndTimerRef = useRef<number | null>(null);

  useEffect(() => {
    localStorage.setItem("photofactory.lightboxFaceBoxes", String(showFaceBoxes));
  }, [showFaceBoxes]);

  useEffect(() => {
    let cancelled = false;
    setFaces([]);
    setEditingFaceId(null);
    Promise.all([api.getPhotoFaces(photoId), api.getClusters()])
      .then(([photoFaces, clusters]) => {
        if (cancelled) return;
        setFaces(photoFaces);
        setFaceClusters(clusters);
      })
      .catch((error) => {
        if (!cancelled) console.error("Failed to load lightbox faces:", error);
      });
    return () => { cancelled = true; };
  }, [photoId]);

  useEffect(() => {
    let live = true;
    setSavedEdit(null);
    api.getPhotoEdit(photoId).then((value) => { if (live) setSavedEdit(value); }).catch(() => {});
    return () => { live = false; };
  }, [photoId]);

  useEffect(() => () => {
    if (wheelEndTimerRef.current != null) window.clearTimeout(wheelEndTimerRef.current);
  }, []);

  useEffect(() => {
    setPreview(null);
    setDecodedDimensions(null);
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
    zoomRef.current = 1;
    panOffsetRef.current = { x: 0, y: 0 };
    setMenuPos(null);
    if (!currentPhoto) return;
    let cancelled = false;

    // Paint a bounded preview quickly, then replace it with the original as
    // soon as WebKit has decoded it. Unsupported RAW formats simply keep the
    // generated preview.
    api.getThumbnailPath(currentPhoto.id!, "large")
      .then((path) => {
        if (!cancelled) {
          const url = convertFileSrc(path);
          setPreview((value) => value?.original ? value : { url, original: false });
        }
      })
      .catch(() => {});

    const originalUrl = convertFileSrc(currentPhoto.path);
    const original = new Image();
    original.decoding = "async";
    original.onload = () => {
      if (!cancelled) setPreview({ url: originalUrl, original: true });
    };
    original.src = originalUrl;

    return () => {
      cancelled = true;
      original.onload = null;
      original.onerror = null;
      original.src = "";
    };
  }, [photoId, currentPhoto?.path]);

  // Zoom around the mouse position so inspecting a detail does not make it
  // jump away from the pointer. The fitted image is the minimum zoom level.
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const pointer = {
      x: e.clientX - (rect.left + rect.width / 2),
      y: e.clientY - (rect.top + rect.height / 2),
    };
    const oldZoom = zoomRef.current;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const nextZoom = Math.min(12, Math.max(1, oldZoom * factor));
    if (Math.abs(nextZoom - oldZoom) < 0.0001) return;
    const nextOffset = nextZoom <= 1.0001
      ? { x: 0, y: 0 }
      : {
          x: pointer.x - (pointer.x - panOffsetRef.current.x) * (nextZoom / oldZoom),
          y: pointer.y - (pointer.y - panOffsetRef.current.y) * (nextZoom / oldZoom),
        };
    zoomRef.current = nextZoom;
    panOffsetRef.current = nextOffset;
    setZoom(nextZoom);
    setPanOffset(nextOffset);
    setIsWheelZooming(true);
    if (wheelEndTimerRef.current != null) window.clearTimeout(wheelEndTimerRef.current);
    wheelEndTimerRef.current = window.setTimeout(() => {
      setIsWheelZooming(false);
      wheelEndTimerRef.current = null;
    }, 140);
  }, []);

  // Pointer capture keeps the grab gesture active even when the cursor moves
  // outside the image. The image itself is non-draggable, preventing WebKit's
  // translucent native drag preview.
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest("button, [data-lightbox-control]")) return;
    if (zoom <= 1 || e.button !== 0) return;
    e.preventDefault();
    isPanningRef.current = true;
    setIsPanning(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    panStartRef.current = { x: e.clientX - panOffset.x, y: e.clientY - panOffset.y };
  }, [zoom, panOffset]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isPanningRef.current) return;
    e.preventDefault();
    const nextOffset = { x: e.clientX - panStartRef.current.x, y: e.clientY - panStartRef.current.y };
    panOffsetRef.current = nextOffset;
    setPanOffset(nextOffset);
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    isPanningRef.current = false;
    setIsPanning(false);
  }, []);

  const handleDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (zoom > 1) {
      setZoom(1);
      setPanOffset({ x: 0, y: 0 });
      zoomRef.current = 1;
      panOffsetRef.current = { x: 0, y: 0 };
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const pointer = {
      x: e.clientX - (rect.left + rect.width / 2),
      y: e.clientY - (rect.top + rect.height / 2),
    };
    setZoom(2);
    const nextOffset = { x: -pointer.x, y: -pointer.y };
    zoomRef.current = 2;
    panOffsetRef.current = nextOffset;
    setPanOffset(nextOffset);
  }, [zoom]);

  const updateCurrentPhoto = useCallback((updates: Partial<Photo>) => {
    setCurrentPhotoState((photo) => photo ? { ...photo, ...updates } : photo);
    setPhotos((items) => items.map((photo) => photo.id === photoId ? { ...photo, ...updates } : photo));
    updatePhotoInList(photoId, updates);
  }, [photoId, updatePhotoInList]);

  const applyRating = useCallback(async (rating: number) => {
    if (!currentPhoto) return;
    const previous = currentPhoto.rating;
    updateCurrentPhoto({ rating });
    try {
      await api.updatePhotosRating([photoId], rating);
    } catch (error) {
      updateCurrentPhoto({ rating: previous });
      console.error("Failed to update rating:", error);
    }
  }, [currentPhoto, photoId, updateCurrentPhoto]);

  const toggleFavorite = useCallback(async () => {
    if (!currentPhoto) return;
    const previous = currentPhoto.is_favorite;
    updateCurrentPhoto({ is_favorite: !previous });
    try {
      const isFavorite = await api.togglePhotoFavorite(photoId);
      updateCurrentPhoto({ is_favorite: isFavorite });
    } catch (error) {
      updateCurrentPhoto({ is_favorite: previous });
      console.error("Failed to update favorite:", error);
    }
  }, [currentPhoto, photoId, updateCurrentPhoto]);

  const toggleKeyboardZoom = useCallback(() => {
    setZoom((current) => {
      const next = current > 1 ? 1 : 2;
      zoomRef.current = next;
      if (next === 1) {
        panOffsetRef.current = { x: 0, y: 0 };
        setPanOffset({ x: 0, y: 0 });
      }
      return next;
    });
  }, []);

  const adjustKeyboardZoom = useCallback((direction: -1 | 1) => {
    setZoom((current) => {
      const next = Math.min(12, Math.max(1, current * (direction > 0 ? 1.35 : 1 / 1.35)));
      zoomRef.current = next;
      if (next === 1) {
        panOffsetRef.current = { x: 0, y: 0 };
        setPanOffset({ x: 0, y: 0 });
      }
      return next;
    });
  }, []);

  // Lightroom-style keyboard workflow. Shortcuts are disabled while typing
  // and the help dialog owns Escape/? while it is visible.
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable) return;
      if (showShortcuts || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key;
      if (/^[0-5]$/.test(key)) {
        event.preventDefault();
        void applyRating(Number(key));
        return;
      }
      switch (key) {
        case "ArrowRight": event.preventDefault(); if (zoom <= 1) navigate(1); break;
        case "ArrowLeft": event.preventDefault(); if (zoom <= 1) navigate(-1); break;
        case "Home": event.preventDefault(); if (photos[0]?.id) setLightboxPhotoId(photos[0].id!); break;
        case "End": {
          event.preventDefault();
          const lastPhoto = photos[photos.length - 1];
          if (lastPhoto?.id) setLightboxPhotoId(lastPhoto.id);
          break;
        }
        case "f":
        case "F": event.preventDefault(); void toggleFavorite(); break;
        case "i":
        case "I": event.preventDefault(); setSelectedPhotoId(selectedPhotoId === photoId ? null : photoId); break;
        case " ":
        case "z":
        case "Z": event.preventDefault(); toggleKeyboardZoom(); break;
        case "+":
        case "=": event.preventDefault(); adjustKeyboardZoom(1); break;
        case "-":
        case "_": event.preventDefault(); adjustKeyboardZoom(-1); break;
        case "?": event.preventDefault(); setShowShortcuts(true); break;
        case "g":
        case "G":
        case "Escape": event.preventDefault(); onClose(); break;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [adjustKeyboardZoom, applyRating, navigate, onClose, photoId, photos, selectedPhotoId, setLightboxPhotoId, setSelectedPhotoId, showShortcuts, toggleFavorite, toggleKeyboardZoom, zoom]);

  const detailsOpen = selectedPhotoId === photoId;
  const clusterNames = useMemo(() => new Map(
    faceClusters.filter((cluster) => cluster.id != null).map((cluster) => [cluster.id!, cluster.name?.trim() || "未命名人物"]),
  ), [faceClusters]);
  const sourceOrientation = preview?.original ? (currentPhoto?.orientation || 1) : 1;
  const swapsDimensions = sourceOrientation >= 5 && sourceOrientation <= 8;
  const faceCanvasWidth = currentPhoto?.width
    || (decodedDimensions ? (swapsDimensions ? decodedDimensions.height : decodedDimensions.width) : 0);
  const faceCanvasHeight = currentPhoto?.height
    || (decodedDimensions ? (swapsDimensions ? decodedDimensions.width : decodedDimensions.height) : 0);

  return (
    <div className="fixed inset-0 bg-black/95 z-[1000] flex flex-col">
      <div className="pointer-events-none absolute left-4 top-4 z-10 rounded-xl bg-black/45 px-3 py-2 text-xs text-white/85 backdrop-blur-sm">
        <div className="max-w-[45vw] truncate font-medium">{currentPhoto?.filename}</div>
        <div className="mt-1 text-amber-400">{currentPhoto?.rating ? "★".repeat(currentPhoto.rating) : "未评星"}{currentPhoto?.is_favorite ? <span className="ml-2 text-red-400">♥ 收藏</span> : null}</div>
      </div>
      <button
        type="button"
        onClick={() => setShowShortcuts(true)}
        className="absolute top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/30 text-sm text-white/70 hover:bg-black/60 hover:text-white"
        style={{ right: detailsOpen ? DETAIL_WIDTH + 56 : 56 }}
        title="键盘快捷键 (?)"
        aria-label="查看键盘快捷键"
      >
        ?
      </button>
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 z-10 text-white/70 hover:text-white text-2xl bg-black/30 rounded-full w-8 h-8 flex items-center justify-center"
        style={{ right: detailsOpen ? DETAIL_WIDTH + 16 : 16 }}
      >
        &times;
      </button>

      <div className="flex min-h-0 flex-1">
      {/* Main image area */}
      <div
        className="min-w-0 flex-1 flex items-center justify-center relative overflow-hidden"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (currentPhoto) setMenuPos({ x: event.clientX, y: event.clientY });
        }}
        style={{
          cursor: zoom > 1 ? (isPanning ? "grabbing" : "grab") : "zoom-in",
          touchAction: "none",
          userSelect: "none",
        }}
      >
        {/* Left arrow */}
        {currentIndex > 0 && zoom <= 1 && (
          <button
            onClick={() => navigate(-1)}
            className="absolute left-4 z-10 text-white/60 hover:text-white text-4xl p-2"
          >
            &#8249;
          </button>
        )}

        {faces.length > 0 && (
          <button
            type="button"
            data-lightbox-control
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setShowFaceBoxes((value) => !value)}
            className={`absolute left-4 top-20 z-10 flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur-sm transition-colors ${
              showFaceBoxes
                ? "border-accent-primary bg-accent-primary/85 text-white"
                : "border-white/20 bg-black/45 text-white/75 hover:bg-black/65"
            }`}
            aria-pressed={showFaceBoxes}
            aria-label={showFaceBoxes ? "隐藏人脸框" : "显示人脸框"}
            title={showFaceBoxes ? "隐藏人脸框" : `显示人脸框（${faces.length}）`}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
              <circle cx="12" cy="10" r="3" />
              <path d="M7.5 18c.8-2.4 2.3-3.6 4.5-3.6s3.7 1.2 4.5 3.6" />
              {!showFaceBoxes && <path d="M4 4l16 16" strokeWidth="2.2" />}
            </svg>
          </button>
        )}

        {/* Image and face overlay share the same transform and dimensions. */}
        {preview ? (
          <div
            className="relative inline-block max-w-[90%] leading-none"
            style={{
              transform: `translate3d(${panOffset.x}px, ${panOffset.y}px, 0) scale(${zoom}) rotate(${savedEdit?.rotation || 0}deg)`,
              transition: isPanning || isWheelZooming ? "none" : "transform 0.12s ease-out",
              transformOrigin: "center center",
            }}
          >
            <img
              key={photoId}
              src={preview.url}
              alt={currentPhoto?.filename}
              draggable={false}
              onDragStart={(event) => event.preventDefault()}
              onLoad={(event) => setDecodedDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              className="block max-w-full object-contain select-none pointer-events-none"
              style={{
                maxHeight: "calc(100vh - 120px)",
                filter: savedEdit
                  ? `brightness(${Math.max(0.1, 1 + savedEdit.exposure / 100)}) contrast(${Math.max(0.1, 1 + savedEdit.contrast / 100)}) sepia(${Math.abs(savedEdit.temperature) / 400}) hue-rotate(${savedEdit.temperature < 0 ? 180 : 0}deg)`
                  : undefined,
              }}
            />
            {showFaceBoxes && faceCanvasWidth > 0 && faceCanvasHeight > 0 && (
              <div className="pointer-events-none absolute inset-0 overflow-hidden">
                {faces.map((face) => {
                  const label = face.person_id == null ? "待整理" : (clusterNames.get(face.person_id) || "未命名人物");
                  const box = faceBoxForDisplay(face, faceCanvasWidth, faceCanvasHeight, sourceOrientation);
                  const isEditing = face.id != null && face.id === editingFaceId;
                  if (!box) return null;
                  return (
                    <div
                      key={face.id ?? `${face.bbox_x}-${face.bbox_y}`}
                      className={`absolute ${
                        isEditing
                          ? "z-10 border-4 border-emerald-400 shadow-[0_0_0_2px_rgba(255,255,255,0.95),0_0_18px_rgba(52,211,153,0.95)]"
                          : "border-2 border-red-500 shadow-[0_0_0_1px_rgba(255,255,255,0.7)]"
                      }`}
                      style={{
                        left: `${box.left}%`,
                        top: `${box.top}%`,
                        width: `${box.width}%`,
                        height: `${box.height}%`,
                      }}
                    >
                      <span className={`absolute left-[-2px] max-w-40 truncate rounded-t px-1.5 py-1 text-[11px] leading-none text-white shadow ${
                        isEditing ? "-top-7 bg-emerald-500 font-semibold" : "-top-6 bg-red-500"
                      }`}>
                        {label}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="text-white/50 text-lg">Loading...</div>
        )}

        {/* Right arrow */}
        {currentIndex < photos.length - 1 && zoom <= 1 && (
          <button
            onClick={() => navigate(1)}
            className="absolute right-4 z-10 text-white/60 hover:text-white text-4xl p-2"
          >
            &#8250;
          </button>
        )}

        {/* Zoom indicator */}
        {zoom !== 1 && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-surface-primary/80 text-white text-xs px-3 py-1 rounded-full pointer-events-none">
            {Math.round(zoom * 100)}%
          </div>
        )}

        {menuPos && currentPhoto && (
          <ContextMenu
            x={menuPos.x}
            y={menuPos.y}
            items={[{
              label: /Mac|iPhone|iPad/.test(navigator.platform) ? "在 Finder 中显示" : "在资源管理器中显示",
              action: () => { api.revealInFileManager(currentPhoto.path).catch(console.error); },
            }]}
            onClose={() => setMenuPos(null)}
          />
        )}

        {/* Info button — opens PhotoDetail drawer */}
        <button
          data-lightbox-control
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setSelectedPhotoId(selectedPhotoId === photoId ? null : photoId)}
          className="absolute bottom-4 right-4 z-10 w-8 h-8 rounded-full bg-black/40 hover:bg-black/60 text-white/70 hover:text-white flex items-center justify-center transition-colors"
          title="Photo details"
        >
          <span className="text-sm font-semibold">i</span>
        </button>
      </div>

      {detailsOpen && (
        <aside className="min-h-0 shrink-0 overflow-hidden bg-bg-secondary" style={{ width: DETAIL_WIDTH }}>
          <PhotoDetail
            embedded
            photoId={photoId}
            onClose={() => setSelectedPhotoId(null)}
            onEditingFaceChange={setEditingFaceId}
          />
        </aside>
      )}
      </div>

      {/* Filmstrip */}
      <div
        ref={filmstripRef}
        className="bg-black/90 border-t border-white/10 overflow-x-auto"
        style={{ height: FILMSTRIP_HEIGHT }}
      >
        <div
          style={{
            width: `${virtualizer.getTotalSize()}px`,
            height: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const photo = photos[virtualItem.index];
            if (!photo) return null;
            const isCurrent = photo.id === photoId;
            return (
              <div
                key={photo.id}
                className={`absolute top-1/2 -translate-y-1/2 cursor-pointer overflow-hidden rounded transition-all ${
                  isCurrent ? "ring-2 ring-accent-primary" : "ring-1 ring-surface-secondary"
                }`}
                style={{
                  width: THUMB_SIZE,
                  height: THUMB_SIZE,
                  left: `${virtualItem.start}px`,
                }}
                onClick={() => setLightboxPhotoId(photo.id!)}
              >
                <FilmstripThumbnail photo={photo} />
              </div>
            );
          })}
        </div>
      </div>
      <KeyboardShortcutsDialog open={showShortcuts} onClose={() => setShowShortcuts(false)} />
    </div>
  );
});

// Separate component for filmstrip thumbnails with lazy loading
function FilmstripThumbnail({ photo }: { photo: Photo }) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(() => thumbCache.get(photo.id!) ?? null);

  useEffect(() => {
    if (thumbCache.has(photo.id!)) return;
    let cancelled = false;
    api.getThumbnailPath(photo.id!, "small").then((path) => {
      if (!cancelled) {
        const url = convertFileSrc(path);
        thumbCache.set(photo.id!, url);
        setThumbUrl(url);
      }
    }).catch(() => {
      // Fallback: for small files, try file URL directly
      if (!cancelled && photo.file_size <= 30 * 1024 * 1024) {
        const url = convertFileSrc(photo.path);
        thumbCache.set(photo.id!, url);
        setThumbUrl(url);
      }
    });
    return () => { cancelled = true; };
  }, [photo.id, photo.path, photo.file_size]);

  return thumbUrl ? (
    <img src={thumbUrl} alt={photo.filename} className="w-full h-full object-cover" />
  ) : (
    <div className="w-full h-full bg-surface-primary flex items-center justify-center text-text-muted text-[8px]">...</div>
  );
}
