import React, { useState } from "react";
import { useStore } from "../hooks/usePhotos";
import PhotoTimeline from "./PhotoTimeline";
import PhotoSearch from "./PhotoSearch";
import PhotoFilterPanel from "./PhotoFilterPanel";
import PhotoSortMenu from "./PhotoSortMenu";
import ActiveFilters from "./ActiveFilters";
import StarRating from "./StarRating";
import * as api from "../api/tauri";
import KeyboardShortcutsDialog from "./KeyboardShortcutsDialog";

export default React.memo(function ThumbnailToolbar() {
  const [showShortcuts, setShowShortcuts] = useState(false);
  const {
    thumbnailShape,
    thumbnailSize,
    setThumbnailShape,
    setThumbnailSize,
    photos,
    totalPhotos,
    loading,
    photoLoadError,
    ratingSelectionMode,
    ratingSelection,
    setRatingSelectionMode,
    clearRatingSelection,
    updatePhotosInList,
  } = useStore();

  const applyRating = async (rating: number) => {
    if (ratingSelection.length === 0) return;
    await api.updatePhotosRating(ratingSelection, rating);
    updatePhotosInList(ratingSelection, { rating });
    clearRatingSelection();
  };

  return (
    <div className="z-10 border-b border-surface-secondary bg-bg-secondary/90 px-3 py-2 shadow-sm backdrop-blur-xl">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="flex shrink-0 items-center gap-2">
        <div className="flex items-center gap-1 rounded-xl bg-surface-primary/80 p-1" aria-label="照片布局">
          <button
            onClick={() => setThumbnailShape("square")}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
              thumbnailShape === "square"
                ? "bg-bg-secondary text-accent-link shadow-sm"
                : "text-text-muted hover:text-text-primary"
            }`}
            title="方格：像 iOS 相册一样铺满裁切"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor" aria-hidden="true">
              <rect x="1" y="1" width="5" height="5" rx="1" /><rect x="7" y="1" width="5" height="5" rx="1" />
              <rect x="1" y="7" width="5" height="5" rx="1" /><rect x="7" y="7" width="5" height="5" rx="1" />
            </svg>
            方格
          </button>
          <button
            onClick={() => setThumbnailShape("proportional")}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
              thumbnailShape === "proportional"
                ? "bg-bg-secondary text-accent-link shadow-sm"
                : "text-text-muted hover:text-text-primary"
            }`}
            title="原比例：保留完整画面并自动铺满每行"
          >
            <svg width="15" height="13" viewBox="0 0 15 13" fill="currentColor" aria-hidden="true">
              <rect x="1" y="2" width="8" height="9" rx="1" /><rect x="10" y="1" width="4" height="5" rx="1" />
              <rect x="10" y="7" width="4" height="5" rx="1" />
            </svg>
            原比例
          </button>
        </div>
        <PhotoTimeline />
        </div>

        <PhotoSearch />

        <PhotoFilterPanel />
        <PhotoSortMenu />
        <button type="button" onClick={() => setRatingSelectionMode(!ratingSelectionMode)} className={`shrink-0 rounded-lg px-2.5 py-2 text-xs ${ratingSelectionMode ? "bg-accent-primary text-white" : "bg-surface-primary/80 text-text-secondary hover:text-text-primary"}`} title="选择多张照片并批量设置星级">★ 批量</button>
        <button type="button" onClick={() => setShowShortcuts(true)} className="shrink-0 rounded-lg bg-surface-primary/80 px-2.5 py-2 text-xs text-text-secondary hover:text-text-primary" title="查看键盘快捷键" aria-label="查看键盘快捷键">⌨</button>

        <div className="flex shrink-0 items-center gap-2 min-w-[150px]">
          <span className="text-text-muted text-xs w-12 text-right">{thumbnailSize}px</span>
          <input type="range" min={80} max={400} step={10} value={thumbnailSize} onChange={(e) => setThumbnailSize(Number(e.target.value))} className="w-24 accent-color-accent-primary" />
        </div>
      </div>

      <div className="mt-1.5 flex min-h-5 items-center justify-center gap-3 text-xs text-text-muted" aria-live="polite">
        <span>{totalPhotos > 0 ? `已加载 ${photos.length.toLocaleString()} / 共 ${totalPhotos.toLocaleString()} 张` : loading ? "正在加载照片…" : photoLoadError ? "照片读取失败" : "共 0 张"}</span>
        {ratingSelectionMode && (
          <div className="flex items-center gap-2 rounded-full bg-surface-primary px-3 py-1">
            <span>已选 {ratingSelection.length} 张</span>
            <StarRating value={0} onChange={applyRating} size="sm" disabled={ratingSelection.length === 0} />
            <button type="button" onClick={clearRatingSelection} className="text-accent-link">清除选择</button>
          </div>
        )}
      </div>
      <ActiveFilters />
      <KeyboardShortcutsDialog open={showShortcuts} onClose={() => setShowShortcuts(false)} />
    </div>
  );
});
