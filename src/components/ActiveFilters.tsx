import { useEffect, useState } from "react";
import { useStore } from "../hooks/usePhotos";
import * as api from "../api/tauri";
import type { PhotoFilter } from "../types";

export default function ActiveFilters() {
  const filter = useStore((state) => state.filter);
  const setFilter = useStore((state) => state.setFilter);
  const clear = useStore((state) => state.clearPhotoFilters);
  const faceDataRevision = useStore((state) => state.faceDataRevision);
  const [person, setPerson] = useState<{ id: number; name: string } | null>(null);
  useEffect(() => {
    if (filter.person_id == null) return;
    let live = true;
    const id = filter.person_id;
    api.getClusters().then((clusters) => {
      if (live) setPerson({ id, name: clusters.find((item) => item.id === id)?.name || "未命名人物" });
    }).catch(() => { if (live) setPerson({ id, name: "指定人物" }); });
    return () => { live = false; };
  }, [filter.person_id, faceDataRevision]);
  const chips: { label: string; keys: (keyof PhotoFilter)[] }[] = [];
  const add = (label: string, ...keys: (keyof PhotoFilter)[]) => chips.push({ label, keys });
  if (filter.directory) add(`文件夹：${filter.directory.split(/[\\/]/).filter(Boolean).pop()}`, "directory");
  if (filter.keyword) add(`搜索：${filter.keyword}`, "keyword");
  if (filter.tag) add(`标签：${filter.tag}`, "tag");
  if (filter.person_id != null) add(`人物：${person?.id === filter.person_id ? person.name : "正在读取…"}`, "person_id");
  if (filter.year || filter.month) add(`${filter.year ? `${filter.year}年` : ""}${filter.month ? `${filter.month}月` : ""}`, "year", "month");
  if (filter.has_gps != null) add(filter.has_gps ? "有定位" : "无定位", "has_gps");
  if (filter.has_favorite != null) add(filter.has_favorite ? "已收藏" : "未收藏", "has_favorite");
  if (filter.format) add(filter.format.toUpperCase(), "format");
  if (filter.camera) add(filter.camera, "camera");
  if (filter.exposure_time) add(`快门 ${filter.exposure_time}s`, "exposure_time");
  if (filter.orientation_kind) add({ landscape: "横向", portrait: "竖向", square: "正方形" }[filter.orientation_kind], "orientation_kind");
  const range = (name: string, low: keyof PhotoFilter, high: keyof PhotoFilter) => {
    if (filter[low] != null || filter[high] != null) add(`${name} ${filter[low] ?? "不限"}–${filter[high] ?? "不限"}`, low, high);
  };
  range("ISO", "iso_min", "iso_max");
  range("光圈", "aperture_min", "aperture_max");
  range("星级", "rating_min", "rating_max");
  if (!chips.length) return null;
  return <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-surface-secondary pt-2" aria-label="当前筛选条件">
    {chips.map(({ label, keys }) => <button key={keys.join("/")} type="button" title={`移除${label}`} aria-label={`移除${label}`} className="flex max-w-full items-center gap-2 rounded-full border border-accent-primary/25 bg-accent-primary/10 px-2.5 py-1 text-xs text-text-primary" onClick={() => setFilter(Object.fromEntries(keys.map((key) => [key, undefined])))}><span className="truncate">{label}</span><span aria-hidden="true">×</span></button>)}
    <button type="button" className="px-2 py-1 text-xs text-accent-link hover:underline" onClick={clear}>清除全部筛选</button>
  </div>;
}
