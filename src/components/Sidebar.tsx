import React, { useState, useCallback, useEffect, useRef } from "react";
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
  { mode: "faces" as ViewMode, icon: "people", label: "人物" },
  { mode: "map" as ViewMode, icon: "map", label: "地图" },
  { mode: "tags" as ViewMode, icon: "tags", label: "标签" },
  { mode: "albums" as ViewMode, icon: "albums", label: "相册" },
  { mode: "library" as ViewMode, icon: "tools", label: "智能工具" },
];

const DEFAULT_EXTENSIONS = ["jpg","jpeg","png","gif","bmp","webp","heic","heif"];

export default React.memo(function Sidebar({ viewMode, onViewModeChange, project, onImport, width = 256 }: Props) {
  const { setProject, reset } = useStore();
  const [showFormatPanel, setShowFormatPanel] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [narrowExpanded, setNarrowExpanded] = useState(false);
  const [renameRoot, setRenameRoot] = useState<string>();
  const [projectName, setProjectName] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const renameDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = renameDialog.current;
    if (!renameRoot || !dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, [renameRoot]);

  const openProjectRename = () => {
    if (!project) return;
    setProjectName(project.name);
    setRenameError("");
    setShowDropdown(false);
    setRenameRoot(project.root_path);
  };

  const handleRename = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = projectName.trim();
    if (!renameRoot || !name || renaming) return;
    setRenaming(true);
    setRenameError("");
    try {
      const updated = await api.renameProject(renameRoot, name);
      if (useStore.getState().project?.root_path === renameRoot) setProject(updated);
      setRenameRoot(undefined);
    } catch (error) {
      setRenameError(`项目改名失败：${String(error)}`);
    } finally {
      setRenaming(false);
    }
  };

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
    <aside className="mac-sidebar workspace-sidebar flex-none border-r flex flex-col"
      data-narrow-expanded={narrowExpanded} style={{ "--workspace-sidebar-width": `${width}px` } as React.CSSProperties}>
      {project && (
        <div className="workspace-project">
          <div className="flex min-w-0 items-center justify-between gap-1">
            <button type="button" onClick={openProjectRename}
              className="workspace-project-name"
              title={`重命名项目 · ${project.name}`} aria-label={`重命名项目：${project.name}`}>
              <span className="workspace-project-mark"><Icon name="photos" size={18} /></span>
              <span className="min-w-0 truncate">{project.name}</span>
            </button>
            <div>
              <button type="button" onClick={() => setShowDropdown(!showDropdown)}
                className="workspace-project-toggle ui-button ui-icon-button"
                title="照片库操作" aria-label="照片库操作" aria-expanded={showDropdown}>
                <Icon name="chevronDown" size={16} className="workspace-project-chevron" />
                <Icon name="photos" size={18} className="workspace-rail-mark" />
              </button>
              {showDropdown && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowDropdown(false)} />
                  <div className="absolute left-2 top-full mt-1 bg-bg-secondary border border-surface-secondary rounded-lg shadow-lg z-50 min-w-[160px]">
                    <button type="button" onClick={openProjectRename}
                      className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-surface-primary first:rounded-t-lg">
                      重命名项目
                    </button>
                    <button onClick={handleImportNew}
                      className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-surface-primary">
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
      <nav aria-label="工作区" className="workspace-nav">
        {navItems.map((item) => (
          <button key={item.mode} onClick={() => onViewModeChange(item.mode)}
            aria-current={viewMode === item.mode ? "page" : undefined}
            aria-label={item.label} title={item.label}
            className="sidebar-nav-button w-full flex items-center gap-2 px-3 rounded-lg text-sm">
            <Icon name={item.icon as IconName} /><span>{item.label}</span>
          </button>
        ))}
      </nav>
      <button type="button" className="workspace-rail-toggle sidebar-nav-button"
        aria-expanded={narrowExpanded} onClick={() => setNarrowExpanded(!narrowExpanded)}
        title={narrowExpanded ? "收起侧栏" : "展开侧栏查看文件夹和主题"}
        aria-label={narrowExpanded ? "收起侧栏" : "展开侧栏查看文件夹和主题"}>
        <Icon name="sidebar" size={18} />
        <span>收起侧栏</span>
      </button>

      {viewMode === "grid" && project && (
        <div className="workspace-folder-tree flex-1 overflow-hidden border-t border-surface-secondary">
          <DirectoryTree key={project.root_path} rootPath={project.root_path} />
        </div>
      )}

      <div className="mt-auto">
        <TaskCenter />
        <div className="workspace-sidebar-settings">
          <AppUpdateActions />
          <ThemeSwitcher />
        </div>
      </div>

      {renameRoot && <dialog ref={renameDialog} aria-labelledby="rename-project-title"
        className="w-[calc(100%-2rem)] max-w-md rounded-xl border border-surface-secondary bg-bg-secondary p-0 text-text-primary shadow-xl backdrop:bg-black/50"
        onCancel={(event) => {
          event.preventDefault();
          if (!renaming) setRenameRoot(undefined);
        }}>
        <form onSubmit={(event) => void handleRename(event)}>
          <header className="border-b border-surface-secondary px-5 py-4">
            <h2 id="rename-project-title" className="text-base font-semibold">重命名项目</h2>
          </header>
          <div className="space-y-2 px-5 py-4">
            <label className="flex flex-col gap-1 text-sm">
              项目名称
              <input className="ui-input w-full" autoFocus required maxLength={120} value={projectName} disabled={renaming}
                onChange={(event) => setProjectName(event.target.value)} onFocus={(event) => event.currentTarget.select()} />
            </label>
            {renameError && <p role="alert" className="break-words text-sm text-red-600 dark:text-red-400">{renameError}</p>}
          </div>
          <footer className="flex justify-end gap-2 border-t border-surface-secondary px-5 py-3">
            <button type="button" className="ui-button" disabled={renaming} onClick={() => setRenameRoot(undefined)}>取消</button>
            <button type="submit" className="ui-button-primary" disabled={renaming || !projectName.trim()}>
              {renaming ? "保存中…" : "保存名称"}
            </button>
          </footer>
        </form>
      </dialog>}

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
