import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStore } from "../hooks/usePhotos";
import type { Photo } from "../types";
import PhotoCard from "./PhotoCard";
import { matchesTimeline, type TimelineJump } from "../utils/photoTimeline";

const GAP = 4;

interface Props {
  onSelectPhoto: (id: number) => void;
  onDoubleClickPhoto?: (id: number) => void;
  selectedPhotoId?: number | null;
  timelineJump: TimelineJump | null;
  onTimelineJumpComplete: (requestId: number) => void;
  onVisiblePhotoChange: (photo: Photo | null) => void;
}

interface JustifiedItem {
  photoIndex: number;
  width: number;
}

interface JustifiedRow {
  height: number;
  items: JustifiedItem[];
}

function displayAspectRatio(photo: Photo): number {
  let width = photo.width && photo.width > 0 ? photo.width : 4;
  let height = photo.height && photo.height > 0 ? photo.height : 3;
  if (photo.orientation >= 5 && photo.orientation <= 8) [width, height] = [height, width];
  return Math.min(8, Math.max(0.125, width / height));
}

/**
 * iOS Photos-style justified rows: every completed row fills the viewport,
 * while every image keeps its original aspect ratio. The final row remains at
 * the chosen target height instead of being stretched into oversized cards.
 */
export function buildJustifiedRows(photos: Photo[], containerWidth: number, targetHeight: number): JustifiedRow[] {
  if (photos.length === 0 || containerWidth <= 0) return [];
  const rows: JustifiedRow[] = [];
  let indexes: number[] = [];
  let aspectSum = 0;

  const finishRow = (isLast: boolean) => {
    if (indexes.length === 0) return;
    const gapWidth = GAP * Math.max(0, indexes.length - 1);
    const fittedHeight = (containerWidth - gapWidth) / aspectSum;
    const height = Math.max(56, isLast ? Math.min(targetHeight, fittedHeight) : fittedHeight);
    rows.push({
      height,
      items: indexes.map((photoIndex) => ({
        photoIndex,
        width: displayAspectRatio(photos[photoIndex]) * height,
      })),
    });
    indexes = [];
    aspectSum = 0;
  };

  photos.forEach((photo, photoIndex) => {
    indexes.push(photoIndex);
    aspectSum += displayAspectRatio(photo);
    const projectedWidth = aspectSum * targetHeight + GAP * Math.max(0, indexes.length - 1);
    if (projectedWidth >= containerWidth) finishRow(false);
  });
  finishRow(true);
  return rows;
}

export default React.memo(function ProportionalVirtualGrid({
  onSelectPhoto,
  onDoubleClickPhoto,
  selectedPhotoId,
  timelineJump,
  onTimelineJumpComplete,
  onVisiblePhotoChange,
}: Props) {
  const {
    photos, loadMore,
    thumbnailSize, queuePreload, hasNext, loading, filter,
    ratingSelectionMode, ratingSelection, toggleRatingSelection,
  } = useStore();

  const hasNextRef = useRef(hasNext);
  const loadingRef = useRef(loading);
  const photosRef = useRef(photos);
  useEffect(() => { hasNextRef.current = hasNext; }, [hasNext]);
  useEffect(() => { loadingRef.current = loading; }, [loading]);
  useEffect(() => { photosRef.current = photos; }, [photos]);

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef(useStore.getState().photoGridScrollOffsets.proportional);
  const restoredScroll = useRef(false);
  const previousFilterKey = useRef(JSON.stringify(filter));
  const jumpAttemptRef = useRef<{ requestId: number; photoCount: number } | null>(null);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const contentWidth = Math.max(1, width - 16);
  const targetHeight = Math.min(320, Math.max(90, thumbnailSize));
  const rows = useMemo(
    () => buildJustifiedRows(photos, contentWidth, targetHeight),
    [photos, contentWidth, targetHeight],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.height ?? targetHeight) + GAP,
    overscan: 4,
  });

  useEffect(() => { virtualizer.measure(); }, [rows, virtualizer]);

  useEffect(() => {
    const currentFilterKey = JSON.stringify(filter);
    if (previousFilterKey.current !== currentFilterKey) {
      previousFilterKey.current = currentFilterKey;
      lastScrollTop.current = 0;
      restoredScroll.current = true;
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }
  }, [filter]);

  useEffect(() => {
    if (restoredScroll.current || !scrollRef.current) return;
    restoredScroll.current = true;
    const offset = lastScrollTop.current;
    scrollRef.current.scrollTop = offset;
    virtualizer.scrollToOffset(offset, { align: "start" });
  }, [virtualizer]);

  const reportVisiblePhoto = useCallback(() => {
    const firstRow = virtualizer.getVirtualItems()[0];
    const photoIndex = firstRow ? rows[firstRow.index]?.items[0]?.photoIndex : 0;
    onVisiblePhotoChange(photos[photoIndex ?? 0] ?? null);
  }, [onVisiblePhotoChange, photos, rows, virtualizer]);

  useEffect(() => {
    reportVisiblePhoto();
  }, [photos, rows, reportVisiblePhoto]);

  useEffect(() => {
    if (!timelineJump) return;
    const photoIndex = photos.findIndex((photo) => matchesTimeline(photo, timelineJump));
    if (photoIndex >= 0) {
      const rowIndex = rows.findIndex((row) => row.items.some((item) => item.photoIndex === photoIndex));
      if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex, { align: "start", behavior: "smooth" });
      onVisiblePhotoChange(photos[photoIndex]);
      onTimelineJumpComplete(timelineJump.requestId);
      return;
    }
    if (hasNext && !loading) {
      const attempted = jumpAttemptRef.current;
      if (!attempted || attempted.requestId !== timelineJump.requestId || attempted.photoCount !== photos.length) {
        jumpAttemptRef.current = { requestId: timelineJump.requestId, photoCount: photos.length };
        void loadMore();
        return;
      }
    }
    if (!loading) onTimelineJumpComplete(timelineJump.requestId);
  }, [hasNext, loadMore, loading, onTimelineJumpComplete, onVisiblePhotoChange, photos, rows, timelineJump, virtualizer]);

  useEffect(() => () => {
    useStore.getState().setPhotoGridScrollOffset("proportional", lastScrollTop.current);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const scrollingDown = el.scrollTop > lastScrollTop.current;
    lastScrollTop.current = el.scrollTop;
    reportVisiblePhoto();
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining < 800 && hasNextRef.current && !loadingRef.current && scrollingDown) {
      const currentPhotos = photosRef.current;
      const startIdx = Math.min(currentPhotos.length - 1, Math.floor(currentPhotos.length * 0.7));
      const upcoming = currentPhotos.slice(startIdx, startIdx + 40).map((photo) => photo.id!).filter(Boolean);
      if (upcoming.length > 0) queuePreload(upcoming);
      loadMore();
    }
  }, [loadMore, queuePreload, reportVisiblePhoto]);

  if (photos.length === 0 && loading) {
    return (
      <div ref={containerRef} className="min-h-0 flex-1 flex flex-col">
        <div className="flex-1 grid grid-cols-5 auto-rows-[160px] gap-1 p-2 overflow-hidden">
          {Array.from({ length: 15 }).map((_, index) => (
            <div key={index} className="bg-surface-primary rounded-sm animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!loading && photos.length === 0) {
    return <div ref={containerRef} className="min-h-0 flex-1" />;
  }

  return (
    <div ref={containerRef} className="min-h-0 flex-1 flex flex-col">
      <div ref={scrollRef} className="flex-1 overflow-auto p-2" onScroll={handleScroll}>
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            return (
              <div
                key={virtualRow.key}
                className="absolute left-0 flex"
                style={{
                  top: 0,
                  transform: `translateY(${virtualRow.start}px)`,
                  gap: `${GAP}px`,
                  height: `${row.height}px`,
                }}
              >
                {row.items.map(({ photoIndex, width: itemWidth }) => {
                  const photo = photos[photoIndex];
                  if (!photo) return null;
                  return (
                    <div key={photo.id} style={{ width: `${itemWidth}px`, height: `${row.height}px`, flex: "none" }}>
                      <PhotoCard
                        photo={photo}
                        onClick={() => onSelectPhoto(photo.id!)}
                        onDoubleClick={() => onDoubleClickPhoto?.(photo.id!)}
                        size={itemWidth}
                        height={row.height}
                        shape="proportional"
                        isSelected={photo.id === selectedPhotoId}
                        ratingSelectionMode={ratingSelectionMode}
                        ratingSelected={ratingSelection.includes(photo.id!)}
                        onToggleRatingSelection={() => toggleRatingSelection(photo.id!)}
                      />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {loading && photos.length > 0 && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-bg-secondary/95 px-3 py-1 text-xs text-text-muted shadow">
          正在加载更多…
        </div>
      )}
    </div>
  );
});
