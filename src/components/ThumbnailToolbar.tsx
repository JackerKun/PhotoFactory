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
import BatchMetadataDialog, { type BatchMetadataMode } from "./BatchMetadataDialog";
import WorkspaceOptions from "./WorkspaceOptions";

export default React.memo(function ThumbnailToolbar({ children, showTitle }: { children: React.ReactNode; showTitle: boolean }) {
  const [metadataBatch, setMetadataBatch] = useState<{ mode: BatchMetadataMode; photoIds: number[] } | null>(null);
  const [selectingAll, setSelectingAll] = useState(false);
  const [selectionError, setSelectionError] = useState("");
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
    selectAllRatingPhotos,
    updatePhotosInList,
  } = useStore();

  async function selectAll() {
    setSelectionError("");
    setSelectingAll(true);
    try {
      await selectAllRatingPhotos();
    } catch (error) {
      setSelectionError(String(error));
    } finally {
      setSelectingAll(false);
    }
  }

  const openMetadataBatch = (mode: BatchMetadataMode) => setMetadataBatch({ mode, photoIds: [...ratingSelection] });

  const applyRating = async (rating: number) => {
    if (ratingSelection.length === 0) return;
    setSelectionError("");
    try {
      await api.updatePhotosRating(ratingSelection, rating);
      updatePhotosInList(ratingSelection, { rating });
      clearRatingSelection();
    } catch (error) {
      setSelectionError(`设置评分失败：${String(error)}`);
    }
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

  const selectAllLabel = selectingAll ? "正在选择…" : totalPhotos <= 5000 ? "全选" : photos.length <= 5000 ? "全选已加载" : "选择前 5000 张";
  const selectAllButton = <button type="button" className="ui-button" onClick={() => void selectAll()}
    disabled={loading || selectingAll || !photos.length}>{selectAllLabel}</button>;
  const selected = ratingSelectionMode && ratingSelection.length > 0;

  return (
    <>
      <div className="photo-toolbar z-10 border-b border-surface-secondary">
        <div className="workspace-title photo-workspace-title">
          {showTitle && <h1>照片</h1>}
          <span aria-live="polite" className="workspace-count">
            {totalPhotos > 0
              ? `已加载 ${photos.length.toLocaleString()} / 共 ${totalPhotos.toLocaleString()} 张`
              : loading ? "正在加载照片…" : photoLoadError ? "照片读取失败" : "共 0 张"}
          </span>
        </div>
        <div className="ui-toolbar photo-toolbar-controls">
          <div className="ui-toolbar">
            <div className="ui-segments" role="group" aria-label="照片布局">
              <button type="button" onClick={() => setThumbnailShape("square")} className="ui-segment"
                aria-pressed={thumbnailShape === "square"} aria-label="方格" title="方格：填满格子">
                <svg width="14" height="14" viewBox="0 0 13 13" fill="currentColor" aria-hidden="true">
                  <rect x="1" y="1" width="5" height="5" rx="1" /><rect x="7" y="1" width="5" height="5" rx="1" />
                  <rect x="1" y="7" width="5" height="5" rx="1" /><rect x="7" y="7" width="5" height="5" rx="1" />
                </svg>
              </button>
              <button type="button" onClick={() => setThumbnailShape("proportional")} className="ui-segment"
                aria-pressed={thumbnailShape === "proportional"} aria-label="原比例" title="原比例：保留完整画面">
                <svg width="14" height="14" viewBox="0 0 15 13" fill="currentColor" aria-hidden="true">
                  <rect x="1" y="2" width="8" height="9" rx="1" /><rect x="10" y="1" width="4" height="5" rx="1" />
                  <rect x="10" y="7" width="4" height="5" rx="1" />
                </svg>
              </button>
            </div>
            <PhotoTimeline />
          </div>

          <PhotoSearch />

          <div className="ui-toolbar photo-toolbar-actions">
            <PhotoFilterPanel />
            <PhotoSortMenu />
            <button type="button" disabled={selectingAll} onClick={() => { setSelectionError(""); setRatingSelectionMode(!ratingSelectionMode); }} className="ui-button"
              aria-pressed={ratingSelectionMode} title="选择多张照片，可按住 Shift 连选">
              <Icon name="select" size={16} />{ratingSelectionMode ? "退出选择" : "选择"}
            </button>
            {ratingSelectionMode && !selected && selectAllButton}
            <WorkspaceOptions label="视图选项" icon="sliders" iconOnly>{(close) => (
              <>
                <label className="workspace-option workspace-zoom">
                  <span>缩略图尺寸</span>
                  <output>{thumbnailSize}px</output>
                  <input type="range" aria-label="缩略图尺寸" min={80} max={400} step={10} value={thumbnailSize}
                    onChange={(event) => setThumbnailSize(Number(event.target.value))} className="accent-accent-primary" />
                </label>
                <button type="button" className="workspace-option" onClick={() => { close(); setShowShortcuts(true); }}>
                  <Icon name="keyboard" size={16} />键盘快捷键
                </button>
                {!selected && <button type="button" onClick={() => { close(); openCoordinateManager(); }}
                  disabled={!photos.length} className="workspace-option">
                  <Icon name="location" size={16} />坐标批量管理
                </button>}
              </>
            )}</WorkspaceOptions>
          </div>
        </div>

        <ActiveFilters />
      </div>
      {children}
      {ratingSelectionMode && selectionError && <p role="alert" className="workspace-selection-error">{selectionError}</p>}
      {selected && (
        <div className="workspace-selection-dock">
          <div className="workspace-selection-bar" role="group" aria-label="照片选区操作">
            <strong role="status">已选 {ratingSelection.length.toLocaleString()} 张</strong>
            {selectAllButton}
            <WorkspaceOptions label="批量操作" icon="chevronDown" upward>{(close) => (
              <>
                <div className="workspace-option" role="group" aria-label="设置评分">
                  <span>评分</span>
                  <StarRating value={0} onChange={(rating) => { close(); void applyRating(rating); }} size="sm" disabled={selectingAll} />
                </div>
                <button type="button" className="workspace-option" disabled={selectingAll} onClick={() => { close(); openMetadataBatch("exif"); }}>
                  <Icon name="photos" size={16} />编辑 EXIF
                </button>
                <button type="button" className="workspace-option" disabled={selectingAll} onClick={() => { close(); openMetadataBatch("tags"); }}>
                  <Icon name="tags" size={16} />管理标签
                </button>
                <button type="button" className="workspace-option" disabled={selectingAll} onClick={() => { close(); openCoordinateManager(); }}>
                  <Icon name="location" size={16} />坐标批量管理
                </button>
              </>
            )}</WorkspaceOptions>
            <button type="button" disabled={selectingAll} onClick={clearRatingSelection} className="ui-button ui-icon-button" title="清除选择" aria-label="清除选择">
              <Icon name="close" size={16} />
            </button>
          </div>
        </div>
      )}
      {metadataBatch && <BatchMetadataDialog {...metadataBatch} onClose={() => setMetadataBatch(null)} />}
      <KeyboardShortcutsDialog open={showShortcuts} onClose={() => setShowShortcuts(false)} />
    </>
  );
});
