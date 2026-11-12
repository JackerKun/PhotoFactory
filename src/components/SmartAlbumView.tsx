import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Photo, PhotoCursor, PhotoTimelineBucket, SmartAlbum } from "../types";
import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import PhotoCard from "./PhotoCard";
import PhotoMemoriesView, { MemoryDetail } from "./PhotoMemoriesView";
import AlbumCoverCard, { AlbumCoverThumbnail, albumGridStyle } from "./AlbumCoverCard";
import { usePhotoMemories } from "../hooks/usePhotoMemories";
import PhotoTimelineRail from "./PhotoTimelineRail";
import { buildJustifiedRows } from "./ProportionalVirtualGrid";
import { calculateColumnCount } from "../hooks/useVirtualGrid";
import { matchesTimeline, photoTimelinePosition, type TimelinePosition } from "../utils/photoTimeline";

interface Props { onSelectPhoto: (id: number) => void; }
const GAP = 4;
const typeLabels: Record<SmartAlbum["album_type"], string> = {
  travel: "旅行", monthly: "月度精选", themed: "主题", person: "人物", manual: "手工相册", person_combination: "人物组合",
};

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
  const [section, setSection] = useState<"albums" | "memories">("albums");
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoryFilter, setMemoryFilter] = useState("all");
  const [selectedMemoryId, setSelectedMemoryId] = useState<number>();
  const root = useStore((state) => state.project?.root_path ?? null);
  const memoryState = usePhotoMemories();
  const selectedMemory = root === memoryState.root ? memoryState.memories.find((item) => item.id === selectedMemoryId) : undefined;
  useEffect(() => setSelectedMemoryId(undefined), [root]);
  const [generationFeedback, setGenerationFeedback] = useState<{ error: boolean; text: string }>();
  useEffect(() => {
    if (!generationFeedback) return;
    const timeout = window.setTimeout(() => setGenerationFeedback(undefined), 6000);
    return () => window.clearTimeout(timeout);
  }, [generationFeedback]);
  const [albums, setAlbums] = useState<SmartAlbum[]>([]);
  const [selectedAlbum, setSelectedAlbum] = useState<SmartAlbum | null>(null);
  const [albumPhotos, setAlbumPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(false);
  const [combinationRevision, setCombinationRevision] = useState(0);
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
  const albumRequest = useRef(0);
  const loadAlbumPhotos = useCallback(async (album: SmartAlbum) => {
    const request = ++albumRequest.current;
    setLoading(true); setAlbumPhotos([]);
    try { let cursor: number | undefined; const all: Photo[] = [];
      while (true) { const tuples = await api.getSmartAlbumPhotos(album.id, cursor, 200) as [number, number][]; if (!tuples.length) break;
        const photos = (await Promise.all(tuples.map(([id]) => api.getPhoto(id).catch(() => null)))).filter(Boolean) as Photo[];
        if (request !== albumRequest.current) return;
        all.push(...photos); setAlbumPhotos([...all]); cursor = tuples[tuples.length - 1]?.[1]; if (tuples.length < 200) break; }
    } finally { if (request === albumRequest.current) setLoading(false); }
  }, []);
  useEffect(() => { if (selectedAlbum) void loadAlbumPhotos(selectedAlbum); }, [loadAlbumPhotos, selectedAlbum?.id, selectedAlbum?.album_type === "person_combination" ? combinationRevision : 0]);
  useEffect(() => {
    const subscription = listen<{ stage?: string }>("ai_status_changed", ({ payload }) => {
      if (payload.stage === "clustering_done" || payload.stage === "done") {
        void refreshAlbums().catch(() => {});
        setCombinationRevision((value) => value + 1);
      }
    });
    return () => { void subscription.then((stop) => stop()).catch(() => {}); };
  }, [refreshAlbums]);

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
    <header className="ui-toolbar border-b border-surface-secondary bg-bg-secondary px-[var(--workspace-inline)] py-[var(--ui-gap)]">
      <button type="button" onClick={() => { setSelectedAlbum(null); setSelectionMode(false); setSelection(new Set()); }} className="ui-button">← 返回</button>
      <h2 className="min-w-0 truncate text-xl font-bold">{selectedAlbum.name}</h2>
      <span className="text-sm text-text-muted">{albumPhotos.length}/{selectedAlbum.photo_count} 张</span>
      <span className="rounded bg-accent-primary/10 px-2 py-0.5 text-xs text-accent-link">{typeLabels[selectedAlbum.album_type]}</span>
      <div className="ui-toolbar ml-auto">
        <button type="button" onClick={() => void rename(selectedAlbum)} className="ui-button">改名</button>
        <button type="button" onClick={() => void removeAlbum(selectedAlbum)} className="ui-button text-red-600 dark:text-red-300">删除</button>
      </div>
    </header>
    <div className="ui-toolbar border-b border-surface-secondary bg-bg-secondary px-[var(--workspace-inline)] py-[var(--ui-gap)]">
      <div className="ui-segments" role="group" aria-label="相册照片布局">
        <button type="button" onClick={() => setThumbnailShape("square")} aria-pressed={thumbnailShape === "square"} className="ui-segment">方格</button>
        <button type="button" onClick={() => setThumbnailShape("proportional")} aria-pressed={thumbnailShape === "proportional"} className="ui-segment">原比例</button>
      </div>
      <input value={detailQuery} onChange={(event) => setDetailQuery(event.target.value)} className="ui-input min-w-36 flex-1" aria-label="搜索当前相册" placeholder="搜索当前相册…" />
      <select value={detailSort} onChange={(event) => setDetailSort(event.target.value as typeof detailSort)} className="ui-select" aria-label="照片排序">
        <option value="date-desc">拍摄日期 · 降序</option>
        <option value="date-asc">拍摄日期 · 升序</option>
        <option value="name">名称</option>
      </select>
      {selectedAlbum.album_type === "manual" && <button type="button" onClick={() => { setPickerOpen(true); setPickerSelection(new Set()); }} className="ui-button-primary">＋ 添加照片</button>}
      <button type="button" onClick={() => { setSelectionMode((value) => !value); setSelection(new Set()); }} aria-pressed={selectionMode} className="ui-button">{selectionMode ? `已选 ${selection.size}` : "管理"}</button>
      {selectionMode && selection.size > 0 && <>
        <button type="button" onClick={async () => { await api.setAlbumCover(selectedAlbum.id, selection.values().next().value!); await refreshAlbums(); }} className="ui-button">设为封面</button>
        {selectedAlbum.album_type === "manual" && <button type="button" onClick={async () => {
          await api.removePhotosFromAlbum(selectedAlbum.id, [...selection]);
          setSelection(new Set());
          await loadAlbumPhotos(selectedAlbum);
          await refreshAlbums();
        }} className="ui-button text-red-600 dark:text-red-300">移出相册</button>}
      </>}
      <span className="ml-auto text-xs text-text-muted">{detailPhotos.length} 张</span>
    </div>
    <div className="flex min-h-0 flex-1">{loading && albumPhotos.length === 0 ? <div className="flex flex-1 items-center justify-center text-text-muted">正在加载相册…</div> : <AlbumPhotoGrid photos={detailPhotos} shape={thumbnailShape} size={thumbnailSize} selectedId={selectedPhotoId} selectionMode={selectionMode} selection={selection} jump={timelineJump} onVisible={setVisiblePhoto} onPhoto={handlePhoto} onDouble={(photo) => setLightboxPhotoId(photo.id!)} />}<PhotoTimelineRail buckets={buckets} ascending={detailSort === "date-asc"} active={photoTimelinePosition(visiblePhoto)} onJump={(position) => { setTimelineJump(null); requestAnimationFrame(() => setTimelineJump(position)); }} /></div>
    {pickerOpen && <Dialog title="向相册添加照片" onClose={() => setPickerOpen(false)}><div className="flex h-[70vh] flex-col p-4"><input autoFocus value={pickerQuery} onChange={(e) => setPickerQuery(e.target.value)} className="ui-input mb-3" placeholder="按文件名、日期、人物、标签或 EXIF 搜索…" /><div ref={pickerScrollRef} onScroll={(event) => { const element = event.currentTarget; if (pickerHasMore && !pickerLoading && element.scrollHeight - element.scrollTop - element.clientHeight < 500) void loadPicker(false); }} className="grid flex-1 auto-rows-max content-start grid-cols-4 gap-2 overflow-y-auto pr-1">{pickerPhotos.map((photo) => <button key={photo.id} onClick={() => setPickerSelection((current) => { const next = new Set(current); next.has(photo.id!) ? next.delete(photo.id!) : next.add(photo.id!); return next; })} className={`relative block w-full aspect-square self-start overflow-hidden rounded-lg border-2 ${pickerSelection.has(photo.id!) ? "border-accent-primary" : "border-transparent"}`}><AlbumCoverThumbnail photoId={photo.id!} /><span className="absolute bottom-0 left-0 right-0 truncate bg-black/55 px-1 py-0.5 text-left text-xs text-white">{photo.filename}</span></button>)}{pickerLoading && <div className="col-span-4 py-3 text-center text-sm text-text-muted">正在加载更多照片…</div>}{!pickerHasMore && pickerPhotos.length > 0 && <div className="col-span-4 py-3 text-center text-xs text-text-muted">已加载全部 {pickerPhotos.length} 张照片</div>}</div><div className="mt-3 flex items-center justify-between"><span className="text-xs text-text-muted">已加载 {pickerPhotos.length} 张 · 已选择 {pickerSelection.size} 张</span><div className="flex gap-2"><button onClick={() => setPickerOpen(false)} className="ui-button">取消</button><button disabled={!pickerSelection.size} onClick={async () => { await api.addPhotosToAlbum(selectedAlbum.id, [...pickerSelection]); setPickerOpen(false); await loadAlbumPhotos(selectedAlbum); await refreshAlbums(); }} className="ui-button-primary">添加 {pickerSelection.size} 张</button></div></div></div></Dialog>}
  </div>;

  async function regenerate() {
    setRegenerating(true);
    setGenerationFeedback(undefined);
    try {
      const count = await api.regenerateSmartAlbums();
      await refreshAlbums();
      setGenerationFeedback({ error: false, text: `已生成 ${count} 个自动相册。` });
    } catch (error) {
      setGenerationFeedback({ error: true, text: `生成失败。${String(error)}` });
    } finally {
      setRegenerating(false);
    }
  }

  if (section === "memories" && selectedMemory && root) {
    return <div className="flex h-full flex-col">
      <MemoryDetail key={selectedMemory.id} memory={selectedMemory} root={root} onBack={() => setSelectedMemoryId(undefined)} />
    </div>;
  }

  const showingAlbums = section === "albums";
  const memories = root === memoryState.root ? memoryState.memories : [];
  const tags = [...new Set(memories.flatMap((memory) => memory.tags))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const activeMemoryFilter = memoryFilter.startsWith("tag:") && !tags.includes(memoryFilter.slice(4)) ? "all" : memoryFilter;
  const query = memoryQuery.trim().toLocaleLowerCase();
  const visibleMemories = memories
    .filter((memory) => {
      const filterMatches = activeMemoryFilter === "all"
        || (activeMemoryFilter === "favorite" && memory.favorite)
        || memory.kind === activeMemoryFilter
        || memory.tags.some((tag) => activeMemoryFilter === `tag:${tag}`);
      return filterMatches && (!query || [memory.title, memory.scene, memory.location, ...memory.people, ...memory.tags]
        .some((value) => value?.toLocaleLowerCase().includes(query)));
    })
    .sort((a, b) => {
      if (albumSort === "name") return a.title.localeCompare(b.title, "zh-CN");
      if (albumSort === "count") return b.photo_ids.length - a.photo_ids.length;
      return Number(b.favorite) - Number(a.favorite) || b.start_at - a.start_at;
    });
  return <div className="flex h-full flex-col">
    <header className="album-header relative z-10 grid shrink-0 gap-[var(--ui-gap)] border-b border-surface-secondary">
      <div className="ui-toolbar justify-between">
        <h2 className="text-xl font-bold">智能相册</h2>
        <div className="ui-toolbar">
          <span className="text-xs text-text-muted tabular-nums" role="status">
            {showingAlbums ? `${albums.length} 个相册` : memoryState.loading ? "正在整理回忆…" : `${memories.length} 段回忆`}
          </span>
          <details key={section} className="relative">
            <summary className="ui-button cursor-pointer list-none">生成依据</summary>
            <div className="absolute right-0 top-full mt-1 w-[min(26rem,75vw)] rounded-xl border border-surface-secondary bg-bg-secondary p-4 text-sm leading-relaxed text-text-secondary shadow-lg">
              {showingAlbums ? <ul className="space-y-1.5">
                <li><strong>旅行</strong> · 同一地点标签至少覆盖 3 天和 20 张。</li>
                <li><strong>月度精选</strong> · 按时间取该月最早的 50 张。</li>
                <li><strong>主题</strong> · AI 场景标签达到 10 张时，收录该标签下的全部照片。</li>
                <li><strong>人物</strong> · 每位已命名人物最多收录最近 200 张。</li>
              </ul> : <p>按拍摄时间和坐标聚合，每段最多精选 24 张。参考收藏、星级、清晰度、相似图索引和已有的 AI 标签。往年此时取往年同日前后 3 天。</p>}
            </div>
          </details>
        </div>
      </div>
      <div className="album-action-row items-start gap-[var(--ui-gap)]">
        <nav aria-label="相册视图" className="ui-segments self-start">
          <button type="button" aria-pressed={showingAlbums} onClick={() => setSection("albums")} className="ui-segment">全部相册</button>
          <button type="button" aria-pressed={!showingAlbums} onClick={() => setSection("memories")} className="ui-segment">回忆</button>
        </nav>
        <div className="album-actions ui-toolbar justify-end">
          {showingAlbums ? <>
            <button type="button" onClick={() => setCreateOpen(true)} className="ui-button-primary">＋ 新建相册</button>
            <button type="button" onClick={() => void regenerate()} disabled={regenerating} className="ui-button">{regenerating ? "生成中…" : "重新生成自动相册"}</button>
          </> : <button type="button" onClick={() => void memoryState.load(root, "refresh")} disabled={memoryState.loading} className="ui-button">刷新回忆</button>}
        </div>
      </div>
      <div className="ui-toolbar">
        <input aria-label={showingAlbums ? "搜索相册" : "搜索回忆"} value={showingAlbums ? albumQuery : memoryQuery}
          onChange={(event) => showingAlbums ? setAlbumQuery(event.target.value) : setMemoryQuery(event.target.value)}
          className="ui-input min-w-36 flex-1"
          placeholder={showingAlbums ? "搜索相册…" : "搜索回忆或标签…"} />
        {showingAlbums ? <select aria-label="相册类型" value={albumType} onChange={(event) => setAlbumType(event.target.value as typeof albumType)} className="ui-select w-36">
          <option value="all">全部类型</option>
          {Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select> : <select aria-label="回忆筛选" value={activeMemoryFilter} onChange={(event) => setMemoryFilter(event.target.value)} className="ui-select w-36">
          <option value="all">全部类型</option>
          <option value="favorite">已收藏</option>
          <option value="event">拍摄回顾</option>
          <option value="anniversary">往年此时</option>
          {tags.length > 0 && <optgroup label="回忆标签">
            {tags.map((tag) => <option key={tag} value={`tag:${tag}`}>{tag}</option>)}
          </optgroup>}
        </select>}
        <select aria-label="排序" value={albumSort} onChange={(event) => setAlbumSort(event.target.value as typeof albumSort)} className="ui-select w-28">
          <option value="updated">{showingAlbums ? "最近更新" : "拍摄日期"}</option>
          <option value="name">名称</option>
          <option value="count">照片数量</option>
        </select>
        <label className="ui-field text-text-secondary">
          <span>封面尺寸</span>
          <input type="range" min="140" max="320" step="20" value={albumCardSize} onChange={(event) => setAlbumCardSize(Number(event.target.value))} className="w-20 accent-accent-primary" />
        </label>
      </div>
      {showingAlbums && generationFeedback && <p role={generationFeedback.error ? "alert" : "status"} className={`absolute right-4 top-full max-w-[min(28rem,85%)] break-words rounded-lg border border-surface-secondary bg-bg-secondary px-3 py-2 text-sm shadow-md ${generationFeedback.error ? "text-red-500" : "text-text-secondary"}`}>{generationFeedback.text}</p>}
    </header>
    {showingAlbums ? <section className="album-catalog min-h-0 flex-1 overflow-y-auto">
      {visibleAlbums.length === 0 && <p className="py-12 text-center text-text-muted">没有符合条件的相册</p>}
      <div className="album-cover-grid grid" style={albumGridStyle(albumCardSize)}>
        {visibleAlbums.map((album) => <AlbumCoverCard
          key={album.id}
          title={album.name}
          badge={typeLabels[album.album_type]}
          description={`${album.photo_count} 张照片`}
          cover={album.cover_photo_id ? <AlbumCoverThumbnail key={album.cover_photo_id} photoId={album.cover_photo_id} /> : <div className="grid h-full place-items-center text-3xl">▧</div>}
          onOpen={() => setSelectedAlbum(album)}
          actions={<>
            <button onClick={() => void rename(album)} className="rounded-lg bg-black/65 px-2 py-1 text-xs text-white">编辑</button>
            <button onClick={() => void removeAlbum(album)} className="rounded-lg bg-black/65 px-2 py-1 text-xs text-white">删除</button>
          </>}
        />)}
      </div>
    </section> : <PhotoMemoriesView
      memories={visibleMemories}
      size={albumCardSize}
      loading={memoryState.loading}
      error={memoryState.error}
      onOpen={setSelectedMemoryId}
    />}
    {createOpen && <Dialog title="新建手工相册" onClose={() => setCreateOpen(false)}><form className="p-5" onSubmit={async (e) => { e.preventDefault(); if (!newAlbumName.trim()) return; const id = await api.createManualAlbum(newAlbumName); setCreateOpen(false); setNewAlbumName(""); const nextAlbums = await api.getSmartAlbums() as SmartAlbum[]; setAlbums(nextAlbums); const next = nextAlbums.find((album) => album.id === id); if (next) setSelectedAlbum(next); }}><label className="text-sm text-text-muted">相册名称</label><input autoFocus value={newAlbumName} onChange={(e) => setNewAlbumName(e.target.value)} className="ui-input mt-2 w-full" placeholder="例如：家庭精选" /><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setCreateOpen(false)} className="ui-button">取消</button><button className="ui-button-primary">创建并添加照片</button></div></form></Dialog>}
  </div>;
});
