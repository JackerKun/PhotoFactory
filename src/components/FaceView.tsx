import React, { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import type { FaceCluster } from "../types";
import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import GroupPhotosView from "./GroupPhotosView";

interface Props { active?: boolean }

const FACE_PAGE_SIZE = 96;

function selectableMergeMembers(candidate: api.AutomaticFaceMergeCandidate) {
  return candidate.cluster_ids.filter((id) => id !== candidate.named_target_id);
}

const faceThumbCache = new Map<string, string>();
const FACE_THUMB_CACHE_MAX = 512;

const FaceThumb = React.memo(function FaceThumb({ clusterId, scope, active }: {
  clusterId: number;
  scope: string;
  active: boolean;
}) {
  const cacheKey = JSON.stringify([scope, clusterId]);
  const [result, setResult] = useState<{ key: string; src?: string; error?: string }>();
  const ref = useRef<HTMLSpanElement>(null);
  const current = result?.key === cacheKey ? result : undefined;
  const thumb = current?.src ?? (!current?.error ? faceThumbCache.get(cacheKey) : undefined);

  useEffect(() => {
    const node = ref.current;
    if (!node || !active || current) return;
    if (thumb) {
      faceThumbCache.delete(cacheKey);
      faceThumbCache.set(cacheKey, thumb);
      setResult({ key: cacheKey, src: thumb });
      return;
    }

    const controller = new AbortController();
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting || controller.signal.aborted) return;
      observer.disconnect();
      api.getClusterFaceThumbnail(clusterId, controller.signal)
        .then((src) => {
          if (controller.signal.aborted) return;
          if (!src) throw new Error("缩略图为空");
          faceThumbCache.set(cacheKey, src);
          if (faceThumbCache.size > FACE_THUMB_CACHE_MAX) {
            const oldest = faceThumbCache.keys().next().value;
            if (oldest !== undefined) faceThumbCache.delete(oldest);
          }
          setResult({ key: cacheKey, src });
        })
        .catch((error) => {
          if (!controller.signal.aborted) setResult({ key: cacheKey, error: String(error) });
        });
    }, { rootMargin: "120px" });
    observer.observe(node);
    return () => { controller.abort(); observer.disconnect(); };
  }, [active, cacheKey, clusterId, current, thumb]);

  return (
    <span ref={ref} className="flex h-full w-full items-center justify-center">
      {thumb ? <img src={thumb} alt="" decoding="async"
        className="h-full w-full rounded object-cover object-[center_25%]"
        onError={() => {
          faceThumbCache.delete(cacheKey);
          setResult({ key: cacheKey, error: "头像文件无法显示" });
        }} />
        : current?.error
          ? <span title={current.error} className="px-1 text-center text-xs text-text-muted">头像不可用</span>
          : <span className="h-full w-full rounded bg-bg-secondary/30 motion-safe:animate-pulse" aria-label="正在加载头像" />}
    </span>
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

export default React.memo(function FaceView({ active = true }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (searchParams.get("tab") as TabKey) || "named";
  const [clusters, setClusters] = useState<FaceCluster[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab);
  const activeTabRef = useRef<TabKey>(initialTab);
  const pageRequest = useRef(0);
  const loadedClusters = useRef({ tab: initialTab, count: 0 });
  const faceDataRevision = useStore((state) => state.faceDataRevision);
  const projectRoot = useStore((state) => state.project?.root_path);
  const [avatarRevision, setAvatarRevision] = useState(0);
  const avatarScope = JSON.stringify([projectRoot, faceDataRevision, avatarRevision]);
  const [pageTotal, setPageTotal] = useState(0);
  const [pageLoading, setPageLoading] = useState(false);
  const [unnamedQuery, setUnnamedQuery] = useState("");
  const [unnamedId, setUnnamedId] = useState<number>();
  const [unnamedQueryError, setUnnamedQueryError] = useState("");
  const clusterIdFilter = activeTab === "unnamed" ? unnamedId : undefined;
  const peopleResults = useRef<HTMLDivElement>(null);
  const [tabCounts, setTabCounts] = useState({ named: 0, unnamed: 0, review: 0 });
  const [mergeTargetClusters, setMergeTargetClusters] = useState<FaceCluster[]>([]);

  // Keep activeTab in sync with URL when navigating back from person photos
  useEffect(() => {
    const tabFromUrl = searchParams.get("tab") as TabKey;
    if (active && ["named", "unnamed", "review"].includes(tabFromUrl) && tabFromUrl !== activeTab) {
      activeTabRef.current = tabFromUrl;
      setActiveTab(tabFromUrl);
    }
  }, [active, searchParams.get("tab")]);

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
  const reviewSelectionAnchor = useRef<number>();
  const [confirmingReview, setConfirmingReview] = useState(false);
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false);
  const [mergeName, setMergeName] = useState("");
  const [mergeTargetId, setMergeTargetId] = useState<number | null>(null);
  const [mergeSaving, setMergeSaving] = useState(false);
  const [autoMergeOpen, setAutoMergeOpen] = useState(false);
  const [previewClusterId, setPreviewClusterId] = useState<number>();
  const [previewError, setPreviewError] = useState("");
  const lightboxPhotoId = useStore((state) => state.lightboxPhotoId);
  const [autoMergeThreshold, setAutoMergeThreshold] = useState(0.72);
  const [autoMergeRunning, setAutoMergeRunning] = useState(false);
  const [autoMergeCandidates, setAutoMergeCandidates] = useState<api.AutomaticFaceMergeCandidate[]>([]);
  const [autoMergeSelected, setAutoMergeSelected] = useState<Map<string, number[]>>(new Map());
  const [expandedMergeGroups, setExpandedMergeGroups] = useState<Set<string>>(new Set());
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
      const count = loadedClusters.current.tab === requestedTab
        ? Math.max(FACE_PAGE_SIZE, loadedClusters.current.count)
        : FACE_PAGE_SIZE;
      const [page, nextFaceCount, nextUnassignedCount] = await Promise.all([
        api.getClusterPage(requestedTab, 0, FACE_PAGE_SIZE, clusterIdFilter),
        api.getFaceDetectionCount().catch(() => 0),
        api.getUnassignedFaceCount().catch(() => 0),
      ]);
      const items = page.items;
      for (let offset = items.length; isCurrent() && offset < Math.min(count, page.total); offset = items.length) {
        const next = await api.getClusterPage(requestedTab, offset, FACE_PAGE_SIZE, clusterIdFilter);
        if (!next.items.length) break;
        items.push(...next.items);
      }
      if (isCurrent()) {
        loadedClusters.current = { tab: requestedTab, count: items.length };
        setClusters(items);
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
  }, [activeTab, clusterIdFilter]);

  const loadMoreClusters = useCallback(async () => {
    if (pageLoading || clusters.length >= pageTotal) return;
    const requestedTab = activeTab;
    const requestId = ++pageRequest.current;
    const isCurrent = () => pageRequest.current === requestId && activeTabRef.current === requestedTab;
    setPageLoading(true);
    try {
      const page = await api.getClusterPage(requestedTab, clusters.length, FACE_PAGE_SIZE, clusterIdFilter);
      if (!isCurrent()) return;
      loadedClusters.current = { tab: requestedTab, count: clusters.length + page.items.length };
      setClusters((current) => {
        const known = new Set(current.map((cluster) => cluster.id));
        return [...current, ...page.items.filter((cluster) => !known.has(cluster.id))];
      });
      setPageTotal(page.total);
      setTabCounts({ named: page.named_count, unnamed: page.unnamed_count, review: page.review_count });
    } finally {
      if (isCurrent()) setPageLoading(false);
    }
  }, [activeTab, clusterIdFilter, clusters.length, pageLoading, pageTotal]);

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
      setAvatarRevision((revision) => revision + 1);
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
    setAutoMergeSelected(new Map());
    setExpandedMergeGroups(new Set());
    setAutoMergePreviewed(false);
    setPreviewClusterId(undefined);
    setPreviewError("");
    setAutoMergeOpen(true);
  };

  const handlePreviewAutoMerge = async () => {
    setAutoMergeRunning(true);
    setOperationMessage("正在查找相似的未命名分组及可合入的已命名人物…");
    try {
      const healthy = await api.workerHealth();
      if (!healthy) {
        await api.startAiWorker();
        await new Promise(r => setTimeout(r, 2000));
      }
      const candidates = await api.previewAutoMergeUnnamedFaces(autoMergeThreshold);
      setAutoMergeCandidates(candidates);
      setAutoMergeSelected(new Map());
      setExpandedMergeGroups(new Set());
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

  const selectedMergeGroups = autoMergeCandidates.flatMap<{ ids: number[]; target: number | null }>((candidate) => {
    const selected = autoMergeSelected.get(candidateKey(candidate)) ?? [];
    const target = candidate.named_target_id;
    if (target != null && selected.length) return [{ ids: [target, ...selected], target }];
    return selected.length >= 2 ? [{ ids: selected, target: null }] : [];
  });
  const allMergeCandidatesSelected = autoMergeCandidates.every((candidate) =>
    autoMergeSelected.get(candidateKey(candidate))?.length === selectableMergeMembers(candidate).length,
  );

  useEffect(() => {
    if (!active || !autoMergeOpen || previewClusterId == null) return;
    let live = true;
    const filter = { person_id: previewClusterId };
    Promise.all([
      api.getPhotos(null, 80, filter),
      api.getPersonDetail(previewClusterId).catch(() => null),
    ]).then(async ([page, person]) => {
      if (!live) return;
      const first = page.photos[0]?.id;
      if (first == null) throw new Error("此人物没有可查看的照片");
      const cover = person?.cover_photo_id;
      const extraCover = cover != null && !page.photos.some((photo) => photo.id === cover)
        ? await api.getPhoto(cover).catch(() => null) : null;
      if (!live) return;
      const start = cover != null && (extraCover || page.photos.some((photo) => photo.id === cover)) ? cover : first;
      let cursor = page.next_cursor;
      let hasNext = page.has_more;
      useStore.getState().openLightbox(start, {
        candidatePersonId: previewClusterId,
        items: extraCover ? [extraCover, ...page.photos] : page.photos,
        loadNext: async () => {
          if (!hasNext || !cursor) return [];
          const next = await api.getPhotos(cursor, 80, filter);
          cursor = next.next_cursor;
          hasNext = next.has_more;
          return extraCover ? next.photos.filter((photo) => photo.id !== extraCover.id) : next.photos;
        },
      });
    }).catch((error) => {
      if (live) setPreviewError(String(error));
    }).finally(() => {
      if (live) setPreviewClusterId(undefined);
    });
    return () => { live = false; };
  }, [active, autoMergeOpen, previewClusterId]);

  const handleAutoMerge = async () => {
    const groups = selectedMergeGroups;
    if (groups.length === 0) return;
    setAutoMergeRunning(true);
    try {
      const result = await api.applyAutoMergeUnnamedFaces(
        groups.map(({ ids }) => ids),
        autoMergeThreshold,
        groups.flatMap(({ target }) => target == null ? [] : [target]),
      );
      setAvatarRevision((revision) => revision + 1);
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
      setAutoMergeSelected((selected) => { const next = new Map(selected); next.delete(key); return next; });
      setOperationMessage("已记住这些不是同一个人，今后不会再次自动推荐。");
    } catch (error) {
      setOperationMessage(`保存排除关系失败：${String(error)}`);
    }
  };

  const handleUndoAutomaticMerge = async () => {
    try {
      const result = await api.undoLastAutomaticFaceMerge();
      setAvatarRevision((revision) => revision + 1);
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
      setAvatarRevision((revision) => revision + 1);
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
      const tabName = clusters.find((cluster) => cluster.id === clusterId)?.name?.trim() ? "已命名" : "未命名";
      setOperationMessage(`已确认这是一个独立人物，可在「${tabName}」中查看。`);
    } catch (error) {
      setOperationMessage(`确认人物失败：${String(error)}`);
    }
  };

  const handleConfirmSelected = async () => {
    if (!mergeSelected.size || confirmingReview || mergeSaving) return;
    setConfirmingReview(true);
    try {
      const count = await api.confirmFaceClusters([...mergeSelected]);
      reviewSelectionAnchor.current = undefined;
      setMergeSelected(new Set());
      setMergeMode(false);
      await refreshData();
      setOperationMessage(`已确认 ${count} 个独立人物。可按命名状态在「未命名」或「已命名」中查看。`);
    } catch (error) {
      setOperationMessage(`批量确认失败：${String(error)}`);
    } finally {
      setConfirmingReview(false);
    }
  };

  const toggleMergeSelection = (clusterId: number, extend = false) => {
    if (confirmingReview || mergeSaving) return;
    const anchor = reviewSelectionAnchor.current;
    if (activeTab === "review" && extend && anchor != null) {
      const start = clusters.findIndex((cluster) => cluster.id === anchor);
      const end = clusters.findIndex((cluster) => cluster.id === clusterId);
      if (start >= 0 && end >= 0) {
        const range = clusters.slice(Math.min(start, end), Math.max(start, end) + 1);
        setMergeSelected((current) => new Set([...current, ...range.flatMap(({ id }) => id == null ? [] : [id])]));
        return;
      }
    }
    reviewSelectionAnchor.current = clusterId;
    setMergeSelected((current) => {
      const next = new Set(current);
      if (next.has(clusterId)) next.delete(clusterId); else next.add(clusterId);
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
    reviewSelectionAnchor.current = firstClusterId;
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
                setSearchParams({ tab }, { replace: true });
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
          {activeTab === "unnamed" && <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => {
            event.preventDefault();
            const value = unnamedQuery.trim().replace(/^(?:人物\s*)?#?\s*/, "");
            const id = Number(value);
            if (unnamedQuery.trim() && (!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id < 1)) {
              setUnnamedQueryError("请输入人物编号，例如 491 或 人物 491");
              return;
            }
            setUnnamedQueryError("");
            const next = value ? id : undefined;
            if (next === unnamedId) return;
            pageRequest.current++;
            loadedClusters.current.count = 0;
            setClusters([]);
            setPageTotal(0);
            setUnnamedId(next);
            peopleResults.current?.scrollTo({ top: 0 });
          }}>
            <input type="search" aria-label="检索未命名人物" placeholder="人物编号，如 491"
              value={unnamedQuery} maxLength={32}
              onChange={(event) => { setUnnamedQuery(event.target.value); setUnnamedQueryError(""); }}
              className="ui-input w-40" />
            <button type="submit" className="ui-button">检索</button>
            {unnamedId != null && <button type="button" className="ui-button" onClick={() => {
              pageRequest.current++;
              loadedClusters.current.count = 0;
              setClusters([]);
              setPageTotal(0);
              setUnnamedQueryError("");
              setUnnamedQuery("");
              setUnnamedId(undefined);
              peopleResults.current?.scrollTo({ top: 0 });
            }}>清除检索</button>}
            {unnamedQueryError && <span role="alert" className="text-xs text-red-600">{unnamedQueryError}</span>}
          </form>}
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
                disabled={mergeSelected.size < 1 || confirmingReview}
                className="bg-accent-primary text-white px-4 py-1.5 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
              >
                合并为一个人物 ({mergeSelected.size})
              </button>
              {activeTab === "review" && (
                <button type="button" className="ui-button-primary" onClick={() => void handleConfirmSelected()}
                  disabled={!mergeSelected.size || confirmingReview || mergeSaving}>
                  {confirmingReview ? "正在确认…" : `批量确认（${mergeSelected.size}）`}
                </button>
              )}
              {(activeTab === "unnamed" || activeTab === "review") && (
                <button
                  onClick={handleIgnoreSelectedPeople}
                  disabled={mergeSelected.size < 1 || mergeSaving || confirmingReview}
                  className="bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 px-4 py-1.5 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed border border-red-100"
                >
                  删除所选人物标记 ({mergeSelected.size})
                </button>
              )}
            </>
          )}
          {activeTab === "review" && !mergeMode && (
            <>
              <button onClick={() => startMergeMode("review")} className="ui-button">批量选择</button>
              <span className="text-xs text-text-muted">可批量确认独立人物，或把同一人的分组合并。</span>
            </>
          )}
          {mergeMode && mergeSelected.size > 0 && (
            <span className="text-xs text-text-muted">
              {mergeSelected.size} {"\u4e2a\u65cf\u7fa4\u5df2\u9009\u4e2d"}
            </span>
          )}
          {mergeMode && activeTab === "review" && <span className="text-xs text-text-muted">按住 Shift 点击可连续选择</span>}
          {mergeMode && (
            <button disabled={confirmingReview} onClick={() => { setMergeMode(false); setMergeSelected(new Set()); }} className="px-3 py-1.5 rounded-lg text-sm text-text-secondary hover:bg-text-primary/5">
              取消
            </button>
          )}
        </div>
      <div className="people-results" ref={peopleResults}>
        {clusterIdFilter != null && !pageLoading && !visibleClusters.length &&
          <p className="px-4 py-6 text-sm text-text-muted">未找到未命名人物 {clusterIdFilter}。</p>}
        <div className="people-grid">
          {visibleClusters.map((cluster) => (
            <div
              key={cluster.id}
              className={`people-card group cursor-pointer rounded-xl border transition-colors ${
                mergeMode && mergeSelected.has(cluster.id!)
                  ? "border-accent-primary bg-accent-primary/15"
                  : "border-surface-secondary/70 bg-bg-secondary hover:border-accent-primary/40"
              }`}
              onClick={(event) => {
                if (mergeMode) {
                  toggleMergeSelection(cluster.id!, event.shiftKey);
                } else {
                  navigate(`/?tab=${activeTab}&person=${cluster.id}`, { state: { returnTo: "faces" } });
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
                <FaceThumb clusterId={cluster.id!} scope={avatarScope} active={active && !groupPhotosOpen && !autoMergeOpen && !suspectedOpen} />
                {mergeMode && activeTab === "review" && (
                  <input type="checkbox" className="absolute top-2 right-2 h-5 w-5 accent-accent-primary"
                    aria-label={`选择${cluster.name || `人物 ${cluster.id}`}`}
                    checked={mergeSelected.has(cluster.id!)} disabled={confirmingReview || mergeSaving}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => toggleMergeSelection(cluster.id!, (event.nativeEvent as MouseEvent).shiftKey)} />
                )}
                {mergeMode && activeTab !== "review" && (
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
        <div className={`fixed inset-0 z-[1200] bg-black/30 backdrop-blur-sm flex items-center justify-center ${lightboxPhotoId ? "invisible pointer-events-none" : ""}`}
          aria-hidden={lightboxPhotoId != null || undefined}
          onMouseDown={() => !autoMergeRunning && setAutoMergeOpen(false)}>
          <div className="w-[680px] max-h-[86vh] overflow-y-auto rounded-2xl bg-bg-secondary p-6 shadow-2xl border border-text-primary/10" onMouseDown={(event) => event.stopPropagation()}>
            <h3 className="text-lg font-semibold text-text-primary">自动合并相似人物</h3>
            {previewError && <p role="alert" className="mt-2 text-sm text-red-600">打开大图失败：{previewError}</p>}
            <p className="text-sm text-text-muted mt-2 leading-6">
              查找相似的未命名分组，也可将它们合入已命名人物。同一张照片中同时出现的人物会被排除。
            </p>
            <div className="mt-5 rounded-xl bg-black/[0.035] p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">相似度阈值</span>
                <span className="font-semibold tabular-nums">{autoMergeThreshold.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min="0.35"
                max="0.90"
                aria-label="相似度阈值"
                disabled={autoMergeRunning}
                step="0.01"
                value={autoMergeThreshold}
                onChange={(event) => {
                  setAutoMergeThreshold(Number(event.target.value));
                  setAutoMergeCandidates([]);
                  setAutoMergeSelected(new Map());
                  setExpandedMergeGroups(new Set());
                  setAutoMergePreviewed(false);
                }}
                className="mt-3 w-full accent-blue-600"
              />
              <div className="mt-1 flex justify-between text-xs text-text-muted">
                <span>0.35 查找更多</span><span>0.72 平衡</span><span>0.90 更谨慎</span>
              </div>
              <p className="mt-3 text-xs text-text-secondary">
                {autoMergeThreshold < 0.60
                  ? "较低阈值可能找到更多侧脸，也会增加误匹配。请逐个勾选要合并的分组。"
                  : autoMergeThreshold < 0.68
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
                      disabled={autoMergeRunning}
                      onClick={() => setAutoMergeSelected(allMergeCandidatesSelected
                        ? new Map()
                        : new Map(autoMergeCandidates.map((candidate) => [candidateKey(candidate), selectableMergeMembers(candidate)])))}
                    >
                      {allMergeCandidatesSelected ? "全部取消" : "全部选择"}
                    </button>
                  )}
                </div>
                {autoMergeCandidates.length === 0 ? (
                  <div className="rounded-xl border border-text-primary/5 bg-black/[0.025] px-4 py-8 text-center text-sm text-text-muted">
                    当前阈值下没有可靠候选。可以稍微降低阈值后重新分析。
                  </div>
                ) : (
                  <div className="space-y-2 max-h-[330px] overflow-y-auto pr-1">
                    {autoMergeCandidates.map((candidate, index) => {
                      const key = candidateKey(candidate);
                      const expanded = expandedMergeGroups.has(key);
                      const ids = autoMergeSelected.get(key) ?? [];
                      const members = selectableMergeMembers(candidate);
                      const targetId = candidate.named_target_id;
                      const targetName = candidate.named_target_name;
                      const allSelected = ids.length === members.length;
                      const ready = ids.length >= (targetId != null ? 1 : 2);
                      return (
                        <div key={key} className={`rounded-xl border p-3 ${ready ? "border-accent-primary bg-accent-primary/5" : "border-text-primary/10 bg-bg-secondary"}`}>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                            <button
                              type="button"
                              className="ui-button inline-flex items-center gap-2 text-sm"
                              aria-expanded={expanded}
                              aria-controls={`merge-candidate-${key}`}
                              aria-label={`${expanded ? "收起" : "展开"}候选组 ${index + 1}`}
                              onClick={() => setExpandedMergeGroups((current) => {
                                const next = new Set(current);
                                if (next.has(key)) next.delete(key); else next.add(key);
                                return next;
                              })}
                            >
                              <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                              候选组 {index + 1} · {candidate.cluster_ids.length} 人
                            </button>
                            <span className="text-xs tabular-nums text-text-muted">相似度 {(candidate.similarity * 100).toFixed(1)}%</span>
                            <label className="ml-auto flex items-center gap-2 text-sm">
                              <input type="checkbox" checked={allSelected} disabled={autoMergeRunning}
                                aria-label={`整组选中候选组 ${index + 1}`}
                                ref={(input) => { if (input) input.indeterminate = ids.length > 0 && !allSelected; }}
                                onChange={(event) => {
                                  const checked = event.target.checked;
                                  setAutoMergeSelected((current) => new Map(current).set(key, checked ? members : []));
                                }} />
                              整组选择
                              <span className="text-xs tabular-nums text-text-muted">（{ids.length}/{members.length}）</span>
                            </label>
                            <button disabled={autoMergeRunning} onClick={() => handleRejectAutoMergeCandidate(candidate)}
                              className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs text-orange-700 dark:text-orange-300 hover:bg-orange-50">不是同一人</button>
                          </div>
                          {targetId != null && <p className="mt-2 text-sm font-medium text-accent-link">合入已命名人物：{targetName ?? `人物 ${targetId}`}</p>}
                          <div id={`merge-candidate-${key}`} className={expanded ? "mt-3 flex flex-wrap gap-2 border-t border-surface-secondary pt-3" : "hidden"}>
                            {expanded && (targetId == null ? members : [targetId, ...members]).map((id) => (
                              <div key={id} className="flex w-24 flex-col items-center gap-1 rounded-lg border border-surface-secondary p-1 text-xs">
                                <button type="button" className="relative h-16 w-16 overflow-hidden rounded-lg bg-surface-secondary"
                                  aria-label={`查看人物 ${id} 的大图`} title="查看大图" disabled={previewClusterId != null}
                                  onClick={() => { setPreviewError(""); setPreviewClusterId(id); }}>
                                  <FaceThumb clusterId={id} scope={avatarScope} active={active && lightboxPhotoId == null} />
                                  <span className="absolute inset-x-0 bottom-0 bg-black/65 py-0.5 text-white">{previewClusterId === id ? "加载中…" : "看大图"}</span>
                                </button>
                                {id === targetId
                                  ? <span className="max-w-full truncate text-accent-link" title={targetName ?? undefined}>{targetName ?? `人物 ${id}`}</span>
                                  : <label className="flex cursor-pointer items-center gap-1">
                                  <input type="checkbox" checked={ids.includes(id)} disabled={autoMergeRunning}
                                    onChange={(event) => {
                                      const checked = event.target.checked;
                                      setAutoMergeSelected((current) => {
                                        const selected = current.get(key) ?? [];
                                        return new Map(current).set(key, checked ? [...selected, id] : selected.filter((value) => value !== id));
                                      });
                                    }} />
                                  人物 {id}
                                </label>}
                              </div>
                            ))}
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
                  <button disabled={autoMergeRunning || selectedMergeGroups.length === 0} onClick={handleAutoMerge} className="px-4 py-2 rounded-lg bg-accent-primary text-white text-sm font-medium disabled:opacity-50">
                    {autoMergeRunning ? "正在合并…" : `确认合并 ${selectedMergeGroups.length} 组`}
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
