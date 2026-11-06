import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../hooks/usePhotos";
import type { PhotoSortBy, SortDirection } from "../types";

const labels: Record<PhotoSortBy, string> = {
  capture_date: "拍摄日期",
  created_date: "导入日期",
  modified_date: "修改日期",
  name: "名称",
};

export default React.memo(function PhotoSortMenu() {
  const filter = useStore((state) => state.filter);
  const setFilter = useStore((state) => state.setFilter);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const sortBy = filter.sort_by ?? "capture_date";
  const direction = filter.sort_direction ?? "desc";

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const select = (nextSort: PhotoSortBy, nextDirection: SortDirection) => {
    setFilter({ sort_by: nextSort, sort_direction: nextDirection });
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((value) => !value)} className="rounded-lg bg-surface-primary/80 px-2.5 py-2 text-xs text-text-secondary hover:text-text-primary" title="排序">
        ⇅ {labels[sortBy]} · {direction === "asc" ? "升序" : "降序"}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-48 rounded-xl border border-surface-secondary bg-bg-secondary p-1.5 shadow-2xl">
          {(Object.keys(labels) as PhotoSortBy[]).map((key) => (
            <div key={key} className="flex items-center rounded-lg hover:bg-surface-primary">
              <span className="flex-1 px-2 py-2 text-xs">{labels[key]}</span>
              <button type="button" className={`px-2 py-2 text-xs ${sortBy === key && direction === "asc" ? "text-accent-primary" : "text-text-muted"}`} onClick={() => select(key, "asc")} title="升序">↑</button>
              <button type="button" className={`px-2 py-2 text-xs ${sortBy === key && direction === "desc" ? "text-accent-primary" : "text-text-muted"}`} onClick={() => select(key, "desc")} title="降序">↓</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
