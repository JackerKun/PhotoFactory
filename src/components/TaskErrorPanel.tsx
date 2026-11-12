import { useEffect, useState } from "react";
import {
  getIgnoredTaskPhotos, getTaskErrorPhotos, getTaskErrors, ignoreTaskErrorPhotos, restoreTaskPhoto,
  type IgnoredTaskPhotos, type TaskErrorGroup, type TaskErrorGroupPhotos, type TaskErrorPage,
} from "../api/tauri";
import Icon from "./Icon";

export interface CurrentTaskError {
  label: string;
  message: string;
}

function errorTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString();
}

async function copyReport(report: string) {
  try {
    await navigator.clipboard.writeText(report);
    return;
  } catch {
    // Some desktop WebViews do not expose the asynchronous Clipboard API.
  }
  const focused = document.activeElement;
  const field = document.createElement("textarea");
  field.value = report;
  field.setAttribute("readonly", "");
  field.style.cssText = "position:fixed;left:-9999px;top:0";
  (document.querySelector("dialog[open]") ?? document.body).appendChild(field);
  field.select();
  try {
    if (!document.execCommand("copy")) throw new Error("Clipboard unavailable");
  } finally {
    field.remove();
    if (focused instanceof HTMLElement) focused.focus();
  }
}

function groupId(group: TaskErrorGroup) {
  return JSON.stringify([group.key.stage, group.key.reason]);
}

export default function TaskErrorPanel({ projectPath, current, stages, runtime }: {
  projectPath?: string;
  current: CurrentTaskError[];
  stages: Record<string, string>;
  runtime: string;
}) {
  const [page, setPage] = useState<TaskErrorPage | null>(null);
  const [stage, setStage] = useState("");
  const [before, setBefore] = useState<number | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [groupPhotos, setGroupPhotos] = useState<TaskErrorGroupPhotos | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const [ignoredPhotos, setIgnoredPhotos] = useState<IgnoredTaskPhotos | null>(null);
  const [ignoredOffset, setIgnoredOffset] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!projectPath) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const result = await getTaskErrors(stage || null, before);
        if (live) { setPage(result); setLoadError(""); }
      } catch (error) {
        if (live) setLoadError(String(error));
      }
      if (live && before == null) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [projectPath, stage, before, refresh]);

  const openKey = page?.groups.find((group) => groupId(group) === selectedGroup)?.key;
  const openStage = openKey?.stage;
  const openReason = openKey?.reason;
  const openThrough = openKey?.through;
  useEffect(() => {
    if (!projectPath || showIgnored || openStage == null || openReason == null || openThrough == null) return;
    let live = true;
    setDetailError("");
    getTaskErrorPhotos({ stage: openStage, reason: openReason, through: openThrough }, after)
      .then((result) => { if (live) setGroupPhotos(result); })
      .catch((error) => { if (live) setDetailError(String(error)); });
    return () => { live = false; };
  }, [projectPath, showIgnored, openStage, openReason, openThrough, after, refresh]);

  useEffect(() => {
    if (!projectPath || !showIgnored) return;
    let live = true;
    setDetailError("");
    getIgnoredTaskPhotos(ignoredOffset)
      .then((result) => { if (live) setIgnoredPhotos(result); })
      .catch((error) => { if (live) setDetailError(String(error)); });
    return () => { live = false; };
  }, [projectPath, showIgnored, ignoredOffset, refresh]);

  const groups = page?.groups ?? [];
  const stageLabel = (value: string) => stages[value] ?? value;
  const platform = page ? `PhotoFactory ${page.version} · ${page.platform} ${page.architecture}` : "PhotoFactory";
  const failureCounts = page
    ? `人脸失败 ${page.failed_faces} · 分类失败 ${page.failed_classifications} · 有错误记录的待重试任务 ${page.retryable} · 已忽略 ${page.ignored_count}`
    : "";

  function changePage(cursor: number | null) {
    setPage(null);
    setSelectedGroup(null);
    setGroupPhotos(null);
    setAfter(null);
    setActionMessage("");
    setLoadError("");
    setBefore(cursor);
  }

  function toggleGroup(group: TaskErrorGroup) {
    const id = groupId(group);
    setSelectedGroup(selectedGroup === id ? null : id);
    setGroupPhotos(null);
    setAfter(null);
    setDetailError("");
  }

  async function act(operation: () => Promise<number>, success: (count: number) => string) {
    setBusy(true);
    setActionError("");
    setActionMessage("");
    try {
      const count = await operation();
      setActionMessage(count ? success(count) : "没有需要更新的照片");
      if (showIgnored) setIgnoredOffset(0);
      setRefresh((value) => value + 1);
    } catch (error) {
      setActionError(String(error));
    } finally {
      setBusy(false);
    }
  }

  function ignore(group: TaskErrorGroup, photoId: number | null) {
    if (!projectPath) return;
    void act(() => ignoreTaskErrorPhotos(projectPath, group.key, photoId), (count) => `已忽略 ${count} 张照片的${stageLabel(group.key.stage)}任务`);
  }

  function restore(taskStage: string, photoId: number) {
    if (!projectPath) return;
    void act(() => restoreTaskPhoto(projectPath, taskStage, photoId), () => "已取消忽略，可重新处理这张照片");
  }

  async function copy() {
    const report = [platform, runtime, failureCounts, ...current.map(({ label, message }) => `${label}\n${message}`),
      ...groups.map((group) => [
        `${errorTime(group.occurred_at)} · ${stageLabel(group.key.stage)} · ${group.occurrences} 条记录`,
        group.message,
        ...(groupId(group) === selectedGroup ? groupPhotos?.photos ?? [] : []).map((photo) =>
          `${photo.filename}${photo.attempts == null ? "" : `（第 ${photo.attempts} 次尝试）`}\n${photo.path}`),
      ].join("\n")),
    ].filter(Boolean).join("\n\n");
    try {
      await copyReport(report);
      setActionMessage("已复制本页诊断");
    } catch {
      setActionMessage("复制失败，可以选中下方文字手动复制");
    }
  }

  return <section aria-labelledby="task-error-title" className="task-column">
    <h3 id="task-error-title" className="task-column-title px-1 text-sm font-semibold">错误与诊断</h3>
    <div className="task-card">
      <header className="task-card-padding ui-toolbar min-h-[var(--ui-control-height)] justify-between border-b border-surface-secondary">
        {page && <p className="text-xs text-text-secondary">{platform}</p>}
        {!showIgnored && <button type="button" className="ui-button" disabled={!current.length && !groups.length} onClick={() => void copy()}>复制本页诊断</button>}
      </header>
      <div className="task-card-padding space-y-[var(--ui-gap)]">
        {page && <p className="rounded-lg bg-surface-primary px-3 py-2 text-xs text-text-secondary">{failureCounts}</p>}
        {current.length > 0 && <details className="group rounded-lg border border-surface-secondary">
          <summary className="ui-button w-full cursor-pointer list-none justify-between border-0">
            当前提示（{current.length}）
            <Icon name="chevronUp" size={14} className="rotate-180 group-open:rotate-0" />
          </summary>
          <ul className="max-h-52 space-y-2 overflow-auto border-t border-surface-secondary px-3 py-2 text-xs">
            {current.map(({ label, message }) => <li key={label}>
              <p className="font-medium text-text-primary">{label}</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-red-500">{message}</p>
            </li>)}
          </ul>
        </details>}
        <div className="ui-toolbar justify-between">
          <div className="ui-segments" role="group" aria-label="诊断视图">
            <button type="button" className="ui-segment" aria-pressed={!showIgnored} onClick={() => { setShowIgnored(false); setDetailError(""); }}>错误分组</button>
            <button type="button" className="ui-segment" aria-pressed={showIgnored} onClick={() => { setShowIgnored(true); setDetailError(""); }}>已忽略照片</button>
          </div>
          {!showIgnored && <select aria-label="按任务筛选" className="ui-select max-w-full"
            value={stage} onChange={(event) => { setStage(event.target.value); changePage(null); }}>
            <option value="">全部任务</option>
            {page?.stages.map((value) => <option key={value} value={value}>{stageLabel(value)}</option>)}
          </select>}
        </div>
        {actionMessage && <p role="status" className="text-sm text-text-secondary">{actionMessage}</p>}
        {actionError && <p role="alert" className="break-words text-sm text-red-500">{actionError}</p>}
        {(loadError || detailError) && <div role="alert" className="space-y-2 text-sm text-red-500">
          <p className="break-words">无法读取记录：{loadError || detailError}</p>
          <button type="button" className="ui-button" onClick={() => setRefresh((value) => value + 1)}>重新读取记录</button>
        </div>}
        {!projectPath && <p className="text-sm text-text-secondary">打开照片库后可查看错误记录</p>}
        {projectPath && !showIgnored && <>
          {!loadError && !page && <p className="text-sm text-text-secondary">正在读取错误记录…</p>}
          {page && !groups.length && <p className="rounded-lg border border-dashed border-surface-secondary p-4 text-sm text-text-secondary">此任务暂无错误记录</p>}
          {before != null && <button type="button" className="ui-button" onClick={() => changePage(null)}>返回最新分组</button>}
          <ol className="space-y-2">
            {groups.map((group) => {
              const id = groupId(group);
              const expanded = selectedGroup === id;
              return <li key={id} className="min-w-0 rounded-xl border border-surface-secondary">
                <button type="button" aria-expanded={expanded} onClick={() => toggleGroup(group)}
                  className="block w-full rounded-xl px-3 py-2.5 text-left hover:bg-surface-primary">
                  <span className="flex flex-wrap items-center justify-between gap-x-2 text-sm font-medium">
                    <span>{expanded ? "▾" : "▸"} {stageLabel(group.key.stage)} · {group.occurrences} 条记录</span>
                    <time className="text-xs font-normal tabular-nums text-text-secondary" dateTime={new Date(group.occurred_at * 1000).toISOString()}>{errorTime(group.occurred_at)}</time>
                  </span>
                  <span className="mt-1 block truncate text-xs text-text-secondary" title={group.key.reason}>{group.key.reason}</span>
                </button>
                {expanded && <div className="space-y-2 border-t border-surface-secondary px-3 py-2.5">
                  <p className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-text-secondary">{group.message}</p>
                  {!groupPhotos && !detailError && <p className="text-xs text-text-secondary">正在读取涉及照片…</p>}
                  {groupPhotos && <>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span>涉及照片（{groupPhotos.total} 张）</span>
                      {groupPhotos.can_ignore > 0 && <button type="button" disabled={busy} className="ui-button" onClick={() => ignore(group, null)}>
                        忽略本组失败照片（{groupPhotos.can_ignore} 张）
                      </button>}
                    </div>
                    <ul className="max-h-64 divide-y divide-surface-secondary overflow-auto text-xs">
                      {groupPhotos.photos.map((photo) => <li key={photo.path} className="flex items-center justify-between gap-2 py-2">
                        <div className="min-w-0">
                          <div className="break-words font-medium">{photo.filename}{photo.attempts != null && <span className="ml-2 font-normal text-text-secondary">第 {photo.attempts} 次尝试</span>}</div>
                          <div className="break-all text-text-secondary">{photo.path}</div>
                        </div>
                        {photo.photo_id != null && photo.ignored && <span className="shrink-0 text-text-secondary">已忽略</span>}
                        {photo.photo_id != null && photo.can_ignore && <button type="button" aria-label={`忽略 ${photo.filename}`} disabled={busy}
                          className="ui-button shrink-0" onClick={() => ignore(group, photo.photo_id)}>忽略</button>}
                      </li>)}
                    </ul>
                    <div className="flex flex-wrap gap-2">
                      {after != null && <button type="button" className="ui-button" onClick={() => { setGroupPhotos(null); setAfter(null); }}>返回首批</button>}
                      {groupPhotos.next_after != null && <button type="button" className="ui-button" onClick={() => { setAfter(groupPhotos.next_after); setGroupPhotos(null); }}>下一批照片</button>}
                    </div>
                  </>}
                </div>}
              </li>;
            })}
          </ol>
          {page?.next_before != null && <button type="button" className="ui-button w-full" onClick={() => changePage(page.next_before)}>查看更早的分组</button>}
        </>}
        {projectPath && showIgnored && <>
          {!ignoredPhotos && !detailError && <p className="text-sm text-text-secondary">正在读取已忽略的照片…</p>}
          {ignoredPhotos && !ignoredPhotos.photos.length && <p className="text-sm text-text-secondary">暂无已忽略的照片</p>}
          <ul className="divide-y divide-surface-secondary text-xs">
            {ignoredPhotos?.photos.map((photo) => <li key={`${photo.stage}:${photo.photo_id}`} className="flex items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="break-words font-medium">{photo.filename} · {stageLabel(photo.stage)}</p>
                <p className="break-all text-text-secondary">{photo.path}</p>
              </div>
              <button type="button" disabled={busy} aria-label={`取消忽略 ${photo.filename}的${stageLabel(photo.stage)}`}
                className="ui-button shrink-0" onClick={() => restore(photo.stage, photo.photo_id)}>取消忽略</button>
            </li>)}
          </ul>
          <div className="flex gap-2">
            {ignoredOffset > 0 && <button type="button" className="ui-button" onClick={() => { setIgnoredPhotos(null); setIgnoredOffset(0); }}>返回首批</button>}
            {ignoredPhotos?.next_offset != null && <button type="button" className="ui-button"
              onClick={() => { setIgnoredOffset(ignoredPhotos.next_offset!); setIgnoredPhotos(null); }}>下一批照片</button>}
          </div>
        </>}
      </div>
    </div>
  </section>;
}
