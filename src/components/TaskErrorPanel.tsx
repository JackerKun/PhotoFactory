import { useEffect, useState } from "react";
import { getTaskErrors, type TaskErrorPage, type TaskErrorRecord } from "../api/tauri";

export interface CurrentTaskError {
  label: string;
  message: string;
}

function errorTitle(record: TaskErrorRecord, stages: Record<string, string>) {
  const stage = stages[record.stage] ?? record.stage;
  const scope = record.kind === "batch" ? `批次中断 · ${record.photos.length} 张` : record.kind === "photo" ? "照片错误" : "任务错误";
  return `${stage} · ${scope}`;
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

export default function TaskErrorPanel({ projectPath, current, stages, runtime }: {
  projectPath?: string;
  current: CurrentTaskError[];
  stages: Record<string, string>;
  runtime: string;
}) {
  const [page, setPage] = useState<TaskErrorPage | null>(null);
  const [before, setBefore] = useState<number | null>(null);
  const [loadError, setLoadError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!projectPath) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const result = await getTaskErrors(before);
        if (live) { setPage(result); setLoadError(""); }
      } catch (error) {
        if (live) setLoadError(String(error));
      }
      if (live && before == null) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [projectPath, before, refresh]);

  const entries = page?.entries ?? [];
  const platform = page ? `PhotoFactory ${page.version} · ${page.platform} ${page.architecture}` : "PhotoFactory";
  const failureCounts = page
    ? `人脸失败 ${page.failed_faces} · 分类失败 ${page.failed_classifications} · 有错误记录的待重试任务 ${page.retryable}`
    : "";

  const changePage = (cursor: number | null) => {
    setPage(null);
    setCopyStatus("");
    setLoadError("");
    setBefore(cursor);
  };

  async function copy() {
    const report = [platform, runtime, failureCounts, ...current.map(({ label, message }) => `${label}\n${message}`),
      ...entries.map((entry) => [
        `${errorTime(entry.occurred_at)} · ${errorTitle(entry, stages)}`,
        entry.message,
        ...entry.photos.map((photo) => `${photo.filename}${photo.attempts == null ? "" : `（第 ${photo.attempts} 次尝试）`}\n${photo.path}`),
      ].join("\n")),
    ].filter(Boolean).join("\n\n");
    try {
      await copyReport(report);
      setCopyStatus("已复制本页诊断");
    } catch {
      setCopyStatus("复制失败，可以选中下方文字手动复制");
    }
  }

  return <section aria-labelledby="task-error-title" className="min-w-0 rounded-2xl border border-surface-secondary bg-bg-secondary">
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-secondary px-4 py-3">
      <div>
        <h3 id="task-error-title" className="text-base font-semibold">错误与诊断</h3>
        {page && <p className="mt-1 text-xs text-text-secondary">{platform}</p>}
      </div>
      <button type="button" className="ui-button" disabled={!current.length && !entries.length} onClick={() => void copy()}>复制本页诊断</button>
      {copyStatus && <p role="status" className="w-full text-xs text-text-secondary">{copyStatus}</p>}
    </header>
    <div className="space-y-3 p-4">
      {page && <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-lg bg-surface-primary px-3 py-2 text-xs text-text-secondary">
        <span>人脸失败 <strong className="text-text-primary">{page.failed_faces}</strong></span>
        <span>分类失败 <strong className="text-text-primary">{page.failed_classifications}</strong></span>
        <span>有错误记录的待重试任务 <strong className="text-text-primary">{page.retryable}</strong></span>
      </div>}
      {current.length > 0 && <div className="space-y-2">
        <h4 className="text-sm font-semibold">当前提示</h4>
        {current.map(({ label, message }) => <div key={label} className="rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 text-xs">
          <p className="font-medium text-text-primary">{label}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-red-500">{message}</p>
        </div>)}
      </div>}
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">错误记录</h4>
        {before != null && <button type="button" className="ui-button" onClick={() => changePage(null)}>返回最新</button>}
      </div>
      {loadError && <div role="alert" className="space-y-2 text-sm text-red-500">
        <p className="break-words">无法读取错误记录：{loadError}</p>
        <button type="button" className="ui-button" onClick={() => setRefresh((value) => value + 1)}>重新读取记录</button>
      </div>}
      {!loadError && !page && <p className="text-sm text-text-secondary">{projectPath ? "正在读取错误记录…" : "打开照片库后可查看错误记录"}</p>}
      {page && !entries.length && <p className="rounded-lg border border-dashed border-surface-secondary p-4 text-sm text-text-secondary">暂无错误记录</p>}
      <ol className="space-y-2">
        {entries.map((entry) => <li key={entry.id} className="min-w-0 rounded-xl border border-surface-secondary px-3 py-2.5">
          <div className="flex flex-wrap justify-between gap-x-3 gap-y-1">
            <h5 className="text-sm font-medium">{errorTitle(entry, stages)}</h5>
            <time className="text-xs tabular-nums text-text-secondary" dateTime={new Date(entry.occurred_at * 1000).toISOString()}>{errorTime(entry.occurred_at)}</time>
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-text-secondary">{entry.message}</p>
          {entry.photos.length > 0 && <details className="mt-2 text-xs">
            <summary className="cursor-pointer font-medium text-accent-link">涉及照片（{entry.photos.length} 张）</summary>
            <ul className="mt-2 space-y-2 border-l border-surface-secondary pl-2">
              {entry.photos.map((photo, index) => <li key={`${photo.path}-${index}`}>
                <div className="break-words font-medium">{photo.filename}{photo.attempts != null && <span className="ml-2 font-normal text-text-secondary">第 {photo.attempts} 次尝试</span>}</div>
                <div className="break-all text-text-secondary">{photo.path}</div>
              </li>)}
            </ul>
          </details>}
        </li>)}
      </ol>
      {page?.next_before != null && <button type="button" className="ui-button w-full" onClick={() => changePage(page.next_before)}>查看更早记录</button>}
    </div>
  </section>;
}
