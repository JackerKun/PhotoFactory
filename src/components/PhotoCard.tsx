import React, { useEffect, useState, useCallback, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Photo } from "../types";
import * as api from "../api/tauri";
import ContextMenu from "./ContextMenu";

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

  useEffect(() => {
    if (!photo.id) return;
    const node = ref.current;
    if (!node) return;
    cancelledRef.current = false;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && thumbStateRef.current === "placeholder") {
            observer.unobserve(entry.target);
            setThumbState("loading");
            api.getThumbnailPath(photo.id!, "small").then((path) => {
              if (!cancelledRef.current) {
                setSmallUrl(convertFileSrc(path));
                setThumbState("loaded");
              }
            }).catch(() => {
              // No base64 fallback — if thumbnail doesn't exist, the batch
              // processor will generate it. Stop retrying until this card remounts.
              if (!cancelledRef.current) setThumbState("error");
            });
            return;
          }
        }
      },
      { rootMargin: "200px" },
    );

    observer.observe(node);
    return () => { observer.disconnect(); };
  }, [photo.id, photo.path]);

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
          onError={() => {
            // Thumbnail file not found (e.g. cache deleted) — clear URL, show placeholder
            setSmallUrl(null);
            setMediumUrl(null);
            setThumbState("error");
          }}
        />
      ) : thumbState === "error" ? (
        <div className="w-full h-full flex items-center justify-center text-text-muted/60 text-2xl" aria-label="Thumbnail unavailable">
          ◇
        </div>
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent-primary/25 border-t-accent-primary" />
        </div>
      )}
      {ratingSelectionMode && (
        <div className={`absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full border-2 text-xs shadow ${ratingSelected ? "border-yellow-400 bg-yellow-400 text-black" : "border-white bg-black/35 text-transparent"}`}>✓</div>
      )}
      {photo.is_favorite && (
        <div className="absolute top-1 right-1 text-red-400 text-sm drop-shadow" style={{ textShadow: "0 1px 2px rgba(0,0,0,0.5)" }} title="收藏">
          ♥
        </div>
      )}
      {photo.rating > 0 && (
        <div className="absolute bottom-5 left-1 rounded bg-black/55 px-1 text-[10px] text-yellow-300" title={`${photo.rating} 星`}>
          ★ {photo.rating}
        </div>
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5">
        <p className="text-white text-[10px] truncate">{photo.filename}</p>
      </div>

      {menuPos && (
        <ContextMenu
          x={menuPos.x}
          y={menuPos.y}
          items={[
            { label: "Open in File Manager", action: handleReveal },
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
