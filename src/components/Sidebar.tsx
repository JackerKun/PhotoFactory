import React, { useState, useCallback } from "react";
import DirectoryTree from "./DirectoryTree";
import Icon, { type IconName } from "./Icon";
import TaskCenter from "./TaskCenter";
import ThemeSwitcher from "./ThemeSwitcher";
import { AppUpdateActions } from "./AppUpdates";
import FormatFilterPanel from "./FormatFilterPanel";
import type { ViewMode, Project } from "../types";
import { useStore } from "../hooks/usePhotos";
import * as api from "../api/tauri";

interface Props { viewMode: ViewMode; onViewModeChange: (mode: ViewMode) => void; project: Project | null; onImport: () => void; width?: number }

const navItems = [
  { mode: "grid" as ViewMode, icon: "photos", label: "照片" },
  { mode: "map" as ViewMode, icon: "map", label: "地图" },
  { mode: "faces" as ViewMode, icon: "people", label: "人物" },
  { mode: "tags" as ViewMode, icon: "tags", label: "标签" },
  { mode: "albums" as ViewMode, icon: "albums", label: "相册" },
  { mode: "library" as ViewMode, icon: "tools", label: "智能工具" },
];

const DEFAULT_EXTENSIONS = ["jpg","jpeg","png","gif","bmp","webp","heic","heif"];

export default React.memo(function Sidebar({ viewMode, onViewModeChange, project, onImport, width = 256 }: Props) {
  const { setProject, reset } = useStore();
  const [showFormatPanel, setShowFormatPanel] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

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
      {project && (
        <div className="border-b border-surface-secondary px-4 py-3">
          <div className="flex items-center justify-between">
            <p className="mr-2 flex-1 truncate text-sm font-medium text-text-primary" title={project.name}>
              {project.name}
            </p>
            <div className="relative">
              <button type="button" onClick={() => setShowDropdown(!showDropdown)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-surface-primary hover:text-text-primary"
                title="照片库操作" aria-label="照片库操作" aria-expanded={showDropdown}>
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
        </div>
      )}
      <nav className="p-2">
        {navItems.map((item) => (
          <button key={item.mode} onClick={() => onViewModeChange(item.mode)}
            className={`sidebar-nav-button w-full flex items-center gap-2 px-3 rounded-lg text-sm transition-colors ${
              viewMode === item.mode ? "bg-accent-primary text-white" : "text-text-secondary hover:bg-surface-primary"
            }`}>
            <Icon name={item.icon as IconName} /><span>{item.label}</span>
          </button>
        ))}
      </nav>

      <TaskCenter />

      {viewMode === "grid" && project && (
        <div className="flex-1 overflow-hidden border-t border-surface-secondary">
          <DirectoryTree key={project.root_path} rootPath={project.root_path} />
        </div>
      )}

      <div className="mt-auto">
        <AppUpdateActions />
        <ThemeSwitcher />
      </div>

      {showFormatPanel && project && (
        <FormatFilterPanel
          mode="scan"
          currentExtensions={project.enabled_extensions?.length > 0 ? project.enabled_extensions : DEFAULT_EXTENSIONS}
          onConfirm={handleFormatConfirm}
          onCancel={() => setShowFormatPanel(false)}
        />
      )}
    </aside>
  );
});
