import React, { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import type { FaceCluster } from "../types";
import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import GroupPhotosView from "./GroupPhotosView";

interface Props {}

const FACE_PAGE_SIZE = 96;

/** In-memory cache for face thumbnail base64 data URLs with LRU eviction. */
const faceThumbCache = new Map<number, string>();
const FACE_THUMB_CACHE_MAX = 200; // Cap at 200 entries (~20MB max for 160x160 JPEGs)

/** Evict the oldest entry when the cache exceeds its maximum size. */
function cacheSet(clusterId: number, dataUrl: string) {
  if (faceThumbCache.size >= FACE_THUMB_CACHE_MAX) {
    const firstKey = faceThumbCache.keys().next().value;
    if (firstKey !== undefined) faceThumbCache.delete(firstKey);
  }
  faceThumbCache.set(clusterId, dataUrl);
}

/** Lazy-loaded face thumbnail with base64 data URL and IntersectionObserver. */
const FaceThumb: React.FC<{ clusterId: number }> = React.memo(function FaceThumb({ clusterId }) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Check cache synchronously
    const cached = faceThumbCache.get(clusterId);
    if (cached) {
      setThumb(cached);
      return;
    }

    const node = ref.current;
    if (!node) return;
    const controller = new AbortController();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !thumb) {
            observer.unobserve(entry.target);
            if (controller.signal.aborted) return;
            api.getClusterFaceThumbnail(clusterId, controller.signal)
              .then((dataUrl) => {
                if (!controller.signal.aborted && dataUrl) {
                  cacheSet(clusterId, dataUrl);
                  setThumb(dataUrl);
                }
              })
              .catch((err) => {
                if (!controller.signal.aborted) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              });
            return;
          }
        }
      },
      { rootMargin: "200px" },
    );

    observer.observe(node);
    return () => { controller.abort(); observer.disconnect(); };
  }, [clusterId, thumb]);

  if (thumb) {
    return (
      <img
        src={thumb}
        alt=""
        className="w-full h-full object-cover rounded"
        style={{ objectPosition: "center 25%" }}
        onError={() => {
          console.warn(`FaceThumb ${clusterId} image load error`);
          setThumb(null);
        }}
      />
    );
  }
  return (
    <div ref={ref} className="w-full h-full flex items-center justify-center text-text-muted text-xs">
      {error ? `Error: ${error.slice(0, 30)}` : "No face"}
    </div>
  );
});

const SuspectedFaceThumb: React.FC<{ faceId: number }> = React.memo(function SuspectedFaceThumb({ faceId }) {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api.getFaceThumbnail(faceId, controller.signal).then((value) => {
      if (!controller.signal.aborted) setThumb(value);
    }).catch(() => {});
    return () => controller.abort();
  }, [faceId]);
  return thumb
    ? <img src={thumb} alt="" className="w-full h-full object-cover" />
    : <div className="w-full h-full bg-surface-secondary animate-pulse" />;
});

type TabKey = "named" | "unnamed" | "review";

const faceActionClass = "w-full rounded-lg px-3 py-2 text-left hover:bg-surface-primary focus-visible:outline focus-visible:outline-accent-primary disabled:opacity-50";
const faceActionHeadingClass = "px-3 py-1 text-xs font-medium text-text-muted";

export default React.memo(function FaceView(_props: Props) {
  const [searchParams] = useSearchParams();
  const initialTab = (searchParams.get("tab") as TabKey) || "named";
  const [clusters, setClusters] = useState<FaceCluster[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab);
  const activeTabRef = useRef<TabKey>(initialTab);
  const pageRequest = useRef(0);
  const faceDataRevision = useStore((state) => state.faceDataRevision);
  const projectRoot = useStore((state) => state.project?.root_path);
  const [pageTotal, setPageTotal] = useState(0);
  const [pageLoading, setPageLoading] = useState(false);
  const [tabCounts, setTabCounts] = useState({ named: 0, unnamed: 0, review: 0 });
  const [mergeTargetClusters, setMergeTargetClusters] = useState<FaceCluster[]>([]);

  // Keep activeTab in sync with URL when navigating back from person photos
  useEffect(() => {
    const tabFromUrl = searchParams.get("tab") as TabKey;
    if (tabFromUrl && tabFromUrl !== activeTab) {
      activeTabRef.current = tabFromUrl;
      setActiveTab(tabFromUrl);
    }
  }, [searchParams.get("tab")]);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [clustering, setClustering] = useState(false);
  const [workerHealthy, setWorkerHealthy] = useState(false);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const faceActions = useRef<HTMLDetailsElement>(null);
  const faceActionsTrigger = useRef<HTMLElement>(null);
  const aiStatus = useStore((state) => state.aiProcessingStatus?.status);
  const aiBusy = aiRunning || aiStatus === "running" || aiStatus === "paused";

  // Face detection stats
  const [faceCount, setFaceCount] = useState(0);
  const [unassignedCount, setUnassignedCount] = useState(0);

  // Merge mode state
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeSelected, setMergeSelected] = useState<Set<number>>(new Set());
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false);
  const [mergeName, setMergeName] = useState("");
  const [mergeTargetId, setMergeTargetId] = useState<number | null>(null);
  const [mergeSaving, setMergeSaving] = useState(false);
  const [autoMergeOpen, setAutoMergeOpen] = useState(false);
  const [autoMergeThreshold, setAutoMergeThreshold] = useState(0.72);
  const [autoMergeRunning, setAutoMergeRunning] = useState(false);
  const [autoMergeCandidates, setAutoMergeCandidates] = useState<api.AutomaticFaceMergeCandidate[]>([]);
  const [autoMergeSelected, setAutoMergeSelected] = useState<Set<string>>(new Set());
  const [autoMergePreviewed, setAutoMergePreviewed] = useState(false);
  const [hasMergeUndo, setHasMergeUndo] = useState(false);
  const [suspectedFaceCount, setSuspectedFaceCount] = useState(0);
  const [suspectedFaces, setSuspectedFaces] = useState<api.SuspectedFace[]>([]);
  const [suspectedOpen, setSuspectedOpen] = useState(false);
  const [canReanalyzeFaces, setCanReanalyzeFaces] = useState(false);
  const [ignoredFaceCount, setIgnoredFaceCount] = useState(0);
  const navigate = useNavigate();
  const maintenanceDisabled = aiBusy || clustering || autoMergeRunning;

  const refreshData = useCallback(async () => {
    const requestedTab = activeTab;
    const requestId = ++pageRequest.current;
    const isCurrent = () => pageRequest.current === requestId && activeTabRef.current === requestedTab;
    setPageLoading(true);
    try {
      const [page, nextFaceCount, nextUnassignedCount] = await Promise.all([
        api.getClusterPage(requestedTab, 0, FACE_PAGE_SIZE),
        api.getFaceDetectionCount().catch(() => 0),
        api.getUnassignedFaceCount().catch(() => 0),
      ]);
      if (isCurrent()) {
        setClusters(page.items);
        setPageTotal(page.total);
        setTabCounts({ named: page.named_count, unnamed: page.unnamed_count, review: page.review_count });
        setFaceCount(nextFaceCount);
        setUnassignedCount(nextUnassignedCount);
      }
    } catch (error) {
      if (isCurrent()) {
        setOperationMessage(`读取人物列表失败：${String(error)}`);
      }
    } finally {
      if (isCurrent()) setPageLoading(false);
    }
    api.hasAutomaticFaceMergeToUndo().then(setHasMergeUndo).catch(() => setHasMergeUndo(false));
    api.getSuspectedFaceCount().then(setSuspectedFaceCount).catch(() => setSuspectedFaceCount(0));
    api.getFaceAiVersionStatus().then((status) => setCanReanalyzeFaces(status.upgrade_available)).catch(() => {});
    api.getIgnoredFaceCount().then(setIgnoredFaceCount).catch(() => setIgnoredFaceCount(0));
  }, [activeTab]);

  const loadMoreClusters = useCallback(async () => {
    if (pageLoading || clusters.length >= pageTotal) return;
    const requestedTab = activeTab;
    const requestId = ++pageRequest.current;
    const isCurrent = () => pageRequest.current === requestId && activeTabRef.current === requestedTab;
    setPageLoading(true);
    try {
      const page = await api.getClusterPage(requestedTab, clusters.length, FACE_PAGE_SIZE);
      if (!isCurrent()) return;
      setClusters((current) => {
        const known = new Set(current.map((cluster) => cluster.id));
        return [...current, ...page.items.filter((cluster) => !known.has(cluster.id))];
      });
      setPageTotal(page.total);
      setTabCounts({ named: page.named_count, unnamed: page.unnamed_count, review: page.review_count });
    } finally {
      if (isCurrent()) setPageLoading(false);
    }
  }, [activeTab, clusters.length, pageLoading, pageTotal]);

  useEffect(() => {
    void refreshData();
  }, [refreshData, faceDataRevision]);

  useEffect(() => {
    api.workerHealth().then(setWorkerHealthy).catch(() => setWorkerHealthy(false));
    // Poll worker health every 3s — worker may start after component mounts
    const interval = setInterval(() => {
      api.workerHealth().then(setWorkerHealthy).catch(() => setWorkerHealthy(false));
    }, 3000);

    // Auto-refresh when AI pipeline completes
    let unsub: (() => void) | undefined;
    listen("ai_status_changed", (event) => {
      const payload = event.payload as any;
      if (payload.stage === "clustering_done" || payload.stage === "done") {
        refreshData();
      }
    }).then((unsubFn) => { unsub = unsubFn; });

    return () => { clearInterval(interval); unsub?.(); };
  }, [refreshData]);

  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      const menu = faceActions.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, []);

  const closeFaceActions = () => {
    if (faceActions.current) faceActions.current.open = false;
    faceActionsTrigger.current?.focus();
  };

  const runFaceAction = (action: () => void) => {
    closeFaceActions();
    action();
  };

  const handleRunFaceDetection = async () => {
    setAiRunning(true);
    setOperationMessage("正在检查新增或发生变化的照片；已经分析过的照片不会重复处理。");
    try {
      const healthy = await api.workerHealth();
      if (!healthy) {
        const msg = await api.startAiWorker();
        console.log(msg);
        await new Promise(r => setTimeout(r, 2000));
      }
      const result = await api.triggerAutoAi();
      setOperationMessage(result === "No pending AI work"
        ? "没有待分析的照片。"
        : "正在后台分析待处理的照片，完成后人物页面会自动更新。");
    } catch (err) {
      console.error("Face detection failed:", err);
      const msg = err instanceof Error ? err.message : String(err);
      setOperationMessage(`智能分析暂时无法完成：${msg}`);
    } finally {
      setAiRunning(false);
    }
  };

  const handleRunClustering = async () => {
    setClustering(true);
    setOperationMessage("正在重新整理人物…");
    try {
      const healthy = await api.workerHealth();
      if (!healthy) {
        const msg = await api.startAiWorker();
        console.log(msg);
        await new Promise(r => setTimeout(r, 2000));
      }
      const result = await api.runFaceClustering();
      setOperationMessage(result || "人物已重新整理。");
      refreshData();
    } catch (err) {
      console.error("Clustering failed:", err);
      setOperationMessage("人物整理暂时无法完成：" + err);
    } finally {
      setClustering(false);
    }
  };

  const handleFullRecluster = async () => {
    if (!window.confirm("将用已有的人脸特征重建自动分组。已命名和人工确认的人物会保留。继续吗？")) return;
    setClustering(true);
    setOperationMessage("正在用已有的人脸特征重建人物分组…");
    try {
      const healthy = await api.workerHealth();
      if (!healthy) {
        await api.startAiWorker();
        await new Promise(r => setTimeout(r, 2000));
      }
      const result = await api.rebuildFaceClusters();
      faceThumbCache.clear();
      setOperationMessage(result || "人物分组已完整重建。");
      await refreshData();
    } catch (error) {
      setOperationMessage(`完整重建人物分组失败：${String(error)}`);
    } finally {
      setClustering(false);
    }
  };

  const candidateKey = (candidate: api.AutomaticFaceMergeCandidate) => candidate.cluster_ids.join("-");

  const openAutoMerge = () => {
    setAutoMergeCandidates([]);
    setAutoMergeSelected(new Set());
    setAutoMergePreviewed(false);
    setAutoMergeOpen(true);
  };

  const handlePreviewAutoMerge = async () => {
    setAutoMergeRunning(true);
    setOperationMessage("正在查找可能是同一个人的未命名分组…");
    try {
      const healthy = await api.workerHealth();
      if (!healthy) {
        await api.startAiWorker();
        await new Promise(r => setTimeout(r, 2000));
      }
      const candidates = await api.previewAutoMergeUnnamedFaces(autoMergeThreshold);
      setAutoMergeCandidates(candidates);
      setAutoMergeSelected(new Set(candidates.map(candidateKey)));
      setAutoMergePreviewed(true);
      setOperationMessage(candidates.length > 0
        ? `找到 ${candidates.length} 组可能是同一人的候选，请预览后确认。`
        : "当前阈值下没有发现可靠的合并候选。");
    } catch (error) {
      setOperationMessage(`候选分析失败：${String(error)}`);
    } finally {
      setAutoMergeRunning(false);
    }
  };

  const handleAutoMerge = async () => {
    const groups = autoMergeCandidates
      .filter((candidate) => autoMergeSelected.has(candidateKey(candidate)))
      .map((candidate) => candidate.cluster_ids);
    if (groups.length === 0) return;
    setAutoMergeRunning(true);
    try {
      const result = await api.applyAutoMergeUnnamedFaces(groups, autoMergeThreshold);
      faceThumbCache.clear();
      await refreshData();
      setOperationMessage(result);
      setAutoMergeOpen(false);
    } catch (error) {
      setOperationMessage(`自动合并失败：${String(error)}`);
    } finally {
      setAutoMergeRunning(false);
    }
  };

  const handleRejectAutoMergeCandidate = async (candidate: api.AutomaticFaceMergeCandidate) => {
    try {
      await api.rejectAutoMergeCandidate(candidate.cluster_ids);
      const key = candidateKey(candidate);
      setAutoMergeCandidates((items) => items.filter((item) => candidateKey(item) !== key));
      setAutoMergeSelected((selected) => { const next = new Set(selected); next.delete(key); return next; });
      setOperationMessage("已记住这些不是同一个人，今后不会再次自动推荐。");
    } catch (error) {
      setOperationMessage(`保存排除关系失败：${String(error)}`);
    }
  };

  const handleUndoAutomaticMerge = async () => {
    try {
      const result = await api.undoLastAutomaticFaceMerge();
      faceThumbCache.clear();
      await refreshData();
      setOperationMessage(result);
    } catch (error) {
      setOperationMessage(`撤销自动合并失败：${String(error)}`);
    }
  };

  const openSuspectedFaces = async () => {
    try {
      setSuspectedFaces(await api.getSuspectedFaces());
      setSuspectedOpen(true);
    } catch (error) {
      setOperationMessage(`读取疑似误检失败：${String(error)}`);
    }
  };

  const handleKeepSuspectedFace = async (faceId: number) => {
    await api.keepSuspectedFace(faceId);
    setSuspectedFaces((items) => items.filter((item) => item.id !== faceId));
    setSuspectedFaceCount((count) => Math.max(0, count - 1));
  };

  const handleDeleteSuspectedFace = async (faceId: number) => {
    await api.deletePhotoFace(faceId);
    setSuspectedFaces((items) => items.filter((item) => item.id !== faceId));
    setSuspectedFaceCount((count) => Math.max(0, count - 1));
  };

  const handleDeleteAllSuspectedFaces = async () => {
    if (!window.confirm(`确定删除 ${suspectedFaceCount} 个疑似误检吗？原始照片不会被删除。`)) return;
    const deleted = await api.deleteAllSuspectedFaces();
    setSuspectedFaces([]);
    setSuspectedFaceCount(0);
    setOperationMessage(`已清理 ${deleted} 个疑似误检，原始照片未改动。`);
  };

  const handleFaceReanalysis = async () => {
    const undoNotice = hasMergeUndo ? "重新分析后，上次自动合并的撤销记录会清除。" : "";
    if (!window.confirm(`将用当前算法重新读取照片、检测人脸并重建自动分组。已命名和人工确认的人物会保留。${undoNotice}操作可能耗时，继续吗？`)) return;
    setAiRunning(true);
    try {
      const prepared = await api.prepareFaceAiReanalysis();
      setHasMergeUndo(false);
      await api.triggerAutoAi();
      setCanReanalyzeFaces(false);
      setOperationMessage(`${prepared} 已在后台开始重新分析。`);
    } catch (error) {
      setOperationMessage(`启动人脸重新分析失败：${String(error)}`);
    } finally {
      setAiRunning(false);
    }
  };

  const handleIgnoreSelectedPeople = async () => {
    const ids = Array.from(mergeSelected);
    if (ids.length === 0) return;
    if (!window.confirm(`确定忽略选中的 ${ids.length} 个人物分组吗？\n\n这些人脸将从“未命名”和“待审核”中移除，后续 AI 也不会再次标记；原始照片不会删除。`)) return;
    setMergeSaving(true);
    try {
      const result = await api.ignoreFaceClusters(ids);
      faceThumbCache.clear();
      setMergeSelected(new Set());
      setMergeMode(false);
      await refreshData();
      setOperationMessage(result);
    } catch (error) {
      setOperationMessage(`忽略人物失败：${String(error)}`);
    } finally {
      setMergeSaving(false);
    }
  };

  const handleRestoreIgnoredFaces = async () => {
    if (!window.confirm(`恢复全部 ${ignoredFaceCount} 张已忽略人脸吗？它们会在下次人物整理时重新出现。`)) return;
    try {
      const result = await api.restoreAllIgnoredFaces();
      await refreshData();
      setOperationMessage(result);
    } catch (error) {
      setOperationMessage(`恢复已忽略人脸失败：${String(error)}`);
    }
  };

  const handleRename = async (clusterId: number) => {
    if (!editName.trim()) return;
    setRenameSaving(true);
    try {
      await api.renameCluster(clusterId, editName.trim());
      await api.confirmFaceCluster(clusterId);
      await refreshData();
      setEditingId(null);
      setOperationMessage(`已将人物命名为“${editName.trim()}”。`);
    } catch (error) {
      setOperationMessage(`保存人物名称失败：${String(error)}`);
    } finally {
      setRenameSaving(false);
    }
  };

  const handleConfirmCluster = async (clusterId: number) => {
    try {
      await api.confirmFaceCluster(clusterId);
      await refreshData();
      setOperationMessage("已确认这是一个独立人物；它已从待审核中移出。");
    } catch (error) {
      setOperationMessage(`确认人物失败：${String(error)}`);
    }
  };

  const toggleMergeSelection = (clusterId: number) => {
    setMergeSelected((prev) => {
      const next = new Set(prev);
      if (next.has(clusterId)) {
        next.delete(clusterId);
      } else {
        next.add(clusterId);
      }
      return next;
    });
  };

  const handleMergeSelected = async () => {
    const ids = Array.from(mergeSelected);
    if ((mergeTargetId == null && ids.length < 2) || (mergeTargetId != null && ids.length < 1)) {
      setOperationMessage(mergeTargetId == null ? "请至少选择两个人物进行合并。" : "请至少选择一个待合并人物。");
      return;
    }
    setMergeSaving(true);
    try {
      const target = mergeTargetId == null ? undefined : mergeTargetId;
      await api.mergeClustersBatch(ids, mergeTargetId == null ? mergeName : undefined, target);
      await refreshData();
      setOperationMessage(`已将 ${ids.length} 个人物合并为一个人物。`);
      setMergeSelected(new Set());
      setMergeMode(false);
      setMergeConfirmOpen(false);
      setMergeName("");
      setMergeTargetId(null);
    } catch (error) {
      setOperationMessage(`合并失败：${String(error)}`);
    } finally {
      setMergeSaving(false);
    }
  };

  const openMergeConfirmation = async () => {
    setMergeConfirmOpen(true);
    setMergeTargetClusters([]);
    try {
      const page = await api.getClusterPage("named", 0, 200);
      setMergeTargetClusters(page.items);
    } catch (error) {
      setOperationMessage(`读取已命名人物失败：${String(error)}`);
    }
  };

  const startMergeMode = (tab: TabKey = "unnamed", firstClusterId?: number) => {
    if (tab !== activeTab) {
      activeTabRef.current = tab;
      setClusters([]);
      setPageTotal(0);
    }
    setActiveTab(tab);
    setMergeMode(true);
    setMergeSelected(firstClusterId == null ? new Set() : new Set([firstClusterId]));
    setMergeConfirmOpen(false);
    setMergeTargetId(null);
  };

  const visibleClusters = clusters;
  const [groupTab, setGroupTab] = useState<"unopened" | "active" | "inactive">("unopened");
  const groupPhotosOpen = groupTab === "active";

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="people-header">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">人物</h2>
            <p className="text-sm text-text-muted mt-1">
              {faceCount > 0
                ? `${faceCount} 张人脸${tabCounts.named + tabCounts.unnamed > 0 ? ` · ${tabCounts.named + tabCounts.unnamed} 个人物` : ""}${unassignedCount > 0 ? ` · ${unassignedCount} 张待整理` : ""}`
                : "PhotoFactory 会在后台自动发现并整理人物"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 whitespace-nowrap text-xs text-text-secondary">
              <span className={`h-1.5 w-1.5 rounded-full ${workerHealthy ? "bg-emerald-500" : "bg-text-muted"}`} />
              {workerHealthy ? "智能分析服务已就绪" : "智能分析准备中"}
            </div>
            <details ref={faceActions} className="relative" onKeyDown={(event) => {
              if (event.key === "Escape" && event.currentTarget.open) {
                event.stopPropagation();
                closeFaceActions();
              }
            }}>
              <summary ref={faceActionsTrigger} aria-label="人物操作" title="人物操作"
                className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-md border border-surface-secondary bg-bg-secondary text-base text-text-secondary hover:bg-surface-primary">•••</summary>
              <div className="absolute right-0 z-20 mt-2 max-h-[70vh] w-72 max-w-[calc(100vw-2rem)] divide-y divide-surface-secondary overflow-y-auto rounded-xl border border-surface-secondary bg-bg-secondary px-1.5 text-sm shadow-xl">
                <div role="group" aria-label="分析与分组" className="py-1.5">
                  <p className={faceActionHeadingClass}>分析与分组</p>
                  <button type="button" onClick={() => runFaceAction(handleRunFaceDetection)} disabled={aiBusy} className={faceActionClass}>分析待处理照片</button>
                  <button type="button" onClick={() => runFaceAction(handleRunClustering)} disabled={clustering} className={faceActionClass}>整理待分组人脸</button>
                </div>
                <div role="group" aria-label="合并人物" className="py-1.5">
                  <p className={faceActionHeadingClass}>合并人物</p>
                  <button type="button" onClick={() => runFaceAction(openAutoMerge)} disabled={clustering || autoMergeRunning} className={faceActionClass}>查找相似人物…</button>
                  {hasMergeUndo && <button type="button" onClick={() => runFaceAction(handleUndoAutomaticMerge)} className={faceActionClass}>撤销上次自动合并</button>}
                </div>
                {(suspectedFaceCount > 0 || ignoredFaceCount > 0) && <div role="group" aria-label="审核与恢复" className="py-1.5">
                  <p className={faceActionHeadingClass}>审核与恢复</p>
                  {suspectedFaceCount > 0 && <button type="button" onClick={() => runFaceAction(openSuspectedFaces)} className={faceActionClass}>审核疑似误检（{suspectedFaceCount}）…</button>}
                  {ignoredFaceCount > 0 && <button type="button" onClick={() => runFaceAction(handleRestoreIgnoredFaces)} className={faceActionClass}>恢复已忽略人脸（{ignoredFaceCount}）…</button>}
                </div>}
                <div role="group" aria-label="高级维护" className="py-1.5">
                  <p className={faceActionHeadingClass}>高级维护</p>
                  <button type="button" onClick={() => runFaceAction(handleFullRecluster)} disabled={maintenanceDisabled} className={faceActionClass}>
                    <span className="block">重建自动分组…</span>
                    <span className="mt-0.5 block text-xs text-text-secondary">用已有的人脸特征重新分组</span>
                  </button>
                  {canReanalyzeFaces && <button type="button" onClick={() => runFaceAction(handleFaceReanalysis)} disabled={maintenanceDisabled} className={faceActionClass}>
                    <span className="block">重新分析人脸…</span>
                    <span className="mt-0.5 block text-xs text-text-secondary">重新读取照片并检测人脸</span>
                  </button>}
                  {maintenanceDisabled && <p className="px-3 py-1 text-xs text-text-muted">请在当前分析或分组任务结束后操作。</p>}
                </div>
              </div>
            </details>
          </div>
        </div>

        {operationMessage && (
          <div className="mb-4 flex items-center justify-between rounded-xl bg-bg-secondary/70 border border-text-primary/5 px-4 py-2.5 text-sm text-text-secondary">
            <span>{operationMessage}</span>
            <button onClick={() => setOperationMessage(null)} className="text-text-muted hover:text-text-primary">关闭</button>
          </div>
        )}

        {/* Tabs */}
        <nav aria-label="人物视图" className="ui-segments max-w-full overflow-x-auto">
          {(["named", "unnamed", "review"] as TabKey[]).map((tab) => (
            <button
              key={tab}
              type="button"
              aria-pressed={!groupPhotosOpen && activeTab === tab}
              onClick={() => {
                if (groupPhotosOpen) {
                  setGroupTab("inactive");
                  useStore.getState().setSelectedPhotoId(null);
                }
                if (activeTab === tab) return;
                activeTabRef.current = tab;
                setActiveTab(tab);
                setClusters([]);
                setPageTotal(0);
                setMergeMode(false);
                setMergeSelected(new Set());
              }}
              className="ui-segment"
            >
              {tab === "named" ? "\u5df2\u547d\u540d" : tab === "unnamed" ? "\u672a\u547d\u540d" : "\u5f85\u5ba1\u6838"}
              {" "}<span className="text-xs opacity-60">({tabCounts[tab]})</span>
            </button>
          ))}
          <button type="button" aria-pressed={groupPhotosOpen} onClick={() => setGroupTab("active")} className="ui-segment">合影</button>
        </nav>
      </div>

      {groupTab !== "unopened" && <div className={groupPhotosOpen ? "flex min-h-0 flex-1 flex-col" : "hidden"}><GroupPhotosView key={projectRoot} /></div>}
      <div className={groupPhotosOpen ? "hidden" : "flex min-h-0 flex-1 flex-col"}>

        {/* Toolbar */}
        <div className="people-toolbar flex flex-wrap items-center gap-2">
          {activeTab === "named" && !mergeMode && (
            <button
              onClick={() => startMergeMode("named")}
              className="ui-button-primary"
            >
              选择已命名人物合并
            </button>
          )}
          {activeTab === "unnamed" && !mergeMode && (
            <>
              <button
                onClick={openAutoMerge}
                className="ui-button-primary"
              >
                自动合并相似人物…
              </button>
              <button
                onClick={() => startMergeMode("unnamed")}
                className="ui-button"
              >
                手动选择合并
              </button>
            </>
          )}
          {mergeMode && (
            <>
              <button
                onClick={() => { void openMergeConfirmation(); }}
                disabled={mergeSelected.size < 1}
                className="bg-accent-primary text-white px-4 py-1.5 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
              >
                合并为一个人物 ({mergeSelected.size})
              </button>
              {(activeTab === "unnamed" || activeTab === "review") && (
                <button
                  onClick={handleIgnoreSelectedPeople}
                  disabled={mergeSelected.size < 1 || mergeSaving}
                  className="bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 px-4 py-1.5 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed border border-red-100"
                >
                  删除所选人物标记 ({mergeSelected.size})
                </button>
              )}
            </>
          )}
          {activeTab === "review" && !mergeMode && (
            <>
              <button onClick={() => startMergeMode("review")} className="ui-button">选择并合并</button>
              <span className="text-xs text-text-muted">确认、命名或合并身份不明确的人脸。</span>
            </>
          )}
          {mergeMode && mergeSelected.size > 0 && (
            <span className="text-xs text-text-muted">
              {mergeSelected.size} {"\u4e2a\u65cf\u7fa4\u5df2\u9009\u4e2d"}
            </span>
          )}
          {mergeMode && (
            <button onClick={() => { setMergeMode(false); setMergeSelected(new Set()); }} className="px-3 py-1.5 rounded-lg text-sm text-text-secondary hover:bg-text-primary/5">
              取消
            </button>
          )}
        </div>
      <div className="people-results">
        <div className="people-grid">
          {visibleClusters.map((cluster) => (
            <div
              key={cluster.id}
              className={`people-card group cursor-pointer rounded-xl border transition-colors ${
                mergeMode && mergeSelected.has(cluster.id!)
                  ? "border-accent-primary bg-accent-primary/15"
                  : "border-surface-secondary/70 bg-bg-secondary hover:border-accent-primary/40"
              }`}
              onClick={() => {
                if (mergeMode) {
                  toggleMergeSelection(cluster.id!);
                } else {
                  navigate(`/?tab=${activeTab}&person=${cluster.id}`);
                }
              }}
              onDoubleClick={(e) => {
                if (!mergeMode) {
                  e.preventDefault();
                  setEditingId(cluster.id!);
                  setEditName(cluster.name || "");
                }
              }}
            >
              <div className="w-full aspect-square overflow-hidden rounded-lg bg-surface-secondary relative">
                <FaceThumb clusterId={cluster.id!} />
                {mergeMode && (
                  <span className={`absolute top-2 right-2 w-6 h-6 rounded-full border-2 flex items-center justify-center text-xs font-bold shadow-sm ${
                    mergeSelected.has(cluster.id!) ? "bg-accent-primary border-white text-white" : "bg-bg-secondary/90 border-white text-transparent"
                  }`}>
                    ✓
                  </span>
                )}
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-1 px-1">
                <span className="min-w-0 truncate text-sm font-medium text-text-primary" title={cluster.name || undefined}>
                  {cluster.name || `人物 ${cluster.id}`}
                </span>
                {!mergeMode && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingId(cluster.id!);
                      setEditName(cluster.name || "");
                    }}
                    className="shrink-0 whitespace-nowrap text-xs text-text-muted opacity-0 hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    编辑
                  </button>
                )}
              </div>
              <p className="truncate px-1 text-xs text-text-muted" title={`${cluster.photo_count} 张照片 · ${cluster.face_count} 张人脸`}>
                照片 {cluster.photo_count} · 人脸 {cluster.face_count}
              </p>
              {activeTab === "review" && !mergeMode && (
                <div className="mt-2 grid grid-cols-3 gap-1 px-1 pb-1">
                  <button
                    type="button"
                    onClick={(event) => { event.stopPropagation(); void handleConfirmCluster(cluster.id!); }}
                    className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 px-1 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100"
                    title="确认这是一个独立人物"
                  >确认</button>
                  <button
                    type="button"
                    onClick={(event) => { event.stopPropagation(); setEditingId(cluster.id!); setEditName(cluster.name || ""); }}
                    className="rounded-lg bg-black/[0.045] px-1 py-1.5 text-xs text-text-secondary hover:bg-text-primary/[0.08]"
                  >命名</button>
                  <button
                    type="button"
                    onClick={(event) => { event.stopPropagation(); startMergeMode("review", cluster.id!); }}
                    className="rounded-lg bg-orange-50 dark:bg-orange-950/40 px-1 py-1.5 text-xs text-orange-700 dark:text-orange-300 hover:bg-orange-100"
                  >合并</button>
                </div>
              )}
            </div>
          ))}
        </div>

        {clusters.length < pageTotal && (
          <div className="flex justify-center py-8">
            <button
              type="button"
              onClick={() => { void loadMoreClusters(); }}
              disabled={pageLoading}
              className="rounded-xl border border-text-primary/10 bg-bg-secondary/80 px-5 py-2 text-sm text-text-secondary shadow-sm hover:bg-bg-secondary disabled:opacity-50"
            >
              {pageLoading ? "正在加载…" : `加载更多（已显示 ${clusters.length} / ${pageTotal}）`}
            </button>
          </div>
        )}

        {visibleClusters.length === 0 && pageLoading && <p className="people-empty" role="status">正在读取人物…</p>}
        {visibleClusters.length === 0 && !aiRunning && !pageLoading && (
          <div className="people-empty">
            {unassignedCount > 0 ? (
              <div>
                <p className="mb-1 font-medium">{`${unassignedCount} 张人脸正在等待整理`}</p>
                <p className="text-sm">后台分析会自动完成，你无需停留在此页面。</p>
              </div>
            ) : activeTab === "named"
              ? "暂无已命名的人物。"
              : activeTab === "unnamed"
                ? "暂无未命名的族群。"
                : "暂无低置信度的族群。"}
          </div>
        )}
      </div>

      </div>

      {editingId !== null && (
        <div className="fixed inset-0 z-[1200] bg-black/30 backdrop-blur-sm flex items-center justify-center" onMouseDown={() => !renameSaving && setEditingId(null)}>
          <div className="w-[360px] rounded-2xl bg-bg-secondary p-5 shadow-2xl border border-text-primary/10" onMouseDown={(event) => event.stopPropagation()}>
            <h3 className="text-lg font-semibold text-text-primary">命名人物</h3>
            <p className="text-xs text-text-muted mt-1 mb-4">这个名称会应用到该人物的全部照片。</p>
            <input
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") handleRename(editingId); if (event.key === "Escape") setEditingId(null); }}
              className="w-full rounded-xl border border-text-primary/10 bg-black/[0.035] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-accent-primary/30"
              placeholder="输入人物姓名"
              autoFocus
            />
            <div className="mt-5 flex justify-end gap-2">
              <button disabled={renameSaving} onClick={() => setEditingId(null)} className="px-4 py-2 rounded-lg text-sm text-text-secondary hover:bg-text-primary/5 disabled:opacity-50">取消</button>
              <button disabled={renameSaving || !editName.trim()} onClick={() => handleRename(editingId)} className="px-4 py-2 rounded-lg bg-accent-primary text-white text-sm font-medium disabled:opacity-50">
                {renameSaving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {mergeConfirmOpen && (
        <div className="fixed inset-0 z-[1200] bg-black/30 backdrop-blur-sm flex items-center justify-center" onMouseDown={() => !mergeSaving && setMergeConfirmOpen(false)}>
          <div className="w-[390px] rounded-2xl bg-bg-secondary p-5 shadow-2xl border border-text-primary/10" onMouseDown={(event) => event.stopPropagation()}>
            <h3 className="text-lg font-semibold text-text-primary">合并 {mergeSelected.size} 个人物</h3>
            <p className="text-sm text-text-muted mt-2">可以合并为一个新人物，也可以直接归入已经命名的人物。</p>
            <div className="mt-4 space-y-2">
              <label className={`block cursor-pointer rounded-xl border p-3 ${mergeTargetId == null ? "border-accent-primary bg-accent-primary/5" : "border-text-primary/10"}`}>
                <span className="flex items-center gap-2 text-sm font-medium"><input type="radio" checked={mergeTargetId == null} onChange={() => setMergeTargetId(null)} /> 合并为新人物</span>
                <input value={mergeName} onChange={(event) => setMergeName(event.target.value)} onFocus={() => setMergeTargetId(null)} className="mt-2 w-full rounded-lg border border-text-primary/10 bg-bg-secondary px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent-primary/30" placeholder="合并后姓名（可选）" />
              </label>
              <label className={`block rounded-xl border p-3 ${mergeTargetId != null ? "border-accent-primary bg-accent-primary/5" : "border-text-primary/10"}`}>
                <span className="flex items-center gap-2 text-sm font-medium"><input type="radio" checked={mergeTargetId != null} disabled={!mergeTargetClusters.some((cluster) => !mergeSelected.has(cluster.id!))} onChange={() => setMergeTargetId(mergeTargetClusters.find((cluster) => !mergeSelected.has(cluster.id!))?.id ?? null)} /> 合并到已有姓名</span>
                <select
                  value={mergeTargetId ?? ""}
                  onChange={(event) => setMergeTargetId(event.target.value ? Number(event.target.value) : null)}
                  className="mt-2 w-full rounded-lg border border-text-primary/10 bg-bg-secondary px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent-primary/30"
                >
                  <option value="">选择已命名人物…</option>
                  {mergeTargetClusters.filter((cluster) => !mergeSelected.has(cluster.id!)).map((cluster) => (
                    <option key={cluster.id} value={cluster.id!}>{cluster.name}（{cluster.photo_count} 张）</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button disabled={mergeSaving} onClick={() => setMergeConfirmOpen(false)} className="px-4 py-2 rounded-lg text-sm text-text-secondary hover:bg-text-primary/5 disabled:opacity-50">返回选择</button>
              <button disabled={mergeSaving || (mergeTargetId == null && mergeSelected.size < 2)} onClick={handleMergeSelected} className="px-4 py-2 rounded-lg bg-accent-primary text-white text-sm font-medium disabled:opacity-50">
                {mergeSaving ? "正在合并…" : "确认合并"}
              </button>
            </div>
          </div>
        </div>
      )}

      {autoMergeOpen && (
        <div className="fixed inset-0 z-[1200] bg-black/30 backdrop-blur-sm flex items-center justify-center" onMouseDown={() => !autoMergeRunning && setAutoMergeOpen(false)}>
          <div className="w-[680px] max-h-[86vh] overflow-y-auto rounded-2xl bg-bg-secondary p-6 shadow-2xl border border-text-primary/10" onMouseDown={(event) => event.stopPropagation()}>
            <h3 className="text-lg font-semibold text-text-primary">自动合并相似人物</h3>
            <p className="text-sm text-text-muted mt-2 leading-6">
              只比较未命名人物。已经命名的人物不会参与，也不会被改动；同一张照片中同时出现的人物不会自动合并。
            </p>
            <div className="mt-5 rounded-xl bg-black/[0.035] p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">相似度阈值</span>
                <span className="font-semibold tabular-nums">{autoMergeThreshold.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min="0.60"
                max="0.90"
                step="0.01"
                value={autoMergeThreshold}
                onChange={(event) => {
                  setAutoMergeThreshold(Number(event.target.value));
                  setAutoMergeCandidates([]);
                  setAutoMergeSelected(new Set());
                  setAutoMergePreviewed(false);
                }}
                className="mt-3 w-full accent-blue-600"
              />
              <div className="mt-1 flex justify-between text-xs text-text-muted">
                <span>0.60 合并更多</span><span>0.72 平衡</span><span>0.90 更谨慎</span>
              </div>
              <p className="mt-3 text-xs text-text-secondary">
                {autoMergeThreshold < 0.68
                  ? "当前设置较宽松，适合人物较少、拍摄跨度较大的相册。建议合并后抽查。"
                  : autoMergeThreshold < 0.80
                    ? "平衡模式：允许表情和角度变化，同时要求多张脸互相支持。"
                    : "谨慎模式：只合并非常相似的分组，误合风险最低。"}
              </p>
            </div>
            {autoMergePreviewed && (
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">候选结果（{autoMergeCandidates.length} 组）</span>
                  {autoMergeCandidates.length > 0 && (
                    <button
                      className="text-xs text-accent-link"
                      onClick={() => setAutoMergeSelected(
                        autoMergeSelected.size === autoMergeCandidates.length
                          ? new Set()
                          : new Set(autoMergeCandidates.map(candidateKey))
                      )}
                    >
                      {autoMergeSelected.size === autoMergeCandidates.length ? "全部取消" : "全部选择"}
                    </button>
                  )}
                </div>
                {autoMergeCandidates.length === 0 ? (
                  <div className="rounded-xl border border-text-primary/5 bg-black/[0.025] px-4 py-8 text-center text-sm text-text-muted">
                    当前阈值下没有可靠候选。可以稍微降低阈值后重新分析。
                  </div>
                ) : (
                  <div className="space-y-2 max-h-[330px] overflow-y-auto pr-1">
                    {autoMergeCandidates.map((candidate) => {
                      const key = candidateKey(candidate);
                      const selected = autoMergeSelected.has(key);
                      return (
                        <div key={key} className={`rounded-xl border p-3 ${selected ? "border-accent-primary bg-accent-primary/5" : "border-text-primary/10 bg-bg-secondary"}`}>
                          <div className="flex items-center gap-3">
                            <button
                              className={`w-5 h-5 shrink-0 rounded border text-xs ${selected ? "bg-accent-primary border-accent-primary text-white" : "border-text-primary/20"}`}
                              onClick={() => setAutoMergeSelected((current) => {
                                const next = new Set(current);
                                if (next.has(key)) next.delete(key); else next.add(key);
                                return next;
                              })}
                            >✓</button>
                            <div className="flex -space-x-2">
                              {candidate.cluster_ids.slice(0, 5).map((clusterId) => (
                                <div key={clusterId} className="w-12 h-12 overflow-hidden rounded-full border-2 border-white bg-surface-secondary">
                                  <FaceThumb clusterId={clusterId} />
                                </div>
                              ))}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium">{candidate.cluster_ids.length} 个人物分组 · {candidate.face_count} 张人脸</div>
                              <div className="text-xs text-text-muted">综合相似度 {(candidate.similarity * 100).toFixed(1)}%</div>
                            </div>
                            <button
                              onClick={() => handleRejectAutoMergeCandidate(candidate)}
                              className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs text-orange-700 dark:text-orange-300 hover:bg-orange-50"
                            >不是同一人</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button disabled={autoMergeRunning} onClick={() => setAutoMergeOpen(false)} className="px-4 py-2 rounded-lg text-sm text-text-secondary hover:bg-text-primary/5 disabled:opacity-50">取消</button>
              {!autoMergePreviewed ? (
                <button disabled={autoMergeRunning} onClick={handlePreviewAutoMerge} className="px-4 py-2 rounded-lg bg-accent-primary text-white text-sm font-medium disabled:opacity-50">
                  {autoMergeRunning ? "正在分析…" : "查找合并候选"}
                </button>
              ) : (
                <>
                  <button disabled={autoMergeRunning} onClick={handlePreviewAutoMerge} className="px-3 py-2 rounded-lg text-sm text-text-secondary hover:bg-text-primary/5 disabled:opacity-50">重新分析</button>
                  <button disabled={autoMergeRunning || autoMergeSelected.size === 0} onClick={handleAutoMerge} className="px-4 py-2 rounded-lg bg-accent-primary text-white text-sm font-medium disabled:opacity-50">
                    {autoMergeRunning ? "正在合并…" : `确认合并 ${autoMergeSelected.size} 组`}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {suspectedOpen && (
        <div className="fixed inset-0 z-[1200] bg-black/30 backdrop-blur-sm flex items-center justify-center" onMouseDown={() => setSuspectedOpen(false)}>
          <div className="w-[760px] max-h-[84vh] overflow-y-auto rounded-2xl bg-bg-secondary p-6 shadow-2xl border border-text-primary/10" onMouseDown={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold text-text-primary">审核疑似误检</h3>
                <p className="mt-1 text-sm text-text-muted">这些低质量检测不会进入人物聚类。保留后会在下次人物整理时参与分组。</p>
              </div>
              <button onClick={() => setSuspectedOpen(false)} className="text-text-muted">关闭</button>
            </div>
            {suspectedFaces.length === 0 ? (
              <div className="py-16 text-center text-sm text-text-muted">没有需要审核的疑似误检。</div>
            ) : (
              <div className="mt-5 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                {suspectedFaces.map((face) => (
                  <div key={face.id} className="rounded-xl border border-text-primary/10 overflow-hidden bg-bg-secondary">
                    <div className="aspect-square"><SuspectedFaceThumb faceId={face.id} /></div>
                    <div className="p-2">
                      <div className="text-xs text-text-muted">质量 {(face.quality_score * 100).toFixed(0)}% · 检测 {(face.detection_confidence * 100).toFixed(0)}%</div>
                      <div className="mt-2 grid grid-cols-2 gap-1">
                        <button onClick={() => handleKeepSuspectedFace(face.id)} className="rounded-md bg-emerald-50 dark:bg-emerald-950/40 py-1 text-xs text-emerald-700 dark:text-emerald-300">是人脸</button>
                        <button onClick={() => handleDeleteSuspectedFace(face.id)} className="rounded-md bg-red-50 dark:bg-red-950/40 py-1 text-xs text-red-700 dark:text-red-300">删除</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-5 flex justify-between border-t border-text-primary/5 pt-4">
              <button disabled={suspectedFaces.length === 0} onClick={handleDeleteAllSuspectedFaces} className="rounded-lg px-3 py-2 text-sm text-red-600 dark:text-red-300 hover:bg-red-50 disabled:opacity-40">全部视为误检</button>
              <button onClick={() => setSuspectedOpen(false)} className="rounded-lg bg-accent-primary px-4 py-2 text-sm text-white">完成</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
