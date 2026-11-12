import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Link } from "react-router-dom";
import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import type { FaceCluster } from "../types";
import PhotoCard from "./PhotoCard";
import AlbumCoverCard, { AlbumCoverThumbnail, albumGridStyle } from "./AlbumCoverCard";
import Icon from "./Icon";

const PAGE_SIZE = 60;
const GROUP_PAGE_SIZE = 24;
const sizes = [[0, "全部合影"], [2, "双人"], [3, "三人"], [4, "四人及以上"]] as const;

function NamedGroupList({ size, personIds, exact, revision, hidden, onOpen }: {
  size: number;
  personIds: number[];
  exact: boolean;
  revision: number;
  hidden: boolean;
  onOpen: (group: api.NamedPhotoGroup) => void;
}) {
  const [groups, setGroups] = useState<api.NamedPhotoGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const faceDataRevision = useStore((state) => state.faceDataRevision);

  const load = useCallback(async (offset: number) => {
    const id = ++request.current;
    setLoading(true);
    setError("");
    try {
      const rows = await api.getNamedPhotoGroups(size, personIds, exact, offset);
      if (id !== request.current) return;
      setGroups((current) => offset === 0 ? rows : [...current, ...rows]);
      setMore(rows.length === GROUP_PAGE_SIZE);
    } catch (reason) {
      if (id === request.current) setError(String(reason));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [size, personIds, exact]);

  useEffect(() => {
    setGroups([]);
    setMore(false);
    list.current?.scrollTo?.(0, 0);
    void load(0);
    return () => { ++request.current; };
  }, [load, revision, faceDataRevision]);

  return <div ref={list} className="people-results" hidden={hidden}>
    {error && <p role="alert" className="mb-3 text-sm text-red-500">无法读取人物分组：{error}</p>}
    <div className="grid gap-[var(--ui-gap)]" style={albumGridStyle(216)}>
      {groups.map((group) => <AlbumCoverCard
        key={group.person_ids.join(",")}
        wide
        title={group.names.join("、")}
        badge={`${group.person_ids.length} 人`}
        description={`${group.photo_count.toLocaleString()} 张照片`}
        cover={<AlbumCoverThumbnail photoId={group.cover_photo_id} />}
        onOpen={() => onOpen(group)}
      />)}
    </div>
    {loading ? <p role="status" className="people-empty">正在整理人物分组…</p>
      : !groups.length && !error ? <p className="people-empty">{size || personIds.length
        ? "没有符合筛选条件的人物分组。"
        : "暂无人物分组。为同一张合影中的所有人物命名后，这里会自动分组。"}</p>
      : more && <div className="py-4 text-center"><button type="button" className="ui-button" onClick={() => void load(groups.length)}>加载更多分组</button></div>}
  </div>;
}

export default function GroupPhotosView() {
  const [view, setView] = useState<"groups" | "photos">("groups");
  const [activeGroup, setActiveGroup] = useState<api.NamedPhotoGroup | null>(null);
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
  const showGroupList = view === "groups" && !activeGroup;
  const exactFilter = exact && personIds.length > 0;
  const groupTitle = activeGroup?.person_ids.map((id, index) =>
    people.find((person) => person.id === id)?.name?.trim() || activeGroup.names[index],
  ).join("、");
  const fetchPhotos = useCallback((cursor?: number) => activeGroup
    ? api.getGroupPhotos(0, activeGroup.person_ids, true, cursor, true)
    : api.getGroupPhotos(size, personIds, exactFilter, cursor), [activeGroup, size, personIds, exactFilter]);

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
    if (showGroupList) return;
    const id = ++request.current;
    setLoading(true); setItems([]); setMore(false); setError("");
    setSaveMessage(""); setSaveError("");
    list.current?.scrollTo?.(0, 0);
    fetchPhotos().then((rows) => {
      if (id === request.current) { setItems(rows); setMore(rows.length === PAGE_SIZE); }
    }).catch((reason) => {
      if (id === request.current) setError(String(reason));
    }).finally(() => { if (id === request.current) setLoading(false); });
    return () => { ++request.current; };
  }, [showGroupList, fetchPhotos, revision, faceDataRevision]);

  const loadMore = async () => {
    const cursor = items[items.length - 1]?.photo.id;
    if (loading || !more || cursor == null) return;
    const id = ++request.current;
    setLoading(true); setError("");
    try {
      const rows = await fetchPhotos(cursor);
      if (id === request.current) { setItems((current) => [...current, ...rows]); setMore(rows.length === PAGE_SIZE); }
    } catch (reason) {
      if (id === request.current) setError(String(reason));
    } finally { if (id === request.current) setLoading(false); }
  };

  return <>
    <div className="people-toolbar">
      <div className="ui-toolbar">
        {activeGroup ? <>
          <button type="button" className="ui-button shrink-0" onClick={() => setActiveGroup(null)}>返回分组</button>
          <h2 className="min-w-0 flex-1 text-sm font-semibold [overflow-wrap:anywhere]">{groupTitle}</h2>
        </> : <>
          <div className="ui-segments" role="group" aria-label="合影查看方式">
            <button type="button" className="ui-segment" aria-pressed={view === "groups"} onClick={() => setView("groups")} title="按已命名人物的组合分组">人物分组</button>
            <button type="button" className="ui-segment" aria-pressed={view === "photos"} onClick={() => setView("photos")}>合影列表</button>
          </div>
          <div className="ui-segments max-w-full overflow-x-auto" role="group" aria-label="按人数筛选">
            {sizes.map(([value, label]) => <button type="button" key={value} aria-pressed={size === value} onClick={() => setSize(value)} className="ui-segment">{showGroupList && value === 0 ? "不限人数" : label}</button>)}
          </div>
          <select className="ui-select shrink-0" aria-label="按人物筛选" value="" disabled={saving || personIds.length >= 20} onChange={(e) => { if (e.target.value) setPersonIds((ids) => [...ids, Number(e.target.value)]); }}>
            <option value="">{people.length ? "按人物筛选" : "暂无可筛选的已命名人物"}</option>
            {people.filter((person) => !personIds.includes(person.id!)).map((person) => <option key={person.id} value={person.id!}>{person.name}</option>)}
          </select>
        </>}
        <button type="button" aria-label="刷新合影" title="刷新合影" className="ui-button ui-icon-button ml-auto" onClick={() => setRevision((value) => value + 1)}><Icon name="retry" size={15} /></button>
      </div>
      {!activeGroup && personIds.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-2">
        {personIds.map((id) => <button key={id} className="ui-button" disabled={saving} onClick={() => setPersonIds((ids) => ids.filter((value) => value !== id))} aria-label={`移除 ${people.find((person) => person.id === id)?.name ?? id}`}>{people.find((person) => person.id === id)?.name ?? `人物 ${id}`} ×</button>)}
        <label className="flex items-center gap-1.5 text-xs" title="照片不能有其他人或身份待确认的人脸"><input type="checkbox" disabled={saving} checked={exact} onChange={(e) => setExact(e.target.checked)} />仅包含所选人物</label>
      </div>}
      {!activeGroup && peopleError && <p role="alert" className="text-sm text-red-500">{peopleError}</p>}
      {view === "photos" && personIds.length >= 2 && <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={async (event) => {
        event.preventDefault();
        if (!name.trim() || saving) return;
        setSaving(true); setSaveMessage(""); setSaveError("");
        try {
          await api.createPersonCombination(name.trim(), personIds, exact);
          setName(""); setSaveMessage("已保存。");
        } catch (reason) { setSaveError(String(reason)); }
        finally { setSaving(false); }
      }}>
        <input className="ui-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="人物组合相册名称" placeholder="输入相册名称" />
        <button className="ui-button text-accent-link" disabled={saving || !name.trim()}>保存为人物组合相册</button>
        <span className="text-xs text-text-secondary">相册按人物组合匹配，不保存上方人数筛选。</span>
      </form>}
      {view === "photos" && saveMessage && <p className="text-sm text-accent-link" role="status">{saveMessage} <Link className="underline" to="/albums">打开相册</Link></p>}
      {view === "photos" && saveError && <p className="text-sm text-red-500" role="alert">{saveError}</p>}
    </div>
    {view === "groups" && <NamedGroupList size={size} personIds={personIds} exact={exactFilter} revision={revision} hidden={!!activeGroup} onOpen={setActiveGroup} />}
    {!showGroupList && <div ref={list} className="people-results">
      {error && <p className="mb-3 text-sm text-red-500" role="alert">无法读取合影：{error}</p>}
      <div className="people-grid">
        {items.map(({ photo, people_count, unconfirmed_count }) => <article key={photo.id} className="people-card rounded-xl border border-surface-secondary/70 bg-bg-secondary">
          <div className="aspect-square overflow-hidden rounded-lg">
            <PhotoCard photo={photo} showFilename={false} isSelected={selectedPhotoId === photo.id} onClick={() => setSelectedPhotoId(photo.id!)} onDoubleClick={() => setLightboxPhotoId(photo.id!)} />
          </div>
          <p className="mt-1.5 truncate px-1 text-sm font-medium" title={photo.filename}>{photo.filename}</p>
          <p className="px-1 text-xs text-text-muted">{people_count} 人{unconfirmed_count > 0 && ` · ${unconfirmed_count} 人待确认`}</p>
        </article>)}
      </div>
      {loading ? <p role="status" className="people-empty">正在查找合影…</p>
        : !items.length && !error ? <p className="people-empty">没有符合条件的合影。可以调整筛选，或等人物分析完成后刷新。</p>
        : more && <div className="py-4 text-center"><button className="ui-button" onClick={() => void loadMore()}>加载更多</button></div>}
    </div>}
  </>;
}
