import React, { useEffect, useState, useCallback, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Photo } from "../types";
import * as api from "../api/tauri";
import Icon from "./Icon";
import { imageErrorMessage } from "../utils/imageError";
import ContextMenu from "./ContextMenu";
import { useStore } from "../hooks/usePhotos";

interface Props {
  photo: Photo;
  onClick: () => void;
  onDoubleClick?: () => void;
  size: number;
  height?: number;
  shape?: "square" | "proportional";
  isSelected?: boolean;
  ratingSelectionMode?: boolean;
  ratingSelected?: boolean;
  onToggleRatingSelection?: () => void;
}

export default React.memo(function PhotoCard({ photo, onClick, onDoubleClick, size, height, shape = "square", isSelected = false, ratingSelectionMode = false, ratingSelected = false, onToggleRatingSelection }: Props) {
  const thumbnailProgress = useStore((state) => state.thumbnailProcessingStatus?.processed ?? 0);
  const [thumbnailRetry, setThumbnailRetry] = useState(0);
  const [imageError, setImageError] = useState("图片加载失败");
  const [imageReady, setImageReady] = useState(false);
  const [smallUrl, setSmallUrl] = useState<string | null>(null);
  const [mediumUrl, setMediumUrl] = useState<string | null>(null);
  const [thumbState, setThumbState] = useState<"placeholder" | "loading" | "loaded" | "upgrading" | "error">("placeholder");
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thumbStateRef = useRef(thumbState);
  const cancelledRef = useRef(false);

  // Keep refs in sync
  useEffect(() => { thumbStateRef.current = thumbState; }, [thumbState]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
      if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
    };
  }, []);

  // A failed visible card must recover when the background batch creates its cache.
  useEffect(() => {
    if (thumbStateRef.current === "error") setThumbnailRetry((value) => value + 1);
  }, [thumbnailProgress]);

  useEffect(() => {
    if (!photo.id) return;
    const node = ref.current;
    if (!node) return;
    cancelledRef.current = false;
    let cancelled = false;
    let started = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setSmallUrl(null);
    setMediumUrl(null);
    setImageReady(false);
    setThumbState("placeholder");

    const load = async (attempt = 0) => {
      setThumbState("loading");
      try {
        const path = await api.getThumbnailPath(photo.id!, "small");
        if (!cancelled) {
          setSmallUrl(convertFileSrc(path));
          setThumbState("loaded");
        }
      } catch (error) {
        if (cancelled) return;
        setImageError(imageErrorMessage(error));
        // Fast scrolling can exhaust the native decoder slots temporarily.
        if (String(error).includes("Too many concurrent") && attempt < 8) {
          retryTimer = setTimeout(() => { void load(attempt + 1); }, Math.min(250 * 2 ** attempt, 2000));
        } else {
          setThumbState("error");
        }
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (!started && entries.some((entry) => entry.isIntersecting)) {
          started = true;
          observer.disconnect();
          void load();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      observer.disconnect();
    };
  }, [photo.id, photo.path, photo.thumbnail_status, thumbnailRetry]);

  const handleMouseEnter = useCallback(() => {
    if (!mediumUrl && thumbStateRef.current === "loaded") {
      hoverTimeoutRef.current = setTimeout(() => {
        setThumbState("upgrading");
        api.getThumbnailPath(photo.id!, "medium").then((path) => {
          setMediumUrl(convertFileSrc(path));
          setThumbState("loaded");
        }).catch(() => setThumbState("loaded"));
      }, 500);
    }
  }, [photo.id, mediumUrl]);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  // Browsers dispatch click before dblclick. Delay the single-click action just
  // enough to distinguish them so opening the lightbox never flashes the detail
  // inspector first.
  const handleCardClick = useCallback((event: React.MouseEvent) => {
    if (ratingSelectionMode) {
      if (event.detail <= 1) onToggleRatingSelection?.();
      return;
    }
    if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
    clickTimeoutRef.current = setTimeout(() => {
      clickTimeoutRef.current = null;
      onClick();
    }, 220);
  }, [onClick, onToggleRatingSelection, ratingSelectionMode]);

  const handleCardDoubleClick = useCallback(() => {
    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
    }
    if (!ratingSelectionMode) onDoubleClick?.();
  }, [onDoubleClick, ratingSelectionMode]);

  const handleToggleFavorite = useCallback(async () => {
    try {
      const isFav = await api.togglePhotoFavorite(photo.id!);
      const { useStore } = await import("../hooks/usePhotos");
      useStore.getState().updatePhotoInList(photo.id!, { is_favorite: isFav });
    } catch { /* ignore */ }
  }, [photo.id]);

  const handleReveal = useCallback(() => {
    api.revealInFileManager(photo.path).catch(console.error);
  }, [photo.path]);

  const handleRating = useCallback(async (rating: number) => {
    await api.updatePhotosRating([photo.id!], rating);
    const { useStore } = await import("../hooks/usePhotos");
    useStore.getState().updatePhotoInList(photo.id!, { rating });
  }, [photo.id]);

  const cardHeight = shape === "proportional" ? (height || size) : size;

  const displayUrl = mediumUrl || smallUrl;

  return (
    <div
      ref={ref}
      className={`relative overflow-hidden bg-surface-primary cursor-pointer transition-all ${
        ratingSelected
          ? "ring-4 ring-yellow-400"
          : isSelected
          ? "ring-2 ring-accent-primary"
          : "hover:ring-2 hover:ring-accent-primary"
      }`}
      style={{ width: "100%", height: cardHeight }}
      onClick={handleCardClick}
      onDoubleClick={handleCardDoubleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {displayUrl ? (
        <img
          src={displayUrl}
          alt={photo.filename}
          draggable={false}
          onDragStart={(event) => event.preventDefault()}
          className={`${shape === "square" ? "w-full h-full object-cover" : "w-full h-full object-contain"} ${
            thumbState === "upgrading" ? "opacity-70" : ""
          }`}
          loading="lazy"
          decoding="async"
          onLoad={() => setImageReady(true)}
          onError={() => {
            // Thumbnail file not found (e.g. cache deleted) — clear URL, show placeholder
            setSmallUrl(null);
            setMediumUrl(null);
            setImageError("缩略图加载失败");
            setThumbState("error");
          }}
        />
      ) : thumbState === "error" ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-2 text-center text-xs text-text-secondary" role="status">
          <Icon name="photos" size={24} />
          <span>{imageError}</span>
          <button type="button" className="ui-button" onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setThumbnailRetry((value) => value + 1); }}><Icon name="retry" size={14} />重试</button>
        </div>
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-xs text-text-secondary" role="status">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent-primary/25 border-t-accent-primary" />
          <span>{photo.thumbnail_status === 0 ? "正在生成缩略图…" : "正在加载图片…"}</span>
        </div>
      )}
      {displayUrl && !imageReady && <span className="absolute left-2 top-2 rounded bg-black/60 px-2 py-1 text-xs text-white" role="status">正在加载图片…</span>}
      {ratingSelectionMode && (
        <div className={`absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full border-2 text-xs shadow ${ratingSelected ? "border-yellow-400 bg-yellow-400 text-black" : "border-white bg-black/35 text-transparent"}`}>✓</div>
      )}
      {photo.is_favorite && (
        <div className="absolute top-1 right-1 text-red-400 text-sm drop-shadow" style={{ textShadow: "0 1px 2px rgba(0,0,0,0.5)" }} title="收藏">
          ♥
        </div>
      )}
      {photo.rating > 0 && (
        <div className="absolute bottom-5 left-1 rounded bg-black/55 px-1 text-xs text-yellow-300" title={`${photo.rating} 星`}>
          ★ {photo.rating}
        </div>
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5">
        <p className="text-white text-xs truncate">{photo.filename}</p>
      </div>

      {menuPos && (
        <ContextMenu
          x={menuPos.x}
          y={menuPos.y}
          items={[
            { label: "在文件管理器中显示", action: handleReveal },
            {
              label: photo.is_favorite ? "Remove from Favorites" : "Add to Favorites",
              action: handleToggleFavorite,
            },
            ...[5, 4, 3, 2, 1].map((rating) => ({ label: `${"★".repeat(rating)} 设为 ${rating} 星`, action: () => handleRating(rating) })),
            { label: "清除星级", action: () => handleRating(0) },
          ]}
          onClose={() => setMenuPos(null)}
        />
      )}
    </div>
  );
});
