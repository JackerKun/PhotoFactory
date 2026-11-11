// src/components/ImportModal.tsx
import React, { useState, useRef, useCallback, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { createProject, openProject, scanProject, updateExtensions, getProject, getRecentProjects, removeRecentProject } from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import Icon from "./Icon";
import FormatFilterPanel from "./FormatFilterPanel";

interface Props { onImported: () => void; onClose?: () => void }

const DEFAULT_EXTENSIONS = ["jpg","jpeg","png","gif","bmp","webp","heic","heif"];

export default React.memo(function ImportModal({ onImported, onClose }: Props) {
  const { setProject } = useStore();
  const [rootPath, setRootPath] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [photoCount, setPhotoCount] = useState(0);
  const [progress, setProgress] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"create" | "open">("create");
  const [showFormatPanel, setShowFormatPanel] = useState(false);
  const [recentProjects, setRecentProjects] = useState<string[]>([]);
  const scanTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load recent projects on mount
  useEffect(() => {
    getRecentProjects().then(setRecentProjects).catch(console.error);
  }, []);

  const handleOpenRecent = async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      setProgress("正在打开照片库…");
      const project = await openProject(path);
      setProject(project);
      setProgress("正在加载照片…");
      setTimeout(() => onImported(), 500);
    } catch (err: any) {
      setError(err.toString());
    } finally {
      setLoading(false);
      setProgress("");
    }
  };

  const handleRemoveRecent = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    await removeRecentProject(path);
    setRecentProjects(prev => prev.filter(p => p !== path));
  };

  const clearScanTimer = useCallback(() => {
    if (scanTimerRef.current) {
      clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
  }, []);

  const startScanPolling = useCallback(() => {
    clearScanTimer();
    setPhotoCount(0);
    scanTimerRef.current = setInterval(async () => {
      const p = await getProject();
      if (p && p.total_photos > 0) {
        setPhotoCount(p.total_photos);
        setProgress(`已发现 ${p.total_photos.toLocaleString()} 张照片...`);
      }
    }, 200);
  }, [clearScanTimer]);

  const handlePickFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择照片文件夹",
    });
    if (selected && typeof selected === "string") {
      setRootPath(selected);
    }
  };

  const handleImportClick = () => {
    if (!rootPath.trim() || loading) return;
    if (mode === "create") {
      setShowFormatPanel(true);
    } else {
      handleSubmit();
    }
  };

  const handleFormatConfirm = (extensions: string[]) => {
    setShowFormatPanel(false);
    handleSubmit(extensions);
  };

  const handleSubmit = async (extensions?: string[]) => {
    if (!rootPath.trim()) return;
    setLoading(true);
    setError(null);
    let ok = false;
    try {
      if (mode === "create") {
        setProgress("正在创建照片库…");
        const project = await createProject(rootPath.trim(), name.trim() || "我的照片");
        setProject(project);

        if (extensions && extensions.length > 0) {
          setProgress("正在保存格式设置…");
          const updated = await updateExtensions(extensions);
          setProject(updated);
        }

        setProgress("正在扫描文件...");
        startScanPolling();
        const count = await scanProject();
        clearScanTimer();
        setPhotoCount(count);
        setProgress(`扫描完成，共 ${count.toLocaleString()} 张照片！`);

        // Load photos into the store after scan completes — FilterSync's effect
        // fired earlier while scan was still running, so photos were empty.
        setProject({ ...(useStore.getState().project ?? project), total_photos: count });
        void useStore.getState().loadPhotos();
      } else {
        setProgress("正在打开照片库…");
        const project = await openProject(rootPath.trim());
        setProject(project);
        setProgress("正在加载照片…");
      }
      ok = true;
    } catch (err: any) {
      clearScanTimer();
      setError(err.toString());
    } finally {
      setLoading(false);
      setProgress("");
      setPhotoCount(0);
      if (ok) {
        setTimeout(() => onImported(), 500);
      }
    }
  };

  const handleClose = async () => {
    if (loading) {
      if (!confirm("正在扫描，确定要取消吗？")) return;
      clearScanTimer();
    }
    onClose?.();
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-bg-secondary rounded-xl p-6 w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-text-primary">
            {mode === "create" ? "导入照片" : "打开项目"}
          </h2>
          {onClose && (
            <button onClick={handleClose} className="text-text-muted hover:text-text-primary text-lg leading-none">
              ✕
            </button>
          )}
        </div>

        {mode === "create" && (
          <div className="mb-4">
            <label className="block text-sm text-text-secondary mb-1">项目名称</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="我的照片"
              className="w-full bg-surface-primary border border-surface-secondary rounded-lg px-3 py-2 text-text-primary text-sm" />
          </div>
        )}

        <div className="mb-4">
          <label className="block text-sm text-text-secondary mb-1">文件夹路径</label>
          <div className="flex gap-2">
            <input value={rootPath} onChange={(e) => setRootPath(e.target.value)}
              placeholder="/path/to/photos"
              className="flex-1 bg-surface-primary border border-surface-secondary rounded-lg px-3 py-2 text-text-primary text-sm" />
            <button onClick={handlePickFolder}
              className="bg-surface-primary border border-surface-secondary rounded-lg px-3 py-2 text-text-primary text-sm hover:bg-accent-primary/20">
              <Icon name="folder" size={20} />
            </button>
          </div>
        </div>

        {loading && (
          <div className="mb-4 p-2 bg-accent-primary/10 border border-accent-primary/30 rounded text-accent-link text-sm">
            <div className="font-medium">{progress}</div>
            {photoCount > 0 && (
              <div className="mt-1 text-xs text-text-muted">
                已发现 {photoCount.toLocaleString()} 张照片
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="mb-4 p-2 bg-red-900/30 border border-red-700 rounded text-red-400 text-sm">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <button onClick={handleImportClick} disabled={loading}
            className="flex-1 bg-accent-primary hover:bg-accent-primary/80 disabled:opacity-50 text-white py-2 rounded-lg text-sm font-medium">
            {loading ? "⏳ 扫描中..." : mode === "create" ? "导入" : "打开"}
          </button>
        </div>

        <button onClick={() => setMode(mode === "create" ? "open" : "create")}
          className="mt-3 w-full text-text-muted hover:text-text-primary text-xs">
          {mode === "create" ? "或打开已有项目" : "或创建新项目"}
        </button>

        {recentProjects.length > 0 && (
          <div className="mt-4 pt-4 border-t border-surface-secondary">
            <p className="text-xs text-text-muted mb-2">最近打开的项目</p>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {recentProjects.map((path) => {
                const folderName = path.split("/").pop() || path;
                const dirPath = path.split("/").slice(0, -1).join("/") + "/";
                return (
                  <div key={path}
                    className="flex items-center gap-2 group relative">
                    <button
                      onClick={() => handleOpenRecent(path)}
                      disabled={loading}
                      className="flex-1 text-left px-2 py-1.5 rounded hover:bg-surface-primary disabled:opacity-50"
                      title={path}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-text-primary text-sm truncate font-medium">
                          {folderName}
                        </span>
                        <span className="text-text-muted text-xs truncate">
                          {dirPath}
                        </span>
                      </div>
                    </button>
                    <button
                      onClick={(e) => handleRemoveRecent(e, path)}
                      className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-red-400 text-xs px-1 transition-opacity shrink-0"
                      title="移除"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {showFormatPanel && (
        <FormatFilterPanel
          currentExtensions={DEFAULT_EXTENSIONS}
          onConfirm={handleFormatConfirm}
          onCancel={() => setShowFormatPanel(false)}
        />
      )}
    </div>
  );
});
