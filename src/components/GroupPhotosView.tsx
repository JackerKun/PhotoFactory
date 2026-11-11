import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Link } from "react-router-dom";
import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import type { FaceCluster } from "../types";
import PhotoCard from "./PhotoCard";

const PAGE_SIZE = 60;
const sizes = [[0, "全部合影"], [2, "双人"], [3, "三人"], [4, "四人及以上"]] as const;

export default function GroupPhotosView({ onBack }: { onBack: () => void }) {
  const [size, setSize] = useState(0);
  const [personIds, setPersonIds] = useState<number[]>([]);
  const [people, setPeople] = useState<FaceCluster[]>([]);
  const [exact, setExact] = useState(false);
  const [items, setItems] = useState<api.GroupPhotoItem[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [peopleError, setPeopleError] = useState("");
  const [revision, setRevision] = useState(0);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const request = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const selectedPhotoId = useStore((s) => s.selectedPhotoId);
  const faceDataRevision = useStore((s) => s.faceDataRevision);
  const setSelectedPhotoId = useStore((s) => s.setSelectedPhotoId);
  const setLightboxPhotoId = useStore((s) => s.setLightboxPhotoId);

  useEffect(() => {
    let live = true;
    api.getClusters().then((rows) => {
      if (!live) return;
      setPeople(rows.filter((row) => row.name?.trim() && row.id != null)
        .sort((a, b) => a.name!.localeCompare(b.name!, "zh-CN")));
      setPeopleError("");
    }).catch(() => { if (live) setPeopleError("无法载入已命名人物，请刷新重试。"); });
    return () => { live = false; };
  }, [revision, faceDataRevision]);

  useEffect(() => {
    const unlisten = listen<{ stage?: string }>("ai_status_changed", ({ payload }) => {
      if (payload.stage === "clustering_done" || payload.stage === "done") setRevision((value) => value + 1);
    });
    return () => { void unlisten.then((stop) => stop()).catch(() => {}); };
  }, []);

  useEffect(() => {
    const id = ++request.current;
    setLoading(true); setItems([]); setMore(false); setError("");
    setSaveMessage(""); setSaveError("");
    list.current?.scrollTo?.(0, 0);
    api.getGroupPhotos(size, personIds, exact).then((rows) => {
      if (id === request.current) { setItems(rows); setMore(rows.length === PAGE_SIZE); }
    }).catch((reason) => {
      if (id === request.current) setError(String(reason));
    }).finally(() => { if (id === request.current) setLoading(false); });
    return () => { ++request.current; };
  }, [size, personIds, exact, revision, faceDataRevision]);

  const loadMore = async () => {
    const cursor = items[items.length - 1]?.photo.id;
    if (loading || !more || cursor == null) return;
    const id = ++request.current;
    setLoading(true); setError("");
    try {
      const rows = await api.getGroupPhotos(size, personIds, exact, cursor);
      if (id === request.current) { setItems((current) => [...current, ...rows]); setMore(rows.length === PAGE_SIZE); }
    } catch (reason) {
      if (id === request.current) setError(String(reason));
    } finally { if (id === request.current) setLoading(false); }
  };

  return <div className="flex h-full min-h-0 flex-col">
    <div className="space-y-3 border-b border-surface-secondary p-4">
      <div className="flex flex-wrap items-center gap-3">
        <button className="ui-button" onClick={onBack}>← 人物</button>
        <h2 className="flex-1 text-xl font-semibold">合影</h2>
        <button className="ui-button" onClick={() => setRevision((value) => value + 1)}>刷新</button>
      </div>
      <div className="flex flex-wrap gap-2" aria-label="按人数筛选">
        {sizes.map(([value, label]) => <button type="button" key={value} aria-pressed={size === value} onClick={() => setSize(value)} className={`ui-button ${size === value ? "text-accent-link ring-1 ring-accent-primary" : ""}`}>{label}</button>)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className="ui-button" aria-label="添加筛选人物" value="" disabled={saving || personIds.length >= 20} onChange={(e) => { if (e.target.value) setPersonIds((ids) => [...ids, Number(e.target.value)]); }}>
          <option value="">{people.length ? "＋ 添加已命名人物" : "暂无已命名人物"}</option>
          {people.filter((person) => !personIds.includes(person.id!)).map((person) => <option key={person.id} value={person.id!}>{person.name}</option>)}
        </select>
        {personIds.map((id) => <button key={id} className="ui-button" disabled={saving} onClick={() => setPersonIds((ids) => ids.filter((value) => value !== id))} aria-label={`移除 ${people.find((person) => person.id === id)?.name ?? id}`}>{people.find((person) => person.id === id)?.name ?? `人物 ${id}`} ×</button>)}
        {personIds.length > 0 && <label className="flex items-center gap-1 text-sm"><input type="checkbox" disabled={saving} checked={exact} onChange={(e) => setExact(e.target.checked)} />仅包含所选人物</label>}
      </div>
      {peopleError && <p role="alert" className="text-sm text-red-500">{peopleError}</p>}
      <p className="text-xs text-text-secondary">合影人数由 AI 估计；仅包含所选人物时，照片不能有其他人或身份待确认的人脸。</p>
      {personIds.length >= 2 && <form className="flex flex-wrap items-center gap-2" onSubmit={async (event) => {
        event.preventDefault();
        if (!name.trim() || saving) return;
        setSaving(true); setSaveMessage(""); setSaveError("");
        try {
          await api.createPersonCombination(name.trim(), personIds, exact);
          setName(""); setSaveMessage("已保存。");
        } catch (reason) { setSaveError(String(reason)); }
        finally { setSaving(false); }
      }}>
        <input className="ui-button bg-bg-secondary" value={name} onChange={(e) => setName(e.target.value)} aria-label="人物组合相册名称" placeholder="输入相册名称" />
        <button className="ui-button text-accent-link" disabled={saving || !name.trim()}>保存为人物组合相册</button>
        <span className="text-xs text-text-secondary">相册按人物组合匹配，不保存上方人数筛选。</span>
      </form>}
      {saveMessage && <p className="text-sm text-accent-link" role="status">{saveMessage} <Link className="underline" to="/albums">打开相册</Link></p>}
      {saveError && <p className="text-sm text-red-500" role="alert">{saveError}</p>}
    </div>
    <div ref={list} className="min-h-0 flex-1 overflow-auto p-4">
      {error && <p className="mb-3 text-sm text-red-500" role="alert">无法读取合影：{error}</p>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-3">
        {items.map(({ photo, people_count, unconfirmed_count }) => <article key={photo.id} className="min-w-0 overflow-hidden rounded-xl bg-surface-primary">
          <PhotoCard photo={photo} size={176} height={176} isSelected={selectedPhotoId === photo.id} onClick={() => setSelectedPhotoId(photo.id!)} onDoubleClick={() => setLightboxPhotoId(photo.id!)} />
          <div className="px-2 py-1.5 text-xs text-text-secondary">{people_count} 人{unconfirmed_count > 0 && ` · ${unconfirmed_count} 人待确认`}</div>
        </article>)}
      </div>
      {loading ? <p role="status" className="py-6 text-center text-sm text-text-secondary">正在查找合影…</p>
        : !items.length && !error ? <p className="py-10 text-center text-sm text-text-secondary">没有符合条件的合影。可以调整筛选，或等人物分析完成后刷新。</p>
        : more && <div className="py-4 text-center"><button className="ui-button" onClick={() => void loadMore()}>加载更多</button></div>}
    </div>
  </div>;
}
