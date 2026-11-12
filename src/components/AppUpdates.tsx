import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { checkForUpdate, openGitHub, type UpdateCheck } from "../api/tauri";
import Icon from "./Icon";

interface UpdateActions {
  checking: boolean;
  message: string;
  check: () => void;
  openRepository: () => void;
}

const UpdateActionsContext = createContext<UpdateActions | null>(null);

export default function AppUpdates({ children }: { children: ReactNode }) {
  const request = useRef<"idle" | "pending" | "finished">("idle");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheck | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [message, setMessage] = useState("");
  const [downloadError, setDownloadError] = useState(false);

  const check = useCallback(async (manual: boolean) => {
    if (request.current === "pending") return;
    request.current = "pending";
    setChecking(true);
    setMessage("");
    try {
      const next = await checkForUpdate();
      setResult(next);
      setDismissed(false);
      setDownloadError(false);
      if (manual && !next.latest_release?.is_newer) {
        setMessage(next.latest_release
          ? `当前版本 v${next.current_version}，暂无更新。`
          : "GitHub 暂无正式版本。");
      }
    } catch (error) {
      if (manual) setMessage(typeof error === "string" ? error : "检查更新失败，请稍后重试。");
    } finally {
      request.current = "finished";
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (request.current === "idle") void check(false);
  }, [check]);

  const openRepository = () => {
    setMessage("");
    void openGitHub().catch(() => setMessage("无法打开浏览器，请稍后重试。"));
  };

  const release = result?.latest_release;
  return (
    <UpdateActionsContext.Provider value={{ checking, message, check: () => void check(true), openRepository }}>
      {children}
      {result && release?.is_newer && !dismissed && (
        <section aria-label="软件更新" className="fixed inset-x-4 bottom-4 z-[60] rounded-xl border border-surface-secondary bg-bg-secondary p-4 text-text-primary shadow-lg sm:left-auto sm:w-80">
          <div role="status">
            <h2 className="text-sm font-semibold">发现新版本 v{release.version}</h2>
            <p className="mt-1 text-xs text-text-secondary">当前版本 v{result.current_version}</p>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="ui-button-primary" onClick={() => {
              setDownloadError(false);
              void openGitHub(release.tag).catch(() => setDownloadError(true));
            }}>去下载</button>
            <button type="button" className="ui-button" onClick={() => setDismissed(true)}>稍后</button>
          </div>
          {downloadError && <p role="alert" className="mt-2 text-xs text-text-secondary">无法打开下载页面，请稍后重试。</p>}
        </section>
      )}
    </UpdateActionsContext.Provider>
  );
}

export function AppUpdateActions() {
  const updates = useContext(UpdateActionsContext);
  if (!updates) return null;

  const iconButton = "grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-muted hover:bg-surface-primary hover:text-text-primary disabled:cursor-wait disabled:opacity-50";
  return <div className="flex items-center gap-1 border-t border-surface-secondary px-2.5 py-0.5">
    <button type="button" className={iconButton} onClick={updates.check} disabled={updates.checking}
      aria-label="检查更新" aria-busy={updates.checking} title={updates.checking ? "正在检查更新…" : "检查更新"}>
      <Icon name="retry" size={14} className={updates.checking ? "motion-safe:animate-spin" : ""} />
    </button>
    <button type="button" className={iconButton} onClick={updates.openRepository} aria-label="打开 GitHub" title="打开 GitHub">
      <Icon name="github" size={14} />
    </button>
    <p role="status" className="min-w-0 text-xs text-text-secondary">{updates.message}</p>
  </div>;
}
