import React, { useState, useCallback, useEffect } from "react";
import DirectoryTree from "./DirectoryTree";
import FormatFilterPanel from "./FormatFilterPanel";
import type { ViewMode, Project } from "../types";
import { useStore } from "../hooks/usePhotos";
import * as api from "../api/tauri";

interface Props { viewMode: ViewMode; onViewModeChange: (mode: ViewMode) => void; project: Project | null; onImport: () => void; width?: number }

const navItems = [
  { mode: "grid" as ViewMode, icon: "📷", label: "Photos" },
  { mode: "map" as ViewMode, icon: "🗺️", label: "Map" },
  { mode: "faces" as ViewMode, icon: "👥", label: "People" },
  { mode: "tags" as ViewMode, icon: "🏷️", label: "Tags" },
  { mode: "albums" as ViewMode, icon: "📚", label: "相册" },
  { mode: "library" as ViewMode, icon: "✨", label: "智能工具" },
];

const DEFAULT_EXTENSIONS = ["jpg","jpeg","png","gif","bmp","webp","heic","heif"];

const stageLabels: Record<string, string> = {
  starting: "AI: 启动中...",
  recovering_faces: "AI: 恢复人物整理",
  face_detection: "AI: 处理人脸",
  classification: "AI: 场景分类",
  clustering: "AI: 人脸聚类中...",
  clustering_done: "AI: 已完成",
  done: "AI: 已完成",
  clustering_error: "AI: 聚类出错",
  paused: "AI: 已暂停",
  canceled: "AI: 已停止",
};

const formatEta = (seconds?: number | null) => {
  if (seconds == null || !Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
};

export default React.memo(function Sidebar({ viewMode, onViewModeChange, project, onImport, width = 256 }: Props) {
  const { setProject, reset } = useStore();
  const aiProcessingStatus = useStore((s) => s.aiProcessingStatus);
  const setAiProcessingStatus = useStore((s) => s.setAiProcessingStatus);
  const thumbStatus = useStore((s) => s.thumbnailProcessingStatus);
  const setThumbStatus = useStore((s) => s.setThumbnailProcessingStatus);
  const [showFormatPanel, setShowFormatPanel] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

  // Auto-hide "done" status after 5 seconds
  useEffect(() => {
    if (aiProcessingStatus?.stage === "done" || aiProcessingStatus?.stage === "clustering_done") {
      const timer = setTimeout(() => setAiProcessingStatus(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [aiProcessingStatus, setAiProcessingStatus]);

  // Poll thumbnail processing status every 1s when project is open
  useEffect(() => {
    if (!project) {
      setThumbStatus(null);
      return;
    }
    const poll = async () => {
      try {
        const status = await api.getThumbnailProcessingStatus();
        if (status.running) {
          setThumbStatus(status);
        } else if (thumbStatus?.running) {
          // Was running, now stopped — keep showing final stats briefly
          setThumbStatus(null);
        }
      } catch { /* ignore */ }
    };
    poll();
    const interval = setInterval(poll, 1000);
    return () => clearInterval(interval);
  }, [project, setThumbStatus, thumbStatus?.running]);

  // Durable AI status is polled from SQLite so progress survives an app restart
  // and does not depend on the frontend having received every event.
  useEffect(() => {
    if (!project) return;
    let disposed = false;
    const poll = async () => {
      try {
        const next = await api.getAiPipelineStatus();
        if (disposed) return;
        if (["running", "paused", "canceled", "error"].includes(next.status || "") || (next.status === "done" && (next.failed || 0) > 0)) {
          setAiProcessingStatus(next);
        }
      } catch { /* project may be switching */ }
    };
    poll();
    const timer = setInterval(poll, 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [project, setAiProcessingStatus]);

  const controlAi = useCallback(async (action: "pause" | "resume" | "cancel" | "retry") => {
    await api.controlAiPipeline(action);
    const next = await api.getAiPipelineStatus();
    setAiProcessingStatus(next);
  }, [setAiProcessingStatus]);

  const handleRefresh = useCallback(() => {
    if (!project) return;
    setShowFormatPanel(true);
    setShowDropdown(false);
  }, [project]);

  const handleFormatConfirm = async (extensions: string[]) => {
    setShowFormatPanel(false);
    try {
      const updatedProject = await api.updateExtensions(extensions);
      setProject(updatedProject);
      const result = await api.incrementalScan();
      if (result.added > 0 || result.updated > 0) {
        await Promise.all([
          api.startThumbnailBatch(),
          api.triggerAutoAi(),
        ]);
      }
      alert(
        `增量扫描完成：新增 ${result.added}，更新 ${result.updated}，` +
        `恢复 ${result.restored}，删除 ${result.deleted}，未变化 ${result.unchanged}`
      );
      const refreshed = await api.getProject();
      if (refreshed) setProject(refreshed);
      reset();
      setTimeout(() => useStore.getState().loadPhotos(), 100);
    } catch (err) {
      alert("扫描失败：" + err);
    }
  };

  const handleImportNew = useCallback(async () => {
    setShowDropdown(false);
    if (project) {
      await api.closeProject();
      setProject(null);
      reset();
    }
    onImport();
  }, [project, setProject, reset, onImport]);

  const handleCloseProject = useCallback(async () => {
    setShowDropdown(false);
    try {
      await api.closeProject();
      setProject(null);
      reset();
      onImport();
    } catch (err) {
      console.error("Failed to close project:", err);
    }
  }, [setProject, reset, onImport]);

  const handleRebuildThumbnails = useCallback(async () => {
    setShowDropdown(false);
    try {
      const message = await api.rebuildThumbnailCache();
      alert(message === "Already processing thumbnails"
        ? "缩略图任务正在运行。"
        : "已开始检查并补齐缺失的缩略图；现有缩略图不会重复生成。");
    } catch (err) {
      console.error("Failed to rebuild thumbnail cache:", err);
    }
  }, []);

  return (
    <aside className="mac-sidebar flex-none bg-bg-secondary border-r border-surface-secondary flex flex-col overflow-hidden" style={{ width }}>
      <div className="p-4 border-b border-surface-secondary">
        <div className="flex gap-2 mb-4" aria-hidden="true">
          <span className="mac-traffic-dot bg-[#ff5f57]" />
          <span className="mac-traffic-dot bg-[#febc2e]" />
          <span className="mac-traffic-dot bg-[#28c840]" />
        </div>
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-lg font-semibold tracking-tight text-text-primary">PhotoFactory</h1>
        </div>
        {project && (
          <div className="flex items-center justify-between">
            <p className="text-xs text-text-secondary truncate flex-1 mr-2" title={project.name}>
              {project.name}
            </p>
            <div className="relative">
              <button onClick={() => setShowDropdown(!showDropdown)}
                className="text-xs text-text-muted hover:text-text-primary p-1" title="More">
                ⋮
              </button>
              {showDropdown && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowDropdown(false)} />
                  <div className="absolute right-0 top-full mt-1 bg-bg-secondary border border-surface-secondary rounded-lg shadow-lg z-20 min-w-[160px]">
                    <button onClick={handleImportNew}
                      className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-surface-primary first:rounded-t-lg">
                      导入新文件夹
                    </button>
                    <button onClick={handleRefresh}
                      className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-surface-primary">
                      增量扫描新照片
                    </button>
                    <button onClick={handleRebuildThumbnails}
                      className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-surface-primary">
                      补齐缺失缩略图
                    </button>
                    <button onClick={handleCloseProject}
                      className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-surface-primary last:rounded-b-lg">
                      关闭项目
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      <nav className="p-2">
        {navItems.map((item) => (
          <button key={item.mode} onClick={() => onViewModeChange(item.mode)}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
              viewMode === item.mode ? "bg-accent-primary text-white shadow-sm" : "text-text-secondary hover:bg-white/70"
            }`}>
            <span>{item.icon}</span><span>{item.label}</span>
          </button>
        ))}
      </nav>

      {/* AI Status Indicator */}
      {aiProcessingStatus && aiProcessingStatus.stage && aiProcessingStatus.stage !== "error" && (
        <div className="px-2 py-1.5 border-t border-surface-secondary">
          <div className="flex items-center justify-between text-xs text-text-secondary mb-1">
            <span>{stageLabels[aiProcessingStatus.status === "paused" ? "paused" : aiProcessingStatus.status === "canceled" ? "canceled" : aiProcessingStatus.stage] || "AI: 处理中"}</span>
            {aiProcessingStatus.total > 0 && (
              <span>{aiProcessingStatus.processed}/{aiProcessingStatus.total}</span>
            )}
          </div>
          {aiProcessingStatus.total > 0 && aiProcessingStatus.stage !== "clustering" && (
            <div className="w-full bg-surface-primary rounded-full h-1">
              <div
                className="bg-accent-primary h-1 rounded-full transition-all duration-300"
                style={{ width: `${Math.min(100, (aiProcessingStatus.processed / aiProcessingStatus.total) * 100)}%` }}
              />
            </div>
          )}
          <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-text-muted">
            <span>
              {(aiProcessingStatus.photos_per_second || 0) > 0
                ? `${aiProcessingStatus.photos_per_second!.toFixed(1)} 张/秒`
                : "断点进度已保存"}
              {aiProcessingStatus.eta_seconds != null ? ` · 约 ${formatEta(aiProcessingStatus.eta_seconds)}` : ""}
            </span>
            {(aiProcessingStatus.failed || 0) > 0 && <span className="text-red-500">失败 {aiProcessingStatus.failed}</span>}
          </div>
          <div className="mt-1 flex gap-1">
            {aiProcessingStatus.status === "running" && <>
              <button className="rounded bg-surface-primary px-2 py-1 text-[10px]" onClick={() => controlAi("pause")}>暂停</button>
              <button className="rounded bg-surface-primary px-2 py-1 text-[10px]" onClick={() => controlAi("cancel")}>停止</button>
            </>}
            {["paused", "canceled", "error"].includes(aiProcessingStatus.status || "") &&
              <button className="rounded bg-accent-primary px-2 py-1 text-[10px] text-white" onClick={() => controlAi("resume")}>继续</button>}
            {(aiProcessingStatus.failed || 0) > 0 &&
              <button className="rounded bg-surface-primary px-2 py-1 text-[10px]" onClick={() => controlAi("retry")}>重试失败</button>}
          </div>
        </div>
      )}

      {/* Thumbnail Batch Progress */}
      {thumbStatus && thumbStatus.running && (
        <div className="px-2 py-1.5 border-t border-surface-secondary">
          <div className="flex items-center justify-between text-xs text-text-secondary mb-1">
            <span className="font-medium">缩略图生成中</span>
            <span>{thumbStatus.succeeded + thumbStatus.failed}/{thumbStatus.processed + thumbStatus.total_pending}</span>
          </div>
          {thumbStatus.current_file && (
            <div className="text-[10px] text-text-muted truncate mb-1" title={thumbStatus.current_file}>
              {thumbStatus.current_file}
            </div>
          )}
          <div className="w-full bg-surface-primary rounded-full h-1">
            <div
              className="bg-blue-500 h-1 rounded-full transition-all duration-300"
              style={{ width: `${thumbStatus.processed + thumbStatus.total_pending > 0 ? Math.min(100, ((thumbStatus.succeeded + thumbStatus.failed) / (thumbStatus.processed + thumbStatus.total_pending)) * 100) : 0}%` }}
            />
          </div>
          {(thumbStatus.succeeded > 0 || thumbStatus.failed > 0) && (
            <div className="flex justify-between text-[10px] text-text-muted mt-1">
              <span>成功 {thumbStatus.succeeded}</span>
              {thumbStatus.failed > 0 && <span className="text-red-400">失败 {thumbStatus.failed}</span>}
            </div>
          )}
        </div>
      )}

      {viewMode === "grid" && project && (
        <div className="flex-1 overflow-hidden border-t border-surface-secondary">
          <DirectoryTree rootPath={project.root_path} />
        </div>
      )}

      {showFormatPanel && project && (
        <FormatFilterPanel
          currentExtensions={project.enabled_extensions?.length > 0 ? project.enabled_extensions : DEFAULT_EXTENSIONS}
          onConfirm={handleFormatConfirm}
          onCancel={() => setShowFormatPanel(false)}
        />
      )}
    </aside>
  );
});
