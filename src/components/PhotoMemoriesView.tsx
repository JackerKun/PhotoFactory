import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getThumbnailPath, setPhotoMemoryPreferences } from "../api/tauri";
import { usePhotoMemories } from "../hooks/usePhotoMemories";
import type { PhotoMemory } from "../types";
import { exportMemoryVideo } from "../utils/memoryPlayback";
import AlbumCoverCard, { albumGridStyle } from "./AlbumCoverCard";
import Icon from "./Icon";
import MemoryPlayback from "./MemoryPlayback";

const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
});

function dateRange(memory: PhotoMemory) {
  const start = dateFormat.format(memory.start_at * 1000);
  const end = dateFormat.format(memory.end_at * 1000);
  return start === end ? start : `${start} – ${end}`;
}

function MemoryImage({ photoId, size = "small", fit = "cover" }: {
  photoId: number;
  size?: "small" | "medium";
  fit?: "cover" | "contain";
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let active = true;
    getThumbnailPath(photoId, size).then((path) => {
      if (active) setUrl(convertFileSrc(path));
    }).catch(() => {});
    return () => { active = false; };
  }, [photoId, size]);
  return url
    ? <img src={url} alt="" draggable={false} decoding="async" className={`h-full w-full ${fit === "cover" ? "object-cover" : "object-contain"}`} onError={() => setUrl(undefined)} />
    : <div className="grid h-full w-full place-items-center text-text-muted"><Icon name="photos" size={24} /></div>;
}

export function MemoryDetail({ memory, root, onBack }: {
  memory: PhotoMemory;
  root: string;
  onBack: () => void;
}) {
  const [tag, setTag] = useState("");
  const [saving, setSaving] = useState(false);
  const [preferenceError, setPreferenceError] = useState("");
  const [exportStatus, setExportStatus] = useState<{ error: boolean; text: string }>();
  const [progress, setProgress] = useState<number>();
  const [playback, setPlayback] = useState<{ memory: PhotoMemory; start: number; autoPlay: boolean }>();
  const exportTask = useRef<AbortController>();
  useEffect(() => () => exportTask.current?.abort(), []);

  async function savePreferences(favorite: boolean, tags: string[]) {
    setSaving(true);
    setPreferenceError("");
    try {
      await setPhotoMemoryPreferences(root, memory.id, favorite, tags);
      usePhotoMemories.getState().update(root, memory.id, favorite, tags);
      return true;
    } catch (error) {
      setPreferenceError(String(error));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function startExport() {
    if (exportTask.current) return;
    const task = new AbortController();
    exportTask.current = task;
    setExportStatus(undefined);
    setProgress(0);
    try {
      const result = await exportMemoryVideo(memory, task.signal, (value) => setProgress(Math.round(value * 100)));
      if (result) {
        const skipped = result.skipped ? `，已跳过 ${result.skipped} 张无法读取的照片` : "";
        setExportStatus({ error: false, text: `视频已保存至 ${result.path}${skipped}。` });
      }
    } catch (error) {
      setExportStatus(task.signal.aborted
        ? { error: false, text: "已取消导出。" }
        : { error: true, text: `导出失败。${String(error)}` });
    } finally {
      exportTask.current = undefined;
      setProgress(undefined);
    }
  }

  return <section className="min-h-0 flex-1 overflow-y-auto p-4">
    <button type="button" onClick={onBack} disabled={progress !== undefined} className="ui-button">← 返回回忆</button>
    <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="aspect-[16/9] overflow-hidden rounded-xl bg-bg-tertiary">
        <MemoryImage key={memory.cover_photo_id} photoId={memory.cover_photo_id} size="medium" />
      </div>
      <div className="rounded-xl border border-surface-secondary bg-bg-secondary p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm text-text-muted">{dateRange(memory)}</p>
            <h2 className="mt-1 text-2xl font-semibold">{memory.title}</h2>
          </div>
          <button type="button" aria-pressed={memory.favorite} onClick={() => void savePreferences(!memory.favorite, memory.tags)} disabled={saving} className="ui-button">
            {memory.favorite ? "♥ 已收藏" : "♡ 收藏"}
          </button>
        </div>
        <div className="ui-toolbar mt-4">
          <button type="button" className="ui-button-primary" disabled={progress !== undefined} onClick={() => setPlayback({ memory, start: 0, autoPlay: true })}>▶ 播放回忆</button>
          <button type="button" className="ui-button" disabled={progress !== undefined} onClick={() => void startExport()}><Icon name="download" size={16} />导出视频</button>
        </div>
        {progress !== undefined && <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <progress aria-label="导出视频进度" value={progress} max={100} className="ui-progress min-w-20 flex-1" />
          <span className="tabular-nums">{progress}%</span>
          <button type="button" className="ui-button" onClick={() => exportTask.current?.abort()}>取消</button>
        </div>}
        {exportStatus && <p role={exportStatus.error ? "alert" : "status"} className="mt-3 break-all text-sm text-text-secondary">{exportStatus.text}</p>}
        <form className="mt-4 flex items-center gap-2" onSubmit={(event) => {
          event.preventDefault();
          const name = tag.trim();
          if (!name || saving || memory.tags.length >= 20 || memory.tags.some((item) => item.toLowerCase() === name.toLowerCase())) return;
          void savePreferences(memory.favorite, [...memory.tags, name]).then((saved) => { if (saved) setTag(""); });
        }}>
          <input aria-label="回忆标签" placeholder="添加回忆标签" value={tag} maxLength={32} disabled={saving} onChange={(event) => setTag(event.target.value)} className="ui-input flex-1" />
          <button type="submit" className="ui-button" disabled={saving || !tag.trim() || memory.tags.length >= 20}>添加</button>
        </form>
        {memory.tags.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">
          {memory.tags.map((name) => <button key={name} type="button" className="rounded-full bg-surface-primary px-2.5 py-1 text-xs hover:text-red-500" disabled={saving} aria-label={`移除标签 ${name}`} onClick={() => void savePreferences(memory.favorite, memory.tags.filter((item) => item !== name))}>{name} ×</button>)}
        </div>}
        {preferenceError && <p role="alert" className="mt-2 text-sm text-red-500">{preferenceError}</p>}
        <details className="mt-4 border-t border-surface-secondary pt-3 text-sm text-text-secondary">
          <summary className="cursor-pointer font-medium text-text-primary">选片依据 · {memory.photo_ids.length} / {memory.source_count} 张</summary>
          <dl className="mt-2 space-y-1">
            <div><dt className="inline font-medium">拍摄时间</dt><dd className="ml-2 inline">同一拍摄时段，按时间回放</dd></div>
            {(memory.location || memory.gps_count > 0) && <div><dt className="inline font-medium">地点</dt><dd className="ml-2 inline">{memory.location ? `${memory.location} · ` : ""}{memory.gps_count} 张含坐标</dd></div>}
            {memory.people.length > 0 && <div><dt className="inline font-medium">常出现的人物</dt><dd className="ml-2 inline">{memory.people.join("、")}</dd></div>}
            {memory.scene && <div><dt className="inline font-medium">AI 识别场景</dt><dd className="ml-2 inline">{memory.scene}</dd></div>}
            <div><dt className="inline font-medium">照片优选</dt><dd className="ml-2 inline">参考星级和收藏{memory.indexed_count > 0 ? `，其中 ${memory.indexed_count} 张可参考清晰度和相似图索引` : ""}</dd></div>
          </dl>
        </details>
      </div>
    </div>
    <div aria-label="按拍摄时间排列的照片" className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-3">
      {memory.photo_ids.map((id, index) => <button
        key={id}
        type="button"
        aria-label={`查看第 ${index + 1} 张照片`}
        onClick={() => setPlayback({ memory, start: index, autoPlay: false })}
        disabled={progress !== undefined}
        className="aspect-square overflow-hidden rounded-xl bg-bg-tertiary hover:ring-2 hover:ring-accent-primary"
      >
        <MemoryImage photoId={id} />
      </button>)}
    </div>
    {playback && <MemoryPlayback {...playback} onClose={() => setPlayback(undefined)}
      fallback={<MemoryImage photoId={playback.memory.photo_ids[playback.start]} size="medium" fit="contain" />} />}
  </section>;
}

export default function PhotoMemoriesView({ memories, size, loading, error, onOpen }: {
  memories: PhotoMemory[];
  size: number;
  loading: boolean;
  error: string | null;
  onOpen: (id: number) => void;
}) {
  return <section aria-busy={loading} className="album-catalog min-h-0 flex-1 overflow-y-auto">
    {error && <p role="alert" className="mb-4 break-words rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm">回忆读取失败。{error}</p>}
    {!error && memories.length === 0 && <p role="status" className="py-12 text-center text-text-muted">{loading ? "正在整理回忆…" : "没有符合条件的回忆"}</p>}
    <div className="album-cover-grid grid" style={albumGridStyle(size)}>
      {memories.map((memory) => <AlbumCoverCard
        key={memory.id}
        title={memory.title}
        badge={memory.favorite ? "♥ 已收藏" : memory.kind === "anniversary" ? "往年此时" : "拍摄回顾"}
        description={`${dateRange(memory)} · ${memory.photo_ids.length} 张${memory.tags.length ? " · " + memory.tags.join("、") : ""}`}
        cover={<MemoryImage key={memory.cover_photo_id} photoId={memory.cover_photo_id} />}
        onOpen={() => onOpen(memory.id)}
      />)}
    </div>
  </section>;
}
