import React, { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import type { ManualTag, PhotoFilterOptions, PhotoTimelineBucket } from "../types";

export default React.memo(function PhotoSearch() {
  const filter = useStore((state) => state.filter);
  const setFilter = useStore((state) => state.setFilter);
  const [value, setValue] = useState(filter.keyword ?? "");
  const [open, setOpen] = useState(false);
  const [timeline, setTimeline] = useState<PhotoTimelineBucket[]>([]);
  const [options, setOptions] = useState<PhotoFilterOptions | null>(null);
  const [tags, setTags] = useState<ManualTag[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setValue(filter.keyword ?? ""), [filter.keyword]);
  useEffect(() => {
    if (!open) return;
    const base = { ...filter, keyword: undefined, year: undefined, month: undefined, format: undefined, camera: undefined };
    Promise.all([api.getPhotoTimeline(base), api.getPhotoFilterOptions(base), api.getManualTags()])
      .then(([time, facets, manualTags]) => { setTimeline(time); setOptions(facets); setTags(manualTags); })
      .catch(console.error);
  }, [open]); // suggestions represent the library/context at the moment the box opens

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const query = value.trim().toLowerCase();
  const dates = useMemo(() => timeline.filter((bucket) => {
    const label = `${bucket.year}年${bucket.month}月`;
    return !query || label.includes(query) || `${bucket.year}-${String(bucket.month).padStart(2, "0")}`.includes(query);
  }).slice(0, 6), [timeline, query]);
  const formats = (options?.formats ?? []).filter((item) => !query || item.value.toLowerCase().includes(query)).slice(0, 5);
  const cameras = (options?.cameras ?? []).filter((item) => !query || item.value.toLowerCase().includes(query)).slice(0, 5);
  const matchingTags = tags.filter((tag) => !query || tag.name.toLowerCase().includes(query)).slice(0, 5);

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    setFilter({ keyword: value.trim() || undefined });
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative min-w-[min(100%,13rem)] flex-1">
      <form onSubmit={submit} className="ui-search">
        <input value={value} onChange={(event) => { setValue(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} placeholder="搜索文件名、日期、人物、标签、EXIF…" aria-label="搜索照片" className="ui-input flex-1" />
        {(value || filter.keyword) && <button type="button" onClick={() => { setValue(""); setFilter({ keyword: undefined }); }} className="ui-button ui-icon-button text-text-muted" aria-label="清除搜索" title="清除搜索">×</button>}
        <button type="submit" className="ui-button-primary">搜索</button>
      </form>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-2 max-h-[420px] overflow-y-auto rounded-2xl border border-surface-secondary bg-bg-secondary p-2 shadow-2xl">
          {value.trim() && <button type="button" onClick={() => submit()} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-primary"><span>⌕</span><span>搜索所有条件中的“{value.trim()}”</span></button>}
          {dates.length > 0 && <SuggestionGroup title="日期">{dates.map((item) => <Suggestion key={`${item.year}-${item.month}`} label={`${item.year}年${item.month}月`} detail={`${item.count} 张`} onClick={() => { setValue(""); setFilter({ keyword: undefined, year: item.year, month: item.month }); setOpen(false); }} />)}</SuggestionGroup>}
          {matchingTags.length > 0 && <SuggestionGroup title="标签">{matchingTags.map((item) => <Suggestion key={item.id} label={item.name} detail={`${item.photo_count} 张`} onClick={() => { setValue(""); setFilter({ keyword: undefined, tag: item.name }); setOpen(false); }} />)}</SuggestionGroup>}
          {cameras.length > 0 && <SuggestionGroup title="相机">{cameras.map((item) => <Suggestion key={item.value} label={item.value} detail={`${item.count} 张`} onClick={() => { setValue(""); setFilter({ keyword: undefined, camera: item.value }); setOpen(false); }} />)}</SuggestionGroup>}
          {formats.length > 0 && <SuggestionGroup title="格式">{formats.map((item) => <Suggestion key={item.value} label={item.value.toUpperCase()} detail={`${item.count} 张`} onClick={() => { setValue(""); setFilter({ keyword: undefined, format: item.value }); setOpen(false); }} />)}</SuggestionGroup>}
        </div>
      )}
    </div>
  );
});

function SuggestionGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mt-2 border-t border-surface-secondary pt-2"><h4 className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</h4>{children}</section>;
}

function Suggestion({ label, detail, onClick }: { label: string; detail: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-primary"><span className="truncate">{label}</span><span className="ml-3 shrink-0 text-xs text-text-muted">{detail}</span></button>;
}
