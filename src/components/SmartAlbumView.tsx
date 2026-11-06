import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Photo, PhotoCursor, PhotoTimelineBucket, SmartAlbum } from "../types";
import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import PhotoCard from "./PhotoCard";
import PhotoTimelineRail from "./PhotoTimelineRail";
import { buildJustifiedRows } from "./ProportionalVirtualGrid";
import { calculateColumnCount } from "../hooks/useVirtualGrid";
import { matchesTimeline, photoTimelinePosition, type TimelinePosition } from "../utils/photoTimeline";

interface Props { onSelectPhoto: (id: number) => void; }
const GAP = 4;
const thumbCache = new Map<number, string>();
const typeLabels: Record<SmartAlbum["album_type"], string> = {
  travel: "旅行", monthly: "月度精选", themed: "主题", person: "人物", manual: "手工相册",
};

const Thumb = React.memo(function Thumb({ photoId }: { photoId: number }) {
  const [url, setUrl] = useState<string | null>(() => thumbCache.get(photoId) ?? null);
  useEffect(() => {
    if (thumbCache.has(photoId)) return;
    let cancelled = false;
    api.getThumbnailPath(photoId, "small").then((path) => {
      if (!cancelled) { const next = convertFileSrc(path); thumbCache.set(photoId, next); setUrl(next); }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [photoId]);
  return url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <div className="h-full w-full animate-pulse bg-bg-tertiary" />;
});

function timelineBuckets(photos: Photo[]): PhotoTimelineBucket[] {
  const counts = new Map<string, PhotoTimelineBucket>();
  photos.forEach((photo) => {
    const position = photoTimelinePosition(photo);
    if (!position?.month) return;
    const key = `${position.year}-${position.month}`;
    const current = counts.get(key) ?? { year: position.year, month: position.month, count: 0 };
    current.count += 1; counts.set(key, current);
  });
  return Array.from(counts.values());
}

interface GridProps {
  photos: Photo[]; shape: "square" | "proportional"; size: number;
  selectedId: number | null; selectionMode: boolean; selection: Set<number>;
  jump: TimelinePosition | null; onVisible: (photo: Photo | null) => void;
  onPhoto: (photo: Photo) => void; onDouble: (photo: Photo) => void;
}

function AlbumPhotoGrid({ photos, shape, size, selectedId, selectionMode, selection, jump, onVisible, onPhoto, onDouble }: GridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(containerRef.current); return () => observer.disconnect();
  }, []);
  const contentWidth = Math.max(1, width - 16);
  const columnCount = calculateColumnCount(contentWidth, size, GAP);
  const cellSize = (contentWidth - GAP * (columnCount - 1)) / columnCount;
  const justifiedRows = useMemo(() => buildJustifiedRows(photos, contentWidth, Math.min(320, Math.max(90, size))), [contentWidth, photos, size]);
  const virtualizer = useVirtualizer({
    count: shape === "square" ? Math.ceil(photos.length / columnCount) : justifiedRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => shape === "square" ? cellSize + GAP : (justifiedRows[index]?.height ?? size) + GAP,
    overscan: 4,
  });
  useEffect(() => { virtualizer.measure(); }, [cellSize, justifiedRows, shape, virtualizer]);
  const reportVisible = useCallback(() => {
    const row = virtualizer.getVirtualItems()[0]?.index ?? 0;
    const index = shape === "square" ? row * columnCount : (justifiedRows[row]?.items[0]?.photoIndex ?? 0);
    onVisible(photos[index] ?? null);
  }, [columnCount, justifiedRows, onVisible, photos, shape, virtualizer]);
  useEffect(() => { reportVisible(); }, [photos, reportVisible]);
  useEffect(() => {
    if (!jump) return;
    const index = photos.findIndex((photo) => matchesTimeline(photo, jump));
    if (index < 0) return;
    const row = shape === "square" ? Math.floor(index / columnCount) : justifiedRows.findIndex((item) => item.items.some((entry) => entry.photoIndex === index));
    if (row >= 0) virtualizer.scrollToIndex(row, { align: "start", behavior: "smooth" });
    onVisible(photos[index]);
  }, [columnCount, justifiedRows, jump, onVisible, photos, shape, virtualizer]);
  if (photos.length === 0) return <div ref={containerRef} className="flex min-h-0 flex-1 items-center justify-center text-sm text-text-muted">暂无符合条件的照片</div>;
  return <div ref={containerRef} className="min-h-0 flex-1"><div ref={scrollRef} className="h-full overflow-auto p-2" onScroll={reportVisible}>
    <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>{virtualizer.getVirtualItems().map((virtualRow) => {
      const entries = shape === "square"
        ? Array.from({ length: columnCount }, (_, offset) => ({ photoIndex: virtualRow.index * columnCount + offset, width: cellSize })).filter((item) => item.photoIndex < photos.length)
        : (justifiedRows[virtualRow.index]?.items ?? []);
      const height = shape === "square" ? cellSize : (justifiedRows[virtualRow.index]?.height ?? size);
      return <div key={virtualRow.key} className="absolute left-0 flex" style={{ transform: `translateY(${virtualRow.start}px)`, gap: GAP, height }}>{entries.map(({ photoIndex, width: cardWidth }) => {
        const photo = photos[photoIndex]; return <div key={photo.id} className="relative shrink-0" style={{ width: cardWidth, height }}><PhotoCard photo={photo} size={cardWidth} height={height} shape={shape} isSelected={photo.id === selectedId} ratingSelectionMode={selectionMode} ratingSelected={selection.has(photo.id!)} onToggleRatingSelection={() => onPhoto(photo)} onClick={() => onPhoto(photo)} onDoubleClick={() => onDouble(photo)} /></div>;
      })}</div>;
    })}</div>
  </div></div>;
}

function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/35 p-5" onMouseDown={onClose}><div className="max-h-[85vh] w-full max-w-4xl overflow-hidden rounded-2xl bg-bg-secondary shadow-2xl" onMouseDown={(e) => e.stopPropagation()}><div className="flex h-14 items-center justify-between border-b border-surface-secondary px-5"><h3 className="font-semibold">{title}</h3><button onClick={onClose} className="rounded p-2 text-text-muted hover:bg-surface-primary">✕</button></div>{children}</div></div>;
}

export default React.memo(function SmartAlbumView({ onSelectPhoto }: Props) {
  const [albums, setAlbums] = useState<SmartAlbum[]>([]);
  const [selectedAlbum, setSelectedAlbum] = useState<SmartAlbum | null>(null);
  const [albumPhotos, setAlbumPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [albumQuery, setAlbumQuery] = useState("");
  const [albumType, setAlbumType] = useState<"all" | SmartAlbum["album_type"]>("all");
  const [albumSort, setAlbumSort] = useState<"updated" | "name" | "count">("updated");
  const [detailQuery, setDetailQuery] = useState("");
  const [detailSort, setDetailSort] = useState<"date-desc" | "date-asc" | "name">("date-desc");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [visiblePhoto, setVisiblePhoto] = useState<Photo | null>(null);
  const [timelineJump, setTimelineJump] = useState<TimelinePosition | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPhotos, setPickerPhotos] = useState<Photo[]>([]);
  const [pickerSelection, setPickerSelection] = useState<Set<number>>(new Set());
  const [pickerCursor, setPickerCursor] = useState<PhotoCursor | null>(null);
  const [pickerHasMore, setPickerHasMore] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const pickerScrollRef = useRef<HTMLDivElement>(null);
  const pickerLoadingRef = useRef(false);
  const pickerRequestRef = useRef(0);
  const [albumCardSize, setAlbumCardSize] = useState(() => Number(localStorage.getItem("photofactory.smartAlbumCardSize")) || 220);
  const { thumbnailShape, thumbnailSize, setThumbnailShape, setSelectedPhotoId, setLightboxPhotoId, selectedPhotoId } = useStore();

  const refreshAlbums = useCallback(async () => {
    const next = await api.getSmartAlbums() as SmartAlbum[]; setAlbums(next);
    setSelectedAlbum((current) => current ? next.find((album) => album.id === current.id) ?? null : null);
  }, []);
  useEffect(() => { void refreshAlbums(); }, [refreshAlbums]);
  useEffect(() => { localStorage.setItem("photofactory.smartAlbumCardSize", String(albumCardSize)); }, [albumCardSize]);
  const loadAlbumPhotos = useCallback(async (album: SmartAlbum) => {
    setLoading(true); setAlbumPhotos([]);
    try { let cursor: number | undefined; const all: Photo[] = [];
      while (true) { const tuples = await api.getSmartAlbumPhotos(album.id, cursor, 200) as [number, number][]; if (!tuples.length) break;
        const photos = (await Promise.all(tuples.map(([id]) => api.getPhoto(id).catch(() => null)))).filter(Boolean) as Photo[];
        all.push(...photos); setAlbumPhotos([...all]); cursor = tuples[tuples.length - 1]?.[1]; if (tuples.length < 200) break; }
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { if (selectedAlbum) void loadAlbumPhotos(selectedAlbum); }, [loadAlbumPhotos, selectedAlbum?.id]);

  const visibleAlbums = useMemo(() => { const query = albumQuery.trim().toLocaleLowerCase(); return albums.filter((a) => albumType === "all" || a.album_type === albumType).filter((a) => !query || a.name.toLocaleLowerCase().includes(query)).sort((a, b) => albumSort === "name" ? a.name.localeCompare(b.name, "zh-CN") : albumSort === "count" ? b.photo_count - a.photo_count : b.updated_at.localeCompare(a.updated_at)); }, [albumQuery, albumSort, albumType, albums]);
  const detailPhotos = useMemo(() => { const query = detailQuery.trim().toLocaleLowerCase(); return albumPhotos.filter((p) => !query || [p.filename, p.camera_make, p.camera_model].some((v) => v?.toLocaleLowerCase().includes(query))).sort((a, b) => detailSort === "name" ? a.filename.localeCompare(b.filename, "zh-CN") : (detailSort === "date-asc" ? 1 : -1) * ((a.taken_at ?? a.file_mtime) - (b.taken_at ?? b.file_mtime))); }, [albumPhotos, detailQuery, detailSort]);
  const buckets = useMemo(() => timelineBuckets(detailPhotos), [detailPhotos]);
  const rename = useCallback(async (album: SmartAlbum) => { const name = prompt("相册名称", album.name)?.trim(); if (!name || name === album.name) return; await api.renameAlbum(album.id, name); await refreshAlbums(); }, [refreshAlbums]);
  const removeAlbum = useCallback(async (album: SmartAlbum) => { if (!confirm(`确定删除“${album.name}”吗？照片文件不会被删除。`)) return; await api.deleteAlbum(album.id); if (selectedAlbum?.id === album.id) setSelectedAlbum(null); await refreshAlbums(); }, [refreshAlbums, selectedAlbum?.id]);
  const loadPicker = useCallback(async (reset: boolean) => {
    if (pickerLoadingRef.current && !reset) return;
    const requestId = reset ? ++pickerRequestRef.current : pickerRequestRef.current;
    pickerLoadingRef.current = true;
    setPickerLoading(true);
    try {
      const page = await api.getPhotos(reset ? null : pickerCursor, 200, { keyword: pickerQuery || undefined, sort_by: "capture_date", sort_direction: "desc" });
      if (requestId !== pickerRequestRef.current) return;
      setPickerPhotos((current) => reset ? page.photos : [...current, ...page.photos.filter((photo) => !current.some((item) => item.id === photo.id))]);
      setPickerCursor(page.next_cursor);
      setPickerHasMore(page.has_more);
      if (reset && pickerScrollRef.current) pickerScrollRef.current.scrollTop = 0;
    } finally {
      if (requestId === pickerRequestRef.current) {
        pickerLoadingRef.current = false;
        setPickerLoading(false);
      }
    }
  }, [pickerCursor, pickerQuery]);
  useEffect(() => { if (!pickerOpen) return; const timer = setTimeout(() => void loadPicker(true), 250); return () => clearTimeout(timer); }, [pickerOpen, pickerQuery]);
  const toggleSelection = (photo: Photo) => setSelection((current) => { const next = new Set(current); next.has(photo.id!) ? next.delete(photo.id!) : next.add(photo.id!); return next; });
  const handlePhoto = (photo: Photo) => { if (selectionMode) return toggleSelection(photo); onSelectPhoto(photo.id!); setSelectedPhotoId(photo.id!); };

  if (selectedAlbum) return <div className="flex h-full flex-col">
    <div className="flex min-h-14 items-center gap-3 border-b border-surface-secondary bg-bg-secondary px-4"><button onClick={() => { setSelectedAlbum(null); setSelectionMode(false); setSelection(new Set()); }} className="text-sm text-text-muted hover:text-text-primary">← 返回</button><h2 className="truncate text-xl font-bold">{selectedAlbum.name}</h2><span className="text-sm text-text-muted">{albumPhotos.length}/{selectedAlbum.photo_count} 张</span><span className="rounded-full bg-accent-primary/10 px-2 py-0.5 text-xs text-accent-primary">{typeLabels[selectedAlbum.album_type]}</span><div className="ml-auto flex gap-1"><button onClick={() => void rename(selectedAlbum)} className="rounded-lg px-2 py-1 text-sm hover:bg-surface-primary">改名</button><button onClick={() => void removeAlbum(selectedAlbum)} className="rounded-lg px-2 py-1 text-sm text-red-500 hover:bg-red-50">删除</button></div></div>
    <div className="flex min-h-14 flex-wrap items-center gap-2 border-b border-surface-secondary bg-bg-secondary px-3 py-2"><div className="flex h-9 rounded-xl bg-surface-primary p-1"><button onClick={() => setThumbnailShape("square")} className={`rounded-lg px-3 text-sm ${thumbnailShape === "square" ? "bg-bg-secondary text-accent-primary shadow-sm" : "text-text-muted"}`}>▦ 方格</button><button onClick={() => setThumbnailShape("proportional")} className={`rounded-lg px-3 text-sm ${thumbnailShape === "proportional" ? "bg-bg-secondary text-accent-primary shadow-sm" : "text-text-muted"}`}>▥ 原比例</button></div><input value={detailQuery} onChange={(e) => setDetailQuery(e.target.value)} className="h-9 min-w-[220px] flex-1 rounded-lg border border-surface-secondary bg-bg-secondary px-3 text-sm outline-none focus:ring-2 focus:ring-accent-primary/25" placeholder="搜索当前相册…" /><select value={detailSort} onChange={(e) => setDetailSort(e.target.value as typeof detailSort)} className="h-9 rounded-lg border border-surface-secondary bg-bg-secondary px-2 text-sm"><option value="date-desc">拍摄日期 · 降序</option><option value="date-asc">拍摄日期 · 升序</option><option value="name">名称</option></select>{selectedAlbum.album_type === "manual" && <button onClick={() => { setPickerOpen(true); setPickerSelection(new Set()); }} className="h-9 rounded-lg bg-accent-primary px-3 text-sm text-white">＋ 添加照片</button>}<button onClick={() => { setSelectionMode((v) => !v); setSelection(new Set()); }} className={`h-9 rounded-lg px-3 text-sm ${selectionMode ? "bg-accent-primary text-white" : "bg-surface-primary"}`}>{selectionMode ? `已选 ${selection.size}` : "管理"}</button>{selectionMode && selection.size > 0 && <><button onClick={async () => { await api.setAlbumCover(selectedAlbum.id, selection.values().next().value!); await refreshAlbums(); }} className="h-9 rounded-lg bg-surface-primary px-3 text-sm">设为封面</button>{selectedAlbum.album_type === "manual" && <button onClick={async () => { await api.removePhotosFromAlbum(selectedAlbum.id, [...selection]); setSelection(new Set()); await loadAlbumPhotos(selectedAlbum); await refreshAlbums(); }} className="h-9 rounded-lg bg-red-50 px-3 text-sm text-red-600">移出相册</button>}</>}<span className="ml-auto text-xs text-text-muted">{detailPhotos.length} 张</span></div>
    <div className="flex min-h-0 flex-1">{loading && albumPhotos.length === 0 ? <div className="flex flex-1 items-center justify-center text-text-muted">正在加载相册…</div> : <AlbumPhotoGrid photos={detailPhotos} shape={thumbnailShape} size={thumbnailSize} selectedId={selectedPhotoId} selectionMode={selectionMode} selection={selection} jump={timelineJump} onVisible={setVisiblePhoto} onPhoto={handlePhoto} onDouble={(photo) => setLightboxPhotoId(photo.id!)} />}<PhotoTimelineRail buckets={buckets} ascending={detailSort === "date-asc"} active={photoTimelinePosition(visiblePhoto)} onJump={(position) => { setTimelineJump(null); requestAnimationFrame(() => setTimelineJump(position)); }} /></div>
    {pickerOpen && <Dialog title="向相册添加照片" onClose={() => setPickerOpen(false)}><div className="flex h-[70vh] flex-col p-4"><input autoFocus value={pickerQuery} onChange={(e) => setPickerQuery(e.target.value)} className="mb-3 h-10 rounded-lg border border-surface-secondary px-3" placeholder="按文件名、日期、人物、标签或 EXIF 搜索…" /><div ref={pickerScrollRef} onScroll={(event) => { const element = event.currentTarget; if (pickerHasMore && !pickerLoading && element.scrollHeight - element.scrollTop - element.clientHeight < 500) void loadPicker(false); }} className="grid flex-1 auto-rows-max content-start grid-cols-4 gap-2 overflow-y-auto pr-1">{pickerPhotos.map((photo) => <button key={photo.id} onClick={() => setPickerSelection((current) => { const next = new Set(current); next.has(photo.id!) ? next.delete(photo.id!) : next.add(photo.id!); return next; })} className={`relative block w-full aspect-square self-start overflow-hidden rounded-lg border-2 ${pickerSelection.has(photo.id!) ? "border-accent-primary" : "border-transparent"}`}><Thumb photoId={photo.id!} /><span className="absolute bottom-0 left-0 right-0 truncate bg-black/55 px-1 py-0.5 text-left text-[10px] text-white">{photo.filename}</span></button>)}{pickerLoading && <div className="col-span-4 py-3 text-center text-sm text-text-muted">正在加载更多照片…</div>}{!pickerHasMore && pickerPhotos.length > 0 && <div className="col-span-4 py-3 text-center text-xs text-text-muted">已加载全部 {pickerPhotos.length} 张照片</div>}</div><div className="mt-3 flex items-center justify-between"><span className="text-xs text-text-muted">已加载 {pickerPhotos.length} 张 · 已选择 {pickerSelection.size} 张</span><div className="flex gap-2"><button onClick={() => setPickerOpen(false)} className="h-10 rounded-lg px-4">取消</button><button disabled={!pickerSelection.size} onClick={async () => { await api.addPhotosToAlbum(selectedAlbum.id, [...pickerSelection]); setPickerOpen(false); await loadAlbumPhotos(selectedAlbum); await refreshAlbums(); }} className="h-10 rounded-lg bg-accent-primary px-4 text-white disabled:opacity-50">添加 {pickerSelection.size} 张</button></div></div></div></Dialog>}
  </div>;

  return <div className="flex h-full flex-col"><div className="space-y-3 border-b border-surface-secondary px-4 pb-3 pt-4"><div className="flex items-center justify-between"><div><h2 className="text-xl font-bold">智能相册</h2><p className="mt-0.5 text-xs text-text-muted">自动整理与手工相册统一管理 · {albums.length} 个相册</p></div><div className="flex gap-2"><button onClick={() => setCreateOpen(true)} className="h-10 rounded-lg bg-accent-primary px-4 text-sm text-white">＋ 新建相册</button><button onClick={async () => { setRegenerating(true); try { await api.regenerateSmartAlbums(); await refreshAlbums(); } finally { setRegenerating(false); } }} disabled={regenerating} className="h-10 rounded-lg bg-surface-primary px-4 text-sm disabled:opacity-50">{regenerating ? "生成中…" : "重新生成自动相册"}</button></div></div><div className="flex flex-wrap items-center gap-2"><input value={albumQuery} onChange={(e) => setAlbumQuery(e.target.value)} className="h-10 min-w-[220px] flex-1 rounded-lg border border-surface-secondary bg-bg-secondary px-3 text-sm outline-none focus:ring-2 focus:ring-accent-primary/25" placeholder="搜索相册…" /><select value={albumType} onChange={(e) => setAlbumType(e.target.value as typeof albumType)} className="h-10 rounded-lg border border-surface-secondary bg-bg-secondary px-3 text-sm"><option value="all">全部类型</option><option value="manual">手工相册</option><option value="travel">旅行</option><option value="monthly">月度精选</option><option value="themed">主题</option><option value="person">人物</option></select><select value={albumSort} onChange={(e) => setAlbumSort(e.target.value as typeof albumSort)} className="h-10 rounded-lg border border-surface-secondary bg-bg-secondary px-3 text-sm"><option value="updated">最近更新</option><option value="name">名称</option><option value="count">照片数量</option></select><label className="flex h-10 items-center gap-2 rounded-lg bg-surface-primary px-3 text-xs text-text-muted"><span>封面</span><input type="range" min="140" max="320" step="20" value={albumCardSize} onChange={(e) => setAlbumCardSize(Number(e.target.value))} /></label></div></div>
    <div className="flex-1 overflow-y-auto p-4">{visibleAlbums.length === 0 ? <div className="py-12 text-center text-text-muted">没有符合条件的相册</div> : <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${albumCardSize}px, 1fr))` }}>{visibleAlbums.map((album) => <article key={album.id} onClick={() => setSelectedAlbum(album)} className="group cursor-pointer overflow-hidden rounded-xl bg-surface-primary transition hover:-translate-y-0.5 hover:shadow-md"><div className="relative aspect-square overflow-hidden bg-bg-tertiary">{album.cover_photo_id ? <Thumb photoId={album.cover_photo_id} /> : <div className="flex h-full items-center justify-center text-3xl text-text-muted">▧</div>}<div className="absolute right-2 top-2 hidden gap-1 group-hover:flex"><button onClick={(e) => { e.stopPropagation(); void rename(album); }} className="rounded-lg bg-black/60 px-2 py-1 text-xs text-white">编辑</button><button onClick={(e) => { e.stopPropagation(); void removeAlbum(album); }} className="rounded-lg bg-black/60 px-2 py-1 text-xs text-white">删除</button></div></div><div className="p-3"><div className="flex items-start justify-between gap-2"><h3 className="truncate text-sm font-medium">{album.name}</h3><span className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 text-[10px] text-text-muted">{typeLabels[album.album_type]}</span></div><p className="mt-1 text-xs text-text-muted">{album.photo_count} 张照片</p></div></article>)}</div>}</div>
    {createOpen && <Dialog title="新建手工相册" onClose={() => setCreateOpen(false)}><form className="p-5" onSubmit={async (e) => { e.preventDefault(); if (!newAlbumName.trim()) return; const id = await api.createManualAlbum(newAlbumName); setCreateOpen(false); setNewAlbumName(""); const nextAlbums = await api.getSmartAlbums() as SmartAlbum[]; setAlbums(nextAlbums); const next = nextAlbums.find((album) => album.id === id); if (next) setSelectedAlbum(next); }}><label className="text-sm text-text-muted">相册名称</label><input autoFocus value={newAlbumName} onChange={(e) => setNewAlbumName(e.target.value)} className="mt-2 h-11 w-full rounded-lg border border-surface-secondary px-3" placeholder="例如：家庭精选" /><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setCreateOpen(false)} className="h-10 rounded-lg px-4">取消</button><button className="h-10 rounded-lg bg-accent-primary px-4 text-white">创建并添加照片</button></div></form></Dialog>}
  </div>;
});
