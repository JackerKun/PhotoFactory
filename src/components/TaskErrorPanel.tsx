import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  clearTaskErrorHistory, getIgnoredTaskPhotos, getTaskErrorPhotos, getTaskErrors, ignoreTaskErrorPhotos, restoreTaskPhoto,
  checkAiPhoto, clearAiWorkerDiagnostics, getAiWorkerDiagnostics, startAiWorker,
  type AiWorkerDiagnostics, type IgnoredTaskPhotos, type TaskErrorGroup, type TaskErrorGroupPhotos, type TaskErrorPage,
} from "../api/tauri";
import Icon from "./Icon";

export interface CurrentTaskError {
  label: string;
  message: string;
  occurredAt?: number;
}

function errorTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

function ErrorTimestamp({ timestamp }: { timestamp: number }) {
  return <time className="tabular-nums" dateTime={new Date(timestamp * 1000).toISOString()}>{errorTime(timestamp)}</time>;
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

const workerStatuses: Record<AiWorkerDiagnostics["status"], string> = {
  idle: "尚未启动", starting: "正在启动", ready: "已就绪", exited: "进程已退出", failed: "启动失败",
};

const logSources: Record<AiWorkerDiagnostics["entries"][number]["source"], string> = {
  service: "服务", error: "错误", stdout: "标准输出", stderr: "标准错误", warning: "警告",
};

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
  const [clearThrough, setClearThrough] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [worker, setWorker] = useState<AiWorkerDiagnostics | null>(null);
  const [workerReadError, setWorkerReadError] = useState("");
  const [checkingWorker, setCheckingWorker] = useState(false);
  const [workerCheckResult, setWorkerCheckResult] = useState("");
  const [clearWorkerThrough, setClearWorkerThrough] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const result = await getAiWorkerDiagnostics();
        if (live) { setWorker(result); setWorkerReadError(""); }
      } catch (error) {
        if (live) setWorkerReadError(String(error));
      }
      if (live) timer = setTimeout(poll, 1500);
    }
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [refresh]);

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
  const appInfo = page ?? worker;
  const platform = appInfo ? `PhotoFactory ${appInfo.version} · ${appInfo.platform} ${appInfo.architecture}` : "PhotoFactory";
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

  async function act(operation: () => Promise<number>, success: (count: number) => string, empty = "没有需要更新的照片") {
    setBusy(true);
    setActionError("");
    setActionMessage("");
    try {
      const count = await operation();
      setActionMessage(count ? success(count) : empty);
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

  function clearHistory() {
    if (!projectPath || clearThrough == null) return;
    void act(async () => {
      const count = await clearTaskErrorHistory(projectPath, clearThrough);
      setClearThrough(null);
      changePage(null);
      return count;
    }, (count) => `已清空 ${count} 条历史错误记录`, "没有可清空的历史错误记录");
  }

  async function runWorkerCheck(withPhoto = false) {
    setCheckingWorker(true);
    setActionError("");
    setWorkerCheckResult("");
    try {
      if (withPhoto) {
        const path = await open({ title: "选择一张照片测试 AI", multiple: false });
        if (typeof path !== "string") return;
        const { faces, tags } = await checkAiPhoto(path);
        const faceResult = "Ok" in faces ? `人脸检测成功，找到 ${faces.Ok} 张人脸` : `人脸检测失败\n${faces.Err}`;
        const sceneResult = "Ok" in tags ? `场景分类成功，返回 ${tags.Ok} 个标签` : `场景分类失败\n${tags.Err}`;
        setWorkerCheckResult(`${faceResult}\n${sceneResult}`);
      } else {
        await startAiWorker(worker?.port);
        setWorkerCheckResult("本地 AI 服务已通过启动检查");
      }
    } catch (error) {
      setWorkerCheckResult(String(error));
    } finally {
      setCheckingWorker(false);
      setRefresh((value) => value + 1);
    }
  }

  const workerStatus = worker ? `${workerStatuses[worker.status]} · 127.0.0.1:${worker.port}${worker.pid ? ` · PID ${worker.pid}` : ""}` : "";
  const workerEntries = worker?.entries ?? [];
  const latestWorkerEntries = [...workerEntries].reverse();
  const lastWorkerError = latestWorkerEntries.find((entry) => entry.source === "error" || entry.source === "warning");

  function clearWorkerHistory() {
    if (clearWorkerThrough == null) return;
    void act(async () => {
      await clearAiWorkerDiagnostics(clearWorkerThrough);
      setClearWorkerThrough(null);
      return 1;
    }, () => "已清空 AI 服务日志");
  }

  async function copy() {
    const serviceReport = worker ? [
      `本地 AI 服务 · ${workerStatus}`,
      ...(worker.log_error ? [`日志文件错误\n${worker.log_error}`] : []),
      ...workerEntries.map((entry) =>
        `${errorTime(entry.occurred_at)} · ${logSources[entry.source]}${entry.pid ? ` · PID ${entry.pid}` : ""}\n${entry.message}`),
    ].join("\n\n") : workerReadError;
    const report = [platform, runtime, serviceReport, workerCheckResult, failureCounts, ...current.map(({ label, message, occurredAt }) =>
      `${occurredAt ? `${errorTime(occurredAt)} · ` : ""}${label}\n${message}`),
      ...groups.map((group) => [
        `${stageLabel(group.key.stage)} · ${group.occurrences} 条记录`,
        `首次 ${errorTime(group.first_occurred_at)} · 最近 ${errorTime(group.occurred_at)}`,
        group.message,
        ...(groupId(group) === selectedGroup ? groupPhotos?.photos ?? [] : []).map((photo) =>
          `${errorTime(photo.occurred_at)} · ${photo.filename}${photo.attempts == null ? "" : `（第 ${photo.attempts} 次尝试）`}\n${photo.path}`),
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
        {appInfo && <p className="text-xs text-text-secondary">{platform}</p>}
        {!showIgnored && <div className="ui-toolbar">
          <button type="button" className="ui-button" disabled={!worker && !workerReadError && !current.length && !groups.length} onClick={() => void copy()}>复制本页诊断</button>
          <button type="button" className="ui-button" disabled={busy || !page?.history_through}
            onClick={() => setClearThrough(page?.history_through ?? null)}>清空错误历史</button>
        </div>}
      </header>
      <div className="task-card-padding space-y-[var(--ui-gap)]">
        <section aria-label="本地 AI 服务" className="rounded-lg border border-surface-secondary p-3 text-xs">
          <div className="ui-toolbar justify-between">
            <div>
              <h4 className="text-sm font-medium">本地 AI 服务</h4>
              <p className="mt-1 text-text-secondary">{workerStatus || (workerReadError ? "状态读取失败" : "正在读取服务状态…")}</p>
            </div>
            <div className="ui-toolbar">
              <button type="button" className="ui-button" disabled={checkingWorker || worker?.status === "starting"} onClick={() => void runWorkerCheck()}>检查 AI 服务</button>
              <button type="button" className="ui-button" disabled={checkingWorker || worker?.status === "starting"} onClick={() => void runWorkerCheck(true)}>测试单张照片</button>
            </div>
          </div>
          {workerReadError && <p className="mt-2 break-words text-red-500">{workerReadError}</p>}
          {worker?.log_error && <p className="mt-2 break-words text-red-500">日志文件错误 · {worker.log_error}</p>}
          {lastWorkerError && <div className="mt-2 text-red-500">
            <ErrorTimestamp timestamp={lastWorkerError.occurred_at} />
            <p className="mt-1 break-words">{lastWorkerError.message.split("\n")[0]}</p>
          </div>}
          {checkingWorker && <p role="status" className="mt-2 text-text-secondary">正在检查 AI 服务…</p>}
          {workerCheckResult && <p role="status" className="mt-2 whitespace-pre-wrap break-words text-text-secondary">{workerCheckResult}</p>}
          {workerEntries.length > 0 && <details className="mt-2">
            <summary className="cursor-pointer py-1 text-accent-link">服务日志（{workerEntries.length} 条）</summary>
            <ol className="mt-2 max-h-72 space-y-2 overflow-auto rounded-md bg-surface-primary p-2">
              {latestWorkerEntries.map((entry) => <li key={entry.id} className="min-w-0">
                <p className="text-text-secondary"><ErrorTimestamp timestamp={entry.occurred_at} /> · {logSources[entry.source]}{entry.pid ? ` · PID ${entry.pid}` : ""}</p>
                <p className={`whitespace-pre-wrap break-words ${entry.source === "error" ? "text-red-500" : ""}`}>{entry.message}</p>
              </li>)}
            </ol>
            <div className="ui-toolbar mt-2">
              {clearWorkerThrough == null
                ? <button type="button" className="ui-button" disabled={busy}
                    onClick={() => setClearWorkerThrough(workerEntries[workerEntries.length - 1].id)}>清空服务日志</button>
                : <>
                  <button type="button" className="ui-button" disabled={busy} onClick={() => setClearWorkerThrough(null)}>取消</button>
                  <button type="button" className="ui-button text-red-500" disabled={busy} onClick={clearWorkerHistory}>确认清空服务日志</button>
                </>}
            </div>
          </details>}
        </section>
        {clearThrough != null && <div className="space-y-2 rounded-lg border border-surface-secondary bg-surface-primary p-3 text-sm">
          <p>清空此照片库当前的历史错误记录？失败任务仍可重试。</p>
          <div className="ui-toolbar">
            <button type="button" className="ui-button" disabled={busy} onClick={() => setClearThrough(null)}>取消</button>
            <button type="button" className="ui-button text-red-500" disabled={busy} onClick={clearHistory}>确认清空</button>
          </div>
        </div>}
        {page && <p className="rounded-lg bg-surface-primary px-3 py-2 text-xs text-text-secondary">{failureCounts}</p>}
        {current.length > 0 && <details className="group rounded-lg border border-surface-secondary">
          <summary className="ui-button w-full cursor-pointer list-none justify-between border-0">
            当前提示（{current.length}）
            <Icon name="chevronUp" size={14} className="rotate-180 group-open:rotate-0" />
          </summary>
          <ul className="max-h-52 space-y-2 overflow-auto border-t border-surface-secondary px-3 py-2 text-xs">
            {current.map(({ label, message, occurredAt }) => <li key={label}>
              <p className="flex flex-wrap items-baseline gap-x-2 text-text-secondary"><span className="font-medium text-text-primary">{label}</span>{occurredAt ? <ErrorTimestamp timestamp={occurredAt} /> : null}</p>
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
        {actionMessage && <p role="status" className="whitespace-pre-wrap break-words text-sm text-text-secondary">{actionMessage}</p>}
        {actionError && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-red-500">{actionError}</p>}
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
                  <span className="block text-sm font-medium">{expanded ? "▾" : "▸"} {stageLabel(group.key.stage)} · {group.occurrences} 条记录</span>
                  <span className="mt-1 flex flex-wrap gap-x-3 text-xs text-text-secondary">
                    {group.first_occurred_at !== group.occurred_at && <span>首次 <ErrorTimestamp timestamp={group.first_occurred_at} /></span>}
                    <span>最近 <ErrorTimestamp timestamp={group.occurred_at} /></span>
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
                          <div className="text-text-secondary">最近出错 <ErrorTimestamp timestamp={photo.occurred_at} /></div>
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
