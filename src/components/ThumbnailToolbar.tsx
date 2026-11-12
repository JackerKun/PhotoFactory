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
import Icon from "./Icon";

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

  function openCoordinateManager() {
    const { photos, ratingSelectionMode, ratingSelection, selectedPhotoId, openGpsBatchEditor } = useStore.getState();
    const checked = new Set(ratingSelectionMode ? ratingSelection : []);
    const selectedPhotoIds = photos.flatMap((photo) => photo.id != null && checked.has(photo.id) ? [photo.id] : []);
    const focusedId = photos.find((photo) => photo.id === selectedPhotoId)?.id;
    const photoId = focusedId != null && (selectedPhotoIds.length === 0 || checked.has(focusedId))
      ? focusedId
      : selectedPhotoIds[0] ?? photos[0]?.id;
    if (photoId != null) openGpsBatchEditor({ photoId, mode: "batch", selectedPhotoIds });
  }

  return (
    <div className="photo-toolbar z-10 border-b border-surface-secondary">
      <div className="ui-toolbar photo-toolbar-controls">
        <div className="ui-toolbar">
          <div className="ui-segments" role="group" aria-label="照片布局">
            <button type="button" onClick={() => setThumbnailShape("square")} className="ui-segment"
              aria-pressed={thumbnailShape === "square"} title="方格：像 iOS 相册一样铺满裁切">
              <svg width="14" height="14" viewBox="0 0 13 13" fill="currentColor" aria-hidden="true">
                <rect x="1" y="1" width="5" height="5" rx="1" /><rect x="7" y="1" width="5" height="5" rx="1" />
                <rect x="1" y="7" width="5" height="5" rx="1" /><rect x="7" y="7" width="5" height="5" rx="1" />
              </svg>
              方格
            </button>
            <button type="button" onClick={() => setThumbnailShape("proportional")} className="ui-segment"
              aria-pressed={thumbnailShape === "proportional"} title="原比例：保留完整画面并自动铺满每行">
              <svg width="14" height="14" viewBox="0 0 15 13" fill="currentColor" aria-hidden="true">
                <rect x="1" y="2" width="8" height="9" rx="1" /><rect x="10" y="1" width="4" height="5" rx="1" />
                <rect x="10" y="7" width="4" height="5" rx="1" />
              </svg>
              原比例
            </button>
          </div>
          <PhotoTimeline />
        </div>

        <PhotoSearch />

        <div className="ui-toolbar">
          <PhotoFilterPanel />
          <PhotoSortMenu />
          <button type="button" onClick={() => setRatingSelectionMode(!ratingSelectionMode)} className="ui-button"
            aria-pressed={ratingSelectionMode} title="选择多张照片并批量设置星级">★ 批量</button>
          <button type="button" onClick={openCoordinateManager} disabled={photos.length === 0}
            title="管理当前已加载照片的坐标，已勾选的照片会带入" className="ui-button">
            <Icon name="location" size={14} />坐标批量管理
          </button>
          <button type="button" onClick={() => setShowShortcuts(true)} className="ui-button ui-icon-button" title="查看键盘快捷键" aria-label="查看键盘快捷键">
            <Icon name="keyboard" size={16} />
          </button>
          <label className="ui-field">
            <span className="min-w-[3em] text-right text-xs tabular-nums text-text-secondary">{thumbnailSize}px</span>
            <input type="range" aria-label="缩略图尺寸" min={80} max={400} step={10} value={thumbnailSize}
              onChange={(event) => setThumbnailSize(Number(event.target.value))} className="w-20 accent-accent-primary" />
          </label>
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
