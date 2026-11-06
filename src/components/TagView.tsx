import React, { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../api/tauri";
import type { ManualTag } from "../types";
import { useStore } from "../hooks/usePhotos";
import AiStatusIndicator from "./AiStatusIndicator";

interface Props { onSelectTag: (label: string) => void }
type TagLayout = "cards" | "palette" | "compact";
type TagMode = "smart" | "editable";

const colors = ["#5B8DEF", "#34C759", "#FF9F0A", "#FF453A", "#AF52DE", "#00A7A5", "#8E8E93", "#D17B49"];
const layoutOptions: { id: TagLayout; label: string; icon: string }[] = [
  { id: "cards", label: "卡片", icon: "▦" },
  { id: "palette", label: "色板", icon: "●" },
  { id: "compact", label: "列表", icon: "☰" },
];
const categoryIcons: Record<string, string> = {
  "人物": "👤", "活动": "🏃", "动物": "🐾", "食物": "🍽️", "交通": "🚙", "物品": "📦",
  "自然": "🌿", "天气": "☀️", "建筑": "🏛️", "场景": "🖼️", "地点": "📍", "时间": "🕐",
  "事件": "🎉", "设备": "📷", "色彩与氛围": "🎨", "其他": "🏷️",
};
const sourceNames: Record<string, string> = {
  ai_semantic: "语义", ai_scene: "场景", geo_location: "地点", time_period: "时间",
  event: "事件", device: "设备", tone: "色彩", rule_tone: "规则", rule_time_period: "规则",
  rule_season: "规则", rule_face_count: "规则", rule_weather: "规则", rule: "规则",
};

export default React.memo(function TagView({ onSelectTag }: Props) {
  const [tags, setTags] = useState<ManualTag[]>([]);
  const [aiGroups, setAiGroups] = useState<api.AiTagGroup[]>([]);
  const [mode, setMode] = useState<TagMode>("smart");
  const [query, setQuery] = useState("");
  const [reliableOnly, setReliableOnly] = useState(true);
  const [layout, setLayout] = useState<TagLayout>(() => (localStorage.getItem("pf-manual-tag-layout") as TagLayout) || "cards");
  const [editing, setEditing] = useState<ManualTag | "new" | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState(colors[0]);
  const [saving, setSaving] = useState(false);
  const [aiStarting, setAiStarting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const aiStage = useStore((state) => state.aiProcessingStatus?.stage);

  const refresh = useCallback(async () => {
    const [nextTags, nextGroups] = await Promise.all([api.getManualTags(), api.getAiTagGroups()]);
    setTags(nextTags);
    setAiGroups(nextGroups);
  }, []);
  useEffect(() => { refresh().catch((error) => setMessage(String(error))); }, [refresh]);
  useEffect(() => {
    if (aiStage === "done") refresh().catch((error) => setMessage(String(error)));
  }, [aiStage, refresh]);

  const filteredGroups = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return aiGroups
      .map((group) => ({
        ...group,
        labels: group.labels.filter((label) => {
          const threshold = label.source === "ai_scene" ? 0.12 : label.source === "ai_semantic" ? 0.30 : 0;
          return (!reliableOnly || label.average_confidence >= threshold)
            && (!keyword || label.label.toLocaleLowerCase().includes(keyword) || group.category.toLocaleLowerCase().includes(keyword));
        }),
      }))
      .filter((group) => group.labels.length > 0);
  }, [aiGroups, query, reliableOnly]);
  const smartLabelCount = aiGroups.reduce((count, group) => count + group.labels.length, 0);

  const openCreate = () => { setEditing("new"); setName(""); setColor(colors[tags.length % colors.length]); };
  const openEdit = (tag: ManualTag) => { setEditing(tag); setName(tag.name); setColor(tag.color); };
  const changeLayout = (next: TagLayout) => { setLayout(next); localStorage.setItem("pf-manual-tag-layout", next); };

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (editing === "new") await api.createManualTag(name.trim(), color);
      else if (editing) await api.updateManualTag(editing.id, name.trim(), color);
      await refresh();
      setEditing(null);
    } catch (error) {
      setMessage(`保存标签失败：${String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (tag: ManualTag) => {
    if (!window.confirm(`删除标签“${tag.name}”？照片不会被删除。`)) return;
    try {
      await api.deleteManualTag(tag.id);
      await refresh();
    } catch (error) {
      setMessage(`删除标签失败：${String(error)}`);
    }
  };

  const calculateAiTags = async () => {
    if (aiStarting) return;
    setAiStarting(true);
    setMessage(null);
    try {
      await api.recalculateAiTags();
    } catch (error) {
      setMessage(`AI 标签分析启动失败：${String(error)}`);
    } finally {
      setAiStarting(false);
    }
  };

  const tagActions = (tag: ManualTag) => (
    <div className="flex items-center gap-1">
      <button onClick={(event) => { event.stopPropagation(); openEdit(tag); }} className="h-8 w-8 rounded-full hover:bg-black/[0.06] text-text-muted" title="编辑标签" aria-label="编辑标签">
        <svg className="mx-auto" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="m13.5 7.5 3 3"/></svg>
      </button>
      <button onClick={(event) => { event.stopPropagation(); remove(tag); }} className="h-8 w-8 rounded-full hover:bg-red-50 text-text-muted hover:text-red-500" title="删除标签" aria-label="删除标签">
        <svg className="mx-auto" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></svg>
      </button>
    </div>
  );

  return (
    <div className="h-full overflow-y-auto px-8 py-7">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">标签</h2>
          <p className="text-sm text-text-muted mt-1">{mode === "smart" ? `按内容与来源整理 · ${smartLabelCount} 个智能标签` : `可以自由增删改查 · ${tags.length} 个可编辑标签`}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex p-1 rounded-xl bg-black/[0.045]">
            <button onClick={() => setMode("smart")} className={`h-8 rounded-lg px-3 text-sm ${mode === "smart" ? "bg-white shadow-sm" : "text-text-muted"}`}>智能分类</button>
            <button onClick={() => setMode("editable")} className={`h-8 rounded-lg px-3 text-sm ${mode === "editable" ? "bg-white shadow-sm" : "text-text-muted"}`}>可编辑标签</button>
          </div>
          {mode === "editable" && <div className="flex p-1 rounded-xl bg-black/[0.045]">{layoutOptions.map((option) => <button key={option.id} onClick={() => changeLayout(option.id)} title={`${option.label}布局`} className={`h-8 min-w-9 px-2 rounded-lg text-sm ${layout === option.id ? "bg-white shadow-sm" : "text-text-muted hover:text-text-primary"}`}>{option.icon}</button>)}</div>}
          <button onClick={calculateAiTags} disabled={aiStarting || (!!aiStage && aiStage !== "done" && aiStage !== "error")} className="rounded-xl bg-white/80 border border-black/[0.07] px-4 py-2 text-sm font-medium shadow-sm hover:bg-white disabled:opacity-50">{aiStarting ? "启动中…" : "✦ AI 计算标签"}</button>
          {mode === "editable" && <button onClick={openCreate} className="rounded-xl bg-accent-primary text-white px-4 py-2 text-sm font-medium shadow-sm hover:brightness-105">＋ 新建标签</button>}
        </div>
      </div>

      <AiStatusIndicator />

      {message && <div className="mb-4 flex justify-between rounded-xl bg-red-50 border border-red-100 px-4 py-2.5 text-sm text-red-600"><span>{message}</span><button onClick={() => setMessage(null)}>关闭</button></div>}

      {mode === "smart" && <>
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-black/[0.055] bg-white/65 p-3 shadow-sm">
          <input value={query} onChange={(event) => setQuery(event.target.value)} className="h-9 min-w-[240px] flex-1 rounded-xl border border-black/10 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-accent-primary/25" placeholder="搜索智能标签或分类…" />
          <label className="flex items-center gap-2 rounded-xl bg-black/[0.035] px-3 py-2 text-sm text-text-secondary"><input type="checkbox" checked={reliableOnly} onChange={(event) => setReliableOnly(event.target.checked)} />只显示可靠结果</label>
        </div>
        <div className="space-y-5">
          {filteredGroups.map((group) => <section key={group.category} className="rounded-2xl border border-black/[0.055] bg-white/65 p-4 shadow-sm">
            <div className="mb-3 flex items-center gap-2"><span className="text-xl">{categoryIcons[group.category] || "🏷️"}</span><h3 className="font-semibold">{group.category}</h3><span className="text-xs text-text-muted">{group.labels.length} 个标签</span></div>
            <div className="flex flex-wrap gap-2">
              {group.labels.map((label) => <button key={`${label.source}-${label.label}`} onClick={() => onSelectTag(label.label)} className="rounded-xl border border-black/[0.06] bg-white px-3 py-2 text-left shadow-sm hover:border-accent-primary/30 hover:shadow-md">
                <span className="flex items-center gap-2"><span className="text-sm font-medium">{label.label}</span><span className="rounded-full bg-accent-primary/8 px-1.5 py-0.5 text-[10px] text-accent-primary">{sourceNames[label.source] || label.source}</span></span>
                <span className="mt-1 block text-[11px] text-text-muted">{label.photo_count} 张 · 可信度 {Math.round(label.average_confidence * 100)}%</span>
              </button>)}
            </div>
          </section>)}
        </div>
        {filteredGroups.length === 0 && <div className="py-20 text-center text-text-muted">{smartLabelCount === 0 ? "还没有智能标签，点击右上角开始分析。" : "没有符合当前条件的标签。"}</div>}
      </>}

      {mode === "editable" && layout === "cards" && <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
        {tags.map((tag) => <div key={tag.id} className="group rounded-2xl bg-white/70 border border-black/[0.055] shadow-sm hover:shadow-md overflow-hidden">
          <button onClick={() => onSelectTag(tag.name)} className="w-full h-24 flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${tag.color}30, ${tag.color}0D)` }}>
            <span className="px-4 py-2 rounded-full text-sm font-semibold text-white shadow-sm" style={{ backgroundColor: tag.color }}>{tag.name}</span>
          </button>
          <div className="px-3 py-2 flex items-center justify-between"><button onClick={() => onSelectTag(tag.name)} className="text-left min-w-0"><p className="font-medium truncate">{tag.name}</p><p className="text-xs text-text-muted">{tag.photo_count} 张照片</p></button>{tagActions(tag)}</div>
        </div>)}
      </div>}

      {mode === "editable" && layout === "palette" && <div className="flex flex-wrap gap-3">
        {tags.map((tag) => <div key={tag.id} className="group flex items-center gap-2 rounded-full bg-white/75 border border-black/[0.055] pl-2 pr-1 py-1 shadow-sm"><button onClick={() => onSelectTag(tag.name)} className="flex items-center gap-2"><span className="w-5 h-5 rounded-full" style={{ backgroundColor: tag.color }} /><span className="text-sm font-medium">{tag.name}</span><span className="text-xs text-text-muted">{tag.photo_count}</span></button>{tagActions(tag)}</div>)}
      </div>}

      {mode === "editable" && layout === "compact" && <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        {tags.map((tag) => <div key={tag.id} className="flex items-center rounded-xl bg-white/60 border border-black/[0.045] px-3 py-2"><button onClick={() => onSelectTag(tag.name)} className="flex flex-1 items-center gap-3 text-left"><span className="w-3 h-3 rounded-full" style={{ backgroundColor: tag.color }} /><span className="font-medium text-sm">{tag.name}</span><span className="ml-auto text-xs text-text-muted">{tag.photo_count} 张</span></button>{tagActions(tag)}</div>)}
      </div>}

      {mode === "editable" && tags.length === 0 && <button onClick={calculateAiTags} className="w-full mt-12 rounded-2xl border-2 border-dashed border-black/10 py-16 text-center text-text-muted hover:border-accent-primary/40 hover:text-accent-primary"><span className="block text-3xl mb-2">✦</span>让 AI 为照片创建标签，也可以使用右上角手工新建</button>}

      {editing && <div className="fixed inset-0 z-[1200] bg-black/30 backdrop-blur-sm flex items-center justify-center" onMouseDown={() => !saving && setEditing(null)}>
        <div className="w-[380px] rounded-2xl bg-white p-5 shadow-2xl border border-black/10" onMouseDown={(event) => event.stopPropagation()}>
          <h3 className="text-lg font-semibold">{editing === "new" ? "新建标签" : "编辑标签"}</h3>
          <label className="block text-xs text-text-muted mt-4 mb-1.5">名称</label>
          <input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") save(); if (event.key === "Escape") setEditing(null); }} maxLength={40} className="w-full rounded-xl border border-black/10 bg-black/[0.035] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-accent-primary/30" placeholder="例如：精选、待修图、家人" autoFocus />
          <label className="block text-xs text-text-muted mt-4 mb-2">颜色</label>
          <div className="flex flex-wrap gap-2">{colors.map((value) => <button key={value} onClick={() => setColor(value)} className={`w-8 h-8 rounded-full transition-transform ${color === value ? "ring-2 ring-offset-2 ring-accent-primary scale-90" : "hover:scale-105"}`} style={{ backgroundColor: value }} aria-label={`选择颜色 ${value}`} />)}</div>
          <div className="mt-6 flex justify-end gap-2"><button disabled={saving} onClick={() => setEditing(null)} className="px-4 py-2 rounded-lg text-sm text-text-secondary hover:bg-black/5">取消</button><button disabled={saving || !name.trim()} onClick={save} className="px-4 py-2 rounded-lg bg-accent-primary text-white text-sm font-medium disabled:opacity-50">{saving ? "保存中…" : "保存"}</button></div>
        </div>
      </div>}
    </div>
  );
});
