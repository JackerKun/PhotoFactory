import { useEffect, useRef, useState } from "react";
import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import type { LibraryJob, ThumbnailPerformance } from "../types";
import Icon from "./Icon";

const stages: Record<string, string> = {
  starting: "准备智能分析", recovering_faces: "恢复人物整理", face_detection: "识别人脸",
  classification: "场景分类", clustering: "整理人物分组", clustering_done: "人物整理完成",
  clustering_error: "人物分组未完成", geo_tagging: "查询地点标签", finishing_tags: "整理时间、设备和事件标签",
  done: "智能分析完成", error: "智能分析出错", idle: "等待任务", paused: "智能分析已暂停", canceled: "智能分析已停止",
};
const statuses: Record<string, string> = { running: "进行中", queued: "等待中", paused: "已暂停", done: "已完成", completed: "已完成", failed: "失败", error: "失败", canceled: "已停止", idle: "等待中" };

function Progress({ value, total }: { value: number; total: number }) {
  return <div className="mt-2 flex items-center gap-3 text-xs text-text-secondary">
    <progress className="h-2 w-full accent-accent-primary" aria-label="任务进度" max={Math.max(1, total)} value={total > 0 ? Math.min(value, total) : undefined} />
    <span className="shrink-0 tabular-nums">{value.toLocaleString()} / {total > 0 ? total.toLocaleString() : "准备中"}</span>
  </div>;
}

const providerLabels: Record<string, string> = {
  CPUExecutionProvider: "CPU", DmlExecutionProvider: "DirectML (GPU)",
  CUDAExecutionProvider: "CUDA (GPU)", CoreMLExecutionProvider: "Core ML",
};
const modelLabels: Record<string, string> = {
  face_detection: "人脸检测", face_embedding: "人脸识别",
  scene: "场景分类", semantic_vision: "图像语义", semantic_text: "文本语义",
};

export default function TaskCenter() {
  const project = useStore((state) => state.project);
  const ai = useStore((state) => state.aiProcessingStatus);
  const thumbs = useStore((state) => state.thumbnailProcessingStatus);
  const [runtime, setRuntime] = useState<api.AiRuntimeInfo | null>(null);
  const [jobs, setJobs] = useState<LibraryJob[]>([]);
  const [performance, setPerformance] = useState<ThumbnailPerformance | null>(null);
  const [performanceSaving, setPerformanceSaving] = useState(false);
  const [performanceError, setPerformanceError] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    setJobs([]);
    useStore.getState().setThumbnailProcessingStatus(null);
    useStore.getState().setAiProcessingStatus(null);
    if (!project) return;
    const poll = async () => {
      const results = await Promise.allSettled([api.getThumbnailProcessingStatus(), api.getAiPipelineStatus(), api.getLibraryJobs()]);
      if (!live) return;
      const [thumbnail, pipeline, library] = results;
      if (thumbnail.status === "fulfilled") useStore.getState().setThumbnailProcessingStatus(thumbnail.value);
      if (pipeline.status === "fulfilled") useStore.getState().setAiProcessingStatus(pipeline.value);
      if (library.status === "fulfilled") setJobs(library.value);
      setPollError(results.some((result) => result.status === "rejected") ? "部分任务状态暂时无法读取，正在重新连接…" : "");
      timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [project?.root_path]);

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  useEffect(() => {
    if (!open || !project) return;
    setRuntime(null);
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const data = await api.getAiRuntime().catch(() => null);
      if (live) { setRuntime(data); timer = setTimeout(poll, 3000); }
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [open, project?.root_path]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setPerformanceError("");
    api.getThumbnailPerformance()
      .then((mode) => { if (live) setPerformance(mode); })
      .catch(() => { if (live) setPerformanceError("无法读取缩略图性能设置"); });
    return () => { live = false; };
  }, [open]);

  const changePerformance = async (mode: ThumbnailPerformance) => {
    setPerformanceSaving(true);
    setPerformanceError("");
    try {
      await api.setThumbnailPerformance(mode);
      setPerformance(mode);
    } catch {
      setPerformanceError("无法保存缩略图性能设置");
    } finally {
      setPerformanceSaving(false);
    }
  };

  const hasAi = !!ai && !!ai.stage && ai.stage !== "idle";
  const hasThumbs = !!thumbs && (thumbs.running || thumbs.processed > 0 || thumbs.failed > 0);
  const active = Number(!!thumbs?.running) + Number(hasAi && (ai.status === "running" || (!ai.status && !["done", "error", "paused", "canceled", "clustering_done"].includes(ai.stage!)))) + jobs.filter((job) => ["queued", "running"].includes(job.status)).length;
  const needsAttention = (ai?.failed ?? 0) + (thumbs?.failed ?? 0) + Number(ai?.status === "error") + jobs.filter((job) => ["failed", "error"].includes(job.status)).length;

  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try { await operation(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };

  return <>
    <button type="button" onClick={() => setOpen(true)} className="flex min-h-11 w-full items-center gap-2 border-y border-surface-secondary px-4 py-2 text-left text-sm hover:bg-surface-primary" aria-label="后台任务">
      <Icon name="activity" className={active ? "text-accent-link" : "text-text-secondary"} />
      <span className="flex-1">后台任务</span>
      <span className={`text-xs ${needsAttention ? "text-red-500" : "text-text-secondary"}`}>{active ? `${active} 项进行中` : needsAttention ? "需要处理" : "查看"}</span>
    </button>
    <dialog aria-labelledby="task-center-title" ref={dialog} onClose={() => setOpen(false)} className="m-auto w-[min(560px,calc(100%-32px))] max-h-[85vh] overflow-y-auto rounded-2xl border border-surface-secondary bg-bg-secondary p-5 text-text-primary shadow-2xl backdrop:bg-black/45">
      <div className="mb-4 flex items-center justify-between"><h2 id="task-center-title" className="text-lg font-semibold">后台任务</h2><button type="button" onClick={() => setOpen(false)} className="ui-button" aria-label="关闭后台任务">关闭</button></div>
      {pollError && <p role="status" className="mb-3 text-sm text-text-secondary">{pollError}</p>}
      {error && <p role="alert" className="mb-3 break-words text-sm text-red-500">操作失败：{error}</p>}
      <div className="space-y-3">
        <section className="rounded-xl border border-surface-secondary p-3">
          <label className="flex items-center justify-between gap-3 text-sm font-medium">
            <span>缩略图性能</span>
            <select className="ui-button" value={performance ?? ""} disabled={!performance || performanceSaving}
              onChange={(event) => void changePerformance(event.target.value as ThumbnailPerformance)}>
              <option value="" disabled>读取中</option>
              <option value="low">低速</option>
              <option value="balanced">均衡</option>
              <option value="full">全速</option>
            </select>
          </label>
          <p className="mt-2 text-xs text-text-secondary">
            {performance === "low" && "减少后台占用，适合一边浏览一边生成。"}
            {performance === "balanced" && "适度并行，符合条件的大预览可用 GPU。"}
            {performance === "full" && "提高并行度，更多预览可用 GPU，适合集中生成。"}
          </p>
          {thumbs?.gpu_backend && performance !== "low" && <p className="mt-1 text-xs text-text-secondary">本次运行已使用 {thumbs.gpu_backend} 缩放</p>}
          {performanceError && <p role="alert" className="mt-1 text-xs text-red-500">{performanceError}</p>}
        </section>
        {!hasAi && !hasThumbs && !jobs.length && !runtime && <p className="py-8 text-center text-sm text-text-secondary">暂无后台任务</p>}
        {hasThumbs && thumbs && <section className="rounded-xl border border-surface-secondary p-3">
          <div className="flex justify-between gap-3 font-medium"><h3>缩略图生成</h3><span className="text-sm text-text-secondary">{thumbs.running ? "进行中" : thumbs.failed ? "部分失败" : "已完成"}</span></div>
          <Progress value={thumbs.processed} total={thumbs.processed + thumbs.total_pending} />
          {thumbs.running && thumbs.current_file && <p className="mt-2 truncate text-xs text-text-secondary" title={thumbs.current_file}>{thumbs.current_file}</p>}
          <p className="mt-2 text-sm text-text-secondary">成功 {thumbs.succeeded} · 失败 {thumbs.failed}</p>
          {thumbs.last_error && <p className="mt-2 break-words text-sm text-red-500">{thumbs.last_error}</p>}
          {!thumbs.running && thumbs.failed > 0 && <button disabled={busy} onClick={() => void act(api.rebuildThumbnailCache)} className="ui-button mt-2">重试缺失缩略图</button>}
        </section>}
        {hasAi && ai && <section className="rounded-xl border border-surface-secondary p-3">
          <div className="flex justify-between gap-3 font-medium"><h3>{stages[ai.stage!] ?? "智能分析"}</h3><span className="text-sm text-text-secondary">{ai.status === "done" && (ai.failed ?? 0) > 0 ? "部分失败" : statuses[ai.status ?? ai.stage!] ?? "进行中"}</span></div>
          {ai.stage === "geo_tagging" && <p className="mt-1 text-xs text-text-secondary">正在联网查找照片的 GPS 地点名称。</p>}
          {(ai.stage === "clustering" || ai.stage === "recovering_faces") && ai.processed === 0 &&
            <p className="mt-1 text-xs text-text-secondary">正在整理第一批人脸，完成后更新计数。</p>}
          {(ai.status !== "done" || ai.total > 0) && <Progress value={ai.processed} total={ai.total} />}
          <p className="mt-2 text-sm text-text-secondary">失败 {ai.failed ?? 0}{ai.eta_seconds != null && ai.status === "running" ? ` · 预计剩余 ${Math.ceil(ai.eta_seconds / 60)} 分钟` : ""}</p>
          {ai.last_error && <p className="mt-2 break-words text-sm text-red-500">{ai.last_error}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {ai.status === "running" && <><button disabled={busy} onClick={() => void act(() => api.controlAiPipeline("pause"))} className="ui-button">暂停</button><button disabled={busy} onClick={() => void act(() => api.controlAiPipeline("cancel"))} className="ui-button">停止</button></>}
            {["paused", "canceled", "error"].includes(ai.status ?? ai.stage!) && <button disabled={busy} onClick={() => void act(() => api.controlAiPipeline("resume"))} className="ui-button">继续</button>}
            {(ai.failed ?? 0) > 0 && <button disabled={busy} onClick={() => void act(() => api.controlAiPipeline("retry"))} className="ui-button">重试失败</button>}
          </div>
        </section>}
        {runtime && <section className="rounded-xl border border-surface-secondary p-3 text-sm">
          <h3 className="font-medium">AI 运行信息</h3>
          {Object.keys(runtime.models).length
            ? <p className="mt-1 text-text-secondary">{Object.entries(runtime.models).map(([model, provider]) => `${modelLabels[model] ?? model}：${providerLabels[provider] ?? provider}`).join(" · ")}</p>
            : <p className="mt-1 text-text-secondary">模型将在分析照片时加载。</p>}
          {!!runtime.face_batch.photos && <p className="mt-1 text-text-secondary">最近一批：{runtime.face_batch.photos} 张，用时 {((runtime.face_batch.elapsed_ms ?? 0) / 1000).toFixed(1)} 秒，复用 {runtime.face_batch.preview_hits ?? 0} 张预览。累计解码 {Math.round(runtime.face_batch.decode_ms ?? 0)} ms · 检测 {Math.round(runtime.face_batch.detect_ms ?? 0)} ms · 提取特征 {Math.round(runtime.face_batch.embed_ms ?? 0)} ms</p>}
          {runtime.cluster_ms != null && <p className="mt-1 text-text-secondary">最近一次分组：{Math.round(runtime.cluster_ms)} ms</p>}
        </section>}
        {jobs.map((job) => <section key={job.id} className="rounded-xl border border-surface-secondary p-3">
          <div className="flex justify-between font-medium"><h3>{job.job_type.includes("ocr") ? "智能索引与文字识别" : "照片智能索引"}</h3><span className="text-sm text-text-secondary">{statuses[job.status] ?? job.status}</span></div>
          <Progress value={job.progress} total={job.total} />
          {(job.error || job.message) && <p className={`mt-2 break-words text-sm ${job.error ? "text-red-500" : "text-text-secondary"}`}>{job.error || job.message}</p>}
          <div className="mt-2 flex gap-2">
            {(job.status === "running" || job.status === "paused") && <button disabled={busy} onClick={() => void act(() => api.controlLibraryJob(job.id, job.status === "running" ? "pause" : "resume"))} className="ui-button">{job.status === "running" ? "暂停" : "继续"}</button>}
            {["running", "paused", "queued"].includes(job.status) && <button disabled={busy} onClick={() => void act(() => api.controlLibraryJob(job.id, "cancel"))} className="ui-button">停止</button>}
            {["failed", "canceled"].includes(job.status) && <button disabled={busy} onClick={() => void act(() => api.startLibraryAnalysis(job.job_type.includes("ocr")))} className="ui-button">重试</button>}
          </div>
        </section>)}
      </div>
    </dialog>
  </>;
}
