import React, { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import type { PhotoFilter, PhotoTimelineBucket } from "../types";

function matchesSearch(bucket: PhotoTimelineBucket, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;

  const paddedMonth = String(bucket.month).padStart(2, "0");
  const candidates = [
    String(bucket.year),
    `${bucket.year}-${paddedMonth}`,
    `${bucket.year}/${paddedMonth}`,
    `${bucket.year}年${bucket.month}月`,
    `${bucket.month}月`,
  ];
  return candidates.some((candidate) => candidate.toLowerCase().includes(query));
}

function withoutTimeFilter(filter: PhotoFilter): PhotoFilter {
  return { ...filter, year: undefined, month: undefined };
}

export default React.memo(function PhotoTimeline() {
  const filter = useStore((state) => state.filter);
  const setFilter = useStore((state) => state.setFilter);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [buckets, setBuckets] = useState<PhotoTimelineBucket[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const timelineFilter = useMemo(
    () => withoutTimeFilter(filter),
    [
      filter.directory,
      filter.tag,
      filter.person_id,
      filter.has_gps,
      filter.has_favorite,
      filter.keyword,
      filter.format,
      filter.camera,
      filter.iso_min,
      filter.iso_max,
      filter.aperture_min,
      filter.aperture_max,
      filter.exposure_time,
      filter.orientation_kind,
      filter.rating_min,
      filter.rating_max,
    ],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.getPhotoTimeline(timelineFilter)
      .then((result) => {
        if (!cancelled) setBuckets(result);
      })
      .catch((reason) => {
        console.error("Failed to load photo timeline:", reason);
        if (!cancelled) setError("时间轴加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, timelineFilter]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const filteredBuckets = useMemo(
    () => buckets.filter((bucket) => matchesSearch(bucket, query)),
    [buckets, query],
  );

  const grouped = useMemo(() => {
    const result = new Map<number, PhotoTimelineBucket[]>();
    for (const bucket of filteredBuckets) {
      const existing = result.get(bucket.year) ?? [];
      existing.push(bucket);
      result.set(bucket.year, existing);
    }
    return Array.from(result.entries()).sort(([a], [b]) => b - a);
  }, [filteredBuckets]);

  const activeLabel = filter.year
    ? filter.month
      ? `${filter.year}年${filter.month}月`
      : `${filter.year}年`
    : "时间轴";

  const selectTime = (year?: number, month?: number) => {
    setFilter({ year, month });
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={rootRef} className="relative">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-haspopup="dialog"
          className={`flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors ${
            filter.year
              ? "bg-accent-primary text-white"
              : "bg-surface-primary/80 text-text-secondary hover:text-text-primary"
          }`}
          title="按拍摄年月查找照片"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="1.5" y="2.5" width="11" height="10" rx="2" />
            <path d="M4 1v3M10 1v3M1.5 5.5h11" strokeLinecap="round" />
          </svg>
          {activeLabel}
        </button>
        {filter.year && (
          <button
            type="button"
            onClick={() => selectTime(undefined, undefined)}
            className="rounded-md p-1.5 text-text-muted hover:bg-surface-primary hover:text-text-primary"
            aria-label="清除时间筛选"
            title="清除时间筛选"
          >
            ×
          </button>
        )}
      </div>

      {open && (
        <div
          role="dialog"
          aria-label="照片时间轴"
          className="absolute left-0 top-full z-40 mt-2 w-[320px] overflow-hidden rounded-2xl border border-surface-secondary bg-bg-secondary shadow-2xl"
        >
          <div className="border-b border-surface-secondary p-3">
            <div className="text-sm font-semibold text-text-primary">按时间查找</div>
            <div className="mt-1 text-xs text-text-muted">搜索或选择年份、月份，照片会按时间倒序显示。</div>
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索年份或月份，如 2026-08"
              className="mt-3 w-full rounded-lg border border-surface-secondary bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-primary"
            />
          </div>

          <div className="max-h-[360px] overflow-y-auto p-2">
            <button
              type="button"
              onClick={() => selectTime(undefined, undefined)}
              className={`mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                !filter.year ? "bg-accent-primary/10 text-accent-primary" : "hover:bg-surface-primary"
              }`}
            >
              <span>全部时间</span>
              <span className="text-xs text-text-muted">清除时间筛选</span>
            </button>

            {loading && <div className="px-3 py-8 text-center text-sm text-text-muted">正在读取时间轴…</div>}
            {error && <div className="px-3 py-8 text-center text-sm text-red-500">{error}</div>}
            {!loading && !error && grouped.length === 0 && (
              <div className="px-3 py-8 text-center text-sm text-text-muted">没有匹配的时间</div>
            )}

            {!loading && !error && grouped.map(([year, months]) => {
              const yearCount = months.reduce((sum, bucket) => sum + bucket.count, 0);
              return (
                <section key={year} className="mb-2">
                  <button
                    type="button"
                    onClick={() => selectTime(year, undefined)}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm font-semibold transition-colors ${
                      filter.year === year && !filter.month
                        ? "bg-accent-primary/10 text-accent-primary"
                        : "hover:bg-surface-primary"
                    }`}
                  >
                    <span>{year}年</span>
                    <span className="text-xs font-normal text-text-muted">{yearCount.toLocaleString()} 张</span>
                  </button>
                  <div className="grid grid-cols-3 gap-1 px-1 pb-1">
                    {months.map((bucket) => (
                      <button
                        type="button"
                        key={`${bucket.year}-${bucket.month}`}
                        onClick={() => selectTime(bucket.year, bucket.month)}
                        className={`rounded-lg px-2 py-2 text-left text-xs transition-colors ${
                          filter.year === bucket.year && filter.month === bucket.month
                            ? "bg-accent-primary text-white"
                            : "hover:bg-surface-primary"
                        }`}
                      >
                        <span className="block font-medium">{bucket.month}月</span>
                        <span className={filter.year === bucket.year && filter.month === bucket.month ? "text-white/75" : "text-text-muted"}>
                          {bucket.count.toLocaleString()} 张
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});
