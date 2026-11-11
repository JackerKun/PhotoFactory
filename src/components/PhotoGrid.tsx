import React, { useEffect, useRef, useCallback, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useStore } from "../hooks/usePhotos";
import { useVirtualGrid, calculateColumnCount } from "../hooks/useVirtualGrid";
import PhotoCard from "./PhotoCard";
import ThumbnailToolbar from "./ThumbnailToolbar";
import ProportionalVirtualGrid from "./ProportionalVirtualGrid";
import * as api from "../api/tauri";
import PhotoTimelineRail from "./PhotoTimelineRail";
import type { Photo } from "../types";
import { matchesTimeline, photoTimelinePosition, type TimelineJump, type TimelinePosition } from "../utils/photoTimeline";

const GAP = 8;

interface Props { onSelectPhoto: (id: number) => void; onDoubleClickPhoto?: (id: number) => void; selectedPhotoId?: number | null }

interface GridSurfaceProps extends Props {
  timelineJump: TimelineJump | null;
  onTimelineJumpComplete: (requestId: number) => void;
  onVisiblePhotoChange: (photo: Photo | null) => void;
}

function SquareVirtualGrid({ onSelectPhoto, onDoubleClickPhoto, selectedPhotoId, timelineJump, onTimelineJumpComplete, onVisiblePhotoChange }: GridSurfaceProps) {
  const { photos, hasNext, loading, loadMore, thumbnailSize, filter, ratingSelectionMode, ratingSelection, toggleRatingSelection } = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const lastScrollTop = useRef(useStore.getState().photoGridScrollOffsets.square);
  const restoredScroll = useRef(false);
  const previousFilterKey = useRef(JSON.stringify(filter));
  const jumpAttemptRef = useRef<{ requestId: number; photoCount: number } | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const contentWidth = Math.max(1, width - 16);
  const columnCount = calculateColumnCount(contentWidth, thumbnailSize, GAP);
  const cellSize = (contentWidth - GAP * (columnCount - 1)) / columnCount;
  const { parentRef, virtualizer, getItemsForRow } = useVirtualGrid({
    itemCount: photos.length,
    columnCount,
    cellHeight: cellSize,
    gap: GAP,
    overscan: 3,
  });

  useEffect(() => {
    const currentFilterKey = JSON.stringify(filter);
    if (previousFilterKey.current !== currentFilterKey) {
      previousFilterKey.current = currentFilterKey;
      lastScrollTop.current = 0;
      restoredScroll.current = true;
      if (parentRef.current) parentRef.current.scrollTop = 0;
    }
  }, [filter, parentRef]);

  useEffect(() => {
    if (restoredScroll.current || !parentRef.current) return;
    restoredScroll.current = true;
    const offset = lastScrollTop.current;
    parentRef.current.scrollTop = offset;
    virtualizer.scrollToOffset(offset, { align: "start" });
  }, [parentRef, virtualizer]);

  const reportVisiblePhoto = useCallback((scrollTop: number) => {
    const row = Math.max(0, Math.floor(scrollTop / Math.max(1, cellSize + GAP)));
    onVisiblePhotoChange(photos[Math.min(photos.length - 1, row * columnCount)] ?? null);
  }, [cellSize, columnCount, onVisiblePhotoChange, photos]);

  useEffect(() => {
    reportVisiblePhoto(parentRef.current?.scrollTop ?? lastScrollTop.current);
  }, [photos, columnCount, cellSize, parentRef, reportVisiblePhoto]);

  useEffect(() => {
    if (!timelineJump) return;
    const index = photos.findIndex((photo) => matchesTimeline(photo, timelineJump));
    if (index >= 0) {
      const row = Math.floor(index / columnCount);
      virtualizer.scrollToIndex(row, { align: "start", behavior: "smooth" });
      onVisiblePhotoChange(photos[index]);
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
  }, [columnCount, hasNext, loadMore, loading, onTimelineJumpComplete, onVisiblePhotoChange, photos, timelineJump, virtualizer]);

  useEffect(() => () => {
    useStore.getState().setPhotoGridScrollOffset("square", lastScrollTop.current);
  }, []);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    lastScrollTop.current = element.scrollTop;
    reportVisiblePhoto(element.scrollTop);
    if (element.scrollTop + element.clientHeight >= element.scrollHeight - 700 && hasNext && !loading) {
      loadMore();
    }
  }, [hasNext, loading, loadMore, reportVisiblePhoto]);

  return (
    <div ref={containerRef} className="min-h-0 flex-1">
      <div ref={parentRef} className="h-full overflow-auto p-2" onScroll={handleScroll}>
        <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => (
            <div
              key={virtualRow.key}
              className="absolute left-0 right-0 flex gap-2"
              style={{ top: 0, transform: `translateY(${virtualRow.start}px)` }}
            >
              {getItemsForRow(virtualRow.index).map((index) => {
                const photo = photos[index];
                if (!photo) return null;
                return (
                  <div key={photo.id} style={{ width: cellSize, height: cellSize, flex: "none" }}>
                    <PhotoCard
                      photo={photo}
                      onClick={() => onSelectPhoto(photo.id!)}
                      onDoubleClick={() => onDoubleClickPhoto?.(photo.id!)}
                      size={cellSize}
                      shape="square"
                      isSelected={photo.id === selectedPhotoId}
                      ratingSelectionMode={ratingSelectionMode}
                      ratingSelected={ratingSelection.includes(photo.id!)}
                      onToggleRatingSelection={() => toggleRatingSelection(photo.id!)}
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {loading && photos.length > 0 && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-bg-secondary/95 px-3 py-1 text-xs text-text-muted shadow">
          正在加载更多…
        </div>
      )}
    </div>
  );
}

/** Header shown when viewing photos filtered by a specific tag, with back button and photo count. */
function TagHeader({ label, onBack, onClear }: { label: string; onBack: () => void; onClear: () => void }) {
  const [photoCount, setPhotoCount] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    api.getLabelPhotoCount(label)
      .then((count) => {
        if (!cancelled) setPhotoCount(count);
      })
      .catch(() => {
        if (!cancelled) setPhotoCount(0);
      });
    return () => { cancelled = true; };
  }, [label]);

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-secondary bg-bg-secondary">
      <button
        onClick={onBack}
        className="text-text-muted hover:text-text-primary p-1 rounded transition-colors"
        title="返回标签"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 4L6 10L12 16" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <h2 className="text-lg font-bold">{label}</h2>
      {photoCount > 0 && (
        <span className="text-sm text-text-muted">{photoCount} 张照片</span>
      )}
      <button
        type="button"
        onClick={onClear}
        className="ml-auto rounded-lg border border-surface-secondary px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-primary hover:text-text-primary"
      >
        显示全部照片
      </button>
    </div>
  );
}

/** Header shown when viewing a specific person's photos, with back button and photo count. */
function PersonHeader({ personId, onBack, onClear }: { personId: number; onBack: () => void; onClear: () => void }) {
  const [personName, setPersonName] = useState<string | null>(null);
  const [photoCount, setPhotoCount] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    api.getClusters()
      .then((clusters) => {
        if (cancelled) return;
        const cluster = clusters.find((c) => c.id === personId);
        if (cluster?.name) {
          setPersonName(cluster.name);
          setPhotoCount(cluster.photo_count);
          return;
        }
        api.getPersonDetail(personId)
          .then((detail) => {
            if (!cancelled) {
              setPersonName(detail.user_name || `Person #${personId}`);
              setPhotoCount(detail.face_count);
            }
          })
          .catch(() => {
            if (!cancelled) setPersonName(`Person #${personId}`);
          });
      })
      .catch(() => {
        if (!cancelled) setPersonName(`Person #${personId}`);
      });
    return () => { cancelled = true; };
  }, [personId]);

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-secondary bg-bg-secondary">
      <button
        onClick={onBack}
        className="text-text-muted hover:text-text-primary p-1 rounded transition-colors"
        title="返回人物"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 4L6 10L12 16" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <h2 className="text-lg font-bold">{personName || "正在加载…"}</h2>
      {photoCount > 0 && (
        <span className="text-sm text-text-muted">{photoCount} 张照片</span>
      )}
      <button
        type="button"
        onClick={onClear}
        className="ml-auto rounded-lg border border-surface-secondary px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-primary hover:text-text-primary"
      >
        显示全部照片
      </button>
    </div>
  );
}

export default function PhotoGrid({ onSelectPhoto, onDoubleClickPhoto, selectedPhotoId }: Props) {
  const { photos, loading, filter, thumbnailShape, photoLoadError, loadPhotos, loadMore } = useStore();
  const hasFilters = Object.entries(filter).some(([key, value]) => !key.startsWith("sort_") && value != null && value !== "");
  const clearPhotoFilters = useStore((state) => state.clearPhotoFilters);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [activeTimelinePosition, setActiveTimelinePosition] = useState<TimelinePosition | null>(null);
  const [timelineJump, setTimelineJump] = useState<TimelineJump | null>(null);

  // Use URL params directly for headers - more reliable than store filter
  const urlPersonId = searchParams.get("person") ? Number(searchParams.get("person")) : null;
  const displayPersonId = urlPersonId ?? filter.person_id ?? null;
  const urlTag = searchParams.get("tag") ?? filter.tag ?? null;
  const showPersonHeader = displayPersonId != null;
  const showTagHeader = urlTag != null;

  // Back handler for person header - navigates to faces with the original tab
  const savedTab = searchParams.get("tab");
  const handleBack = useCallback(() => {
    if (urlTag) {
      navigate("/tags");
    } else if (savedTab) {
      navigate(`/faces?tab=${savedTab}`);
    } else {
      navigate("/faces");
    }
  }, [urlTag, savedTab, navigate]);

  const handleClearFilters = useCallback(() => {
    clearPhotoFilters();
    navigate("/");
  }, [clearPhotoFilters, navigate]);

  const handleVisiblePhotoChange = useCallback((photo: Photo | null) => {
    const next = photoTimelinePosition(photo);
    setActiveTimelinePosition((current) => (
      current?.year === next?.year && current?.month === next?.month ? current : next
    ));
  }, []);

  const handleTimelineJump = useCallback((position: TimelinePosition) => {
    setTimelineJump({ ...position, requestId: Date.now() });
  }, []);

  const handleTimelineJumpComplete = useCallback((requestId: number) => {
    setTimelineJump((current) => current?.requestId === requestId ? null : current);
  }, []);

  useEffect(() => {
    setTimelineJump(null);
  }, [filter]);

  const surfaceProps: GridSurfaceProps = {
    onSelectPhoto,
    onDoubleClickPhoto,
    selectedPhotoId,
    timelineJump,
    onTimelineJumpComplete: handleTimelineJumpComplete,
    onVisiblePhotoChange: handleVisiblePhotoChange,
  };

  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden">
      {showPersonHeader && <PersonHeader personId={displayPersonId!} onBack={handleBack} onClear={handleClearFilters} />}
      {showTagHeader && <TagHeader label={urlTag!} onBack={handleBack} onClear={handleClearFilters} />}
      <ThumbnailToolbar />
      <div className="flex min-h-0 flex-1">
        {thumbnailShape === "proportional" ? (
          <ProportionalVirtualGrid key="proportional" {...surfaceProps} />
        ) : (
          <SquareVirtualGrid key="square" {...surfaceProps} />
        )}
        <PhotoTimelineRail active={activeTimelinePosition} onJump={handleTimelineJump} />
      </div>
      {loading && photos.length === 0 && (
        <div role="status" className="pointer-events-none absolute inset-x-0 top-1/2 text-center text-sm text-text-secondary">正在读取照片库…</div>
      )}
      {photoLoadError && (
        <div role="alert" className="absolute inset-x-0 bottom-4 z-10 mx-auto w-fit max-w-[90%] rounded-xl border border-surface-secondary bg-bg-secondary p-3 text-sm shadow-lg">
          <span>读取照片失败。{photoLoadError.message}</span>
          <button type="button" className="ui-button ml-2" onClick={() => void (photoLoadError.page === "next" ? loadMore() : loadPhotos())}>重试</button>
        </div>
      )}
      {!loading && !photoLoadError && photos.length === 0 && (
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-8 text-center text-sm text-text-secondary">
          <p>{hasFilters ? "没有符合当前条件的照片" : "照片库暂无照片，请导入照片文件夹。"}</p>
          {hasFilters && <button type="button" className="ui-button mt-3" onClick={handleClearFilters}>清除筛选</button>}
        </div>
      )}
    </div>
  );
}
