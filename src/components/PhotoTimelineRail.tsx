import React, { useEffect, useMemo, useState } from "react";
import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import type { PhotoTimelineBucket } from "../types";
import type { TimelinePosition } from "../utils/photoTimeline";

interface Props {
  active: TimelinePosition | null;
  onJump: (position: TimelinePosition) => void;
  buckets?: PhotoTimelineBucket[];
  ascending?: boolean;
}

/**
 * Navigation for the current result set. Unlike the toolbar timeline, this
 * rail never changes the filter: scrolling updates its highlight and a click
 * asks the active grid to scroll to that date.
 */
export default React.memo(function PhotoTimelineRail({ active, onJump, buckets: suppliedBuckets, ascending: suppliedAscending }: Props) {
  const filter = useStore((state) => state.filter);
  const [buckets, setBuckets] = useState<PhotoTimelineBucket[]>([]);

  useEffect(() => {
    if (suppliedBuckets) {
      setBuckets(suppliedBuckets.filter((item) => item.count > 0));
      return;
    }
    let cancelled = false;
    api.getPhotoTimeline(filter)
      .then((items) => { if (!cancelled) setBuckets(items.filter((item) => item.count > 0)); })
      .catch((error) => {
        console.error(error);
        if (!cancelled) setBuckets([]);
      });
    return () => { cancelled = true; };
  }, [filter, suppliedBuckets]);

  const groups = useMemo(() => {
    const map = new Map<number, PhotoTimelineBucket[]>();
    for (const bucket of buckets) map.set(bucket.year, [...(map.get(bucket.year) ?? []), bucket]);
    const ascending = suppliedAscending ?? ((filter.sort_by ?? "capture_date") === "capture_date" && filter.sort_direction === "asc");
    return Array.from(map.entries())
      .sort(([a], [b]) => ascending ? a - b : b - a)
      .map(([year, months]) => [year, [...months].sort((a, b) => ascending ? a.month - b.month : b.month - a.month)] as const);
  }, [buckets, filter.sort_by, filter.sort_direction, suppliedAscending]);

  if (groups.length === 0) return null;
  return (
    <aside className="w-[68px] shrink-0 overflow-y-auto border-l border-surface-secondary bg-bg-secondary/80 px-1.5 py-2" aria-label="右侧照片时间轴">
      <div className="mb-2 text-center text-[9px] font-medium text-text-muted">时间导航</div>
      {groups.map(([year, months]) => (
        <section key={year} className="mb-3 border-l border-surface-secondary pl-1">
          <button
            type="button"
            onClick={() => onJump({ year })}
            className={`w-full rounded-md px-1 py-1 text-xs font-semibold transition-colors ${active?.year === year ? "text-accent-primary" : "text-text-secondary hover:bg-surface-primary"}`}
            aria-current={active?.year === year ? "true" : undefined}
            title={`跳到 ${year} 年`}
          >
            {year}
          </button>
          <div className="mt-0.5 flex flex-col gap-0.5">
            {months.map((month) => {
              const selected = active?.year === year && active.month === month.month;
              return (
                <button
                  type="button"
                  key={month.month}
                  onClick={() => onJump({ year, month: month.month })}
                  title={`${year}年${month.month}月 · ${month.count} 张；点击滚动到该月`}
                  aria-label={`${year}年${month.month}月，${month.count}张`}
                  aria-current={selected ? "true" : undefined}
                  className={`relative rounded px-1 py-0.5 text-[10px] transition-colors ${selected ? "bg-accent-primary text-white shadow-sm" : "text-text-muted hover:bg-accent-primary/15 hover:text-text-primary"}`}
                >
                  {month.month}月
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </aside>
  );
});
