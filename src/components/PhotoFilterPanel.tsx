import React, { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import type { PhotoFilterOptions } from "../types";
import Icon from "./Icon";

const emptyOptions: PhotoFilterOptions = { formats: [], cameras: [], exposure_times: [], iso_min: null, iso_max: null, aperture_min: null, aperture_max: null };

export default React.memo(function PhotoFilterPanel() {
  const filter = useStore((state) => state.filter);
  const setFilter = useStore((state) => state.setFilter);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState(emptyOptions);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeCount = [filter.format, filter.camera, filter.iso_min, filter.iso_max, filter.aperture_min, filter.aperture_max, filter.exposure_time, filter.orientation_kind, filter.rating_min, filter.rating_max, filter.has_gps, filter.has_favorite].filter((value) => value != null && value !== "").length;

  const optionsFilter = useMemo(() => ({
    ...filter,
    format: undefined, camera: undefined,
    iso_min: undefined, iso_max: undefined,
    aperture_min: undefined, aperture_max: undefined,
    exposure_time: undefined, orientation_kind: undefined,
    rating_min: undefined, rating_max: undefined,
  }), [filter]);

  useEffect(() => {
    if (!open) return;
    api.getPhotoFilterOptions(optionsFilter).then(setOptions).catch(console.error);
  }, [open, optionsFilter]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const number = (value: string) => value === "" ? undefined : Number(value);
  const clear = () => setFilter({ format: undefined, camera: undefined, iso_min: undefined, iso_max: undefined, aperture_min: undefined, aperture_max: undefined, exposure_time: undefined, orientation_kind: undefined, rating_min: undefined, rating_max: undefined, has_gps: undefined, has_favorite: undefined });

  return (
    <div ref={rootRef} className="photo-toolbar-anchor relative">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className={activeCount ? "ui-button-primary" : "ui-button"}>
        <Icon name="filter" size={14} />EXIF 筛选{activeCount ? ` (${activeCount})` : ""}
      </button>
      {open && (
        <div className="photo-toolbar-popover absolute right-0 top-full z-50 mt-2 w-[360px] max-h-[70vh] overflow-y-auto rounded-2xl border border-surface-secondary bg-bg-secondary p-4 shadow-2xl">
          <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">照片筛选</h3><button type="button" onClick={clear} className="text-xs text-accent-link">全部清除</button></div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
            <label className="col-span-1">格式<select value={filter.format ?? ""} onChange={(e) => setFilter({ format: e.target.value || undefined })} className="ui-select mt-1 w-full"><option value="">全部格式</option>{options.formats.map((item) => <option key={item.value} value={item.value}>{item.value.toUpperCase()} ({item.count})</option>)}</select></label>
            <label className="col-span-1">相机<select value={filter.camera ?? ""} onChange={(e) => setFilter({ camera: e.target.value || undefined })} className="ui-select mt-1 w-full"><option value="">全部相机</option>{options.cameras.map((item) => <option key={item.value} value={item.value}>{item.value} ({item.count})</option>)}</select></label>
            <label>ISO 最小<input type="number" value={filter.iso_min ?? ""} placeholder={options.iso_min?.toString() ?? ""} onChange={(e) => setFilter({ iso_min: number(e.target.value) })} className="ui-input mt-1 w-full" /></label>
            <label>ISO 最大<input type="number" value={filter.iso_max ?? ""} placeholder={options.iso_max?.toString() ?? ""} onChange={(e) => setFilter({ iso_max: number(e.target.value) })} className="ui-input mt-1 w-full" /></label>
            <label>光圈最小<input type="number" step="0.1" value={filter.aperture_min ?? ""} placeholder={options.aperture_min?.toString() ?? ""} onChange={(e) => setFilter({ aperture_min: number(e.target.value) })} className="ui-input mt-1 w-full" /></label>
            <label>光圈最大<input type="number" step="0.1" value={filter.aperture_max ?? ""} placeholder={options.aperture_max?.toString() ?? ""} onChange={(e) => setFilter({ aperture_max: number(e.target.value) })} className="ui-input mt-1 w-full" /></label>
            <label>快门<select value={filter.exposure_time ?? ""} onChange={(e) => setFilter({ exposure_time: e.target.value || undefined })} className="ui-select mt-1 w-full"><option value="">不限</option>{options.exposure_times.map((item) => <option key={item.value} value={item.value}>{item.value}s ({item.count})</option>)}</select></label>
            <label>方向<select value={filter.orientation_kind ?? ""} onChange={(e) => setFilter({ orientation_kind: (e.target.value || undefined) as any })} className="ui-select mt-1 w-full"><option value="">不限</option><option value="landscape">横向</option><option value="portrait">纵向</option><option value="square">正方形</option></select></label>
            <label>星级至少<select value={filter.rating_min ?? ""} onChange={(e) => setFilter({ rating_min: number(e.target.value) })} className="ui-select mt-1 w-full"><option value="">不限</option>{[1,2,3,4,5].map((n) => <option key={n} value={n}>{n} 星及以上</option>)}</select></label>
            <label>星级至多<select value={filter.rating_max ?? ""} onChange={(e) => setFilter({ rating_max: number(e.target.value) })} className="ui-select mt-1 w-full"><option value="">不限</option>{[0,1,2,3,4,5].map((n) => <option key={n} value={n}>{n} 星</option>)}</select></label>
            <label>坐标<select value={filter.has_gps == null ? "" : String(filter.has_gps)} onChange={(e) => setFilter({ has_gps: e.target.value === "" ? undefined : e.target.value === "true" })} className="ui-select mt-1 w-full"><option value="">不限</option><option value="true">有 GPS</option><option value="false">无 GPS</option></select></label>
            <label>收藏<select value={filter.has_favorite == null ? "" : String(filter.has_favorite)} onChange={(e) => setFilter({ has_favorite: e.target.value === "" ? undefined : e.target.value === "true" })} className="ui-select mt-1 w-full"><option value="">不限</option><option value="true">已收藏</option><option value="false">未收藏</option></select></label>
          </div>
        </div>
      )}
    </div>
  );
});
