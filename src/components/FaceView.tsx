import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import type { FaceCluster } from "../types";
import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import GroupPhotosView from "./GroupPhotosView";
import FaceClusteringStatus, { isGroupingFaces } from "./FaceClusteringStatus";
import Icon from "./Icon";

interface Props { active?: boolean }

const mergeStageLabels: Record<string, string> = {
  start_worker: "检查本地 AI 服务",
  read_database: "读取人物分组",
  load_worker: "等待 AI Worker 开始分析",
  read_embeddings: "读取人脸特征",
  prepare_groups: "整理人物特征",
  find_neighbors: "查找相似人物",
  compare_pairs: "比较人物组合",
  build_candidates: "生成合并候选",
  done: "分析完成",
};

const FACE_PAGE_SIZE = 96;
const MERGE_PAGE_SIZE = 24;

const candidateKey = (candidate: api.AutomaticFaceMergeCandidate) => candidate.cluster_ids.join("-");

function selectableMergeMembers(candidate: api.AutomaticFaceMergeCandidate) {
  return candidate.cluster_ids.filter((id) => id !== candidate.named_target_id);
}

const faceThumbCache = new Map<string, string>();
const FACE_THUMB_CACHE_MAX = 512;
const EMPTY_MERGE_SELECTION: readonly number[] = [];

const faceThumbnailObservers = new WeakMap<Element, {
  observer: IntersectionObserver;
  listeners: Map<Element, (visible: boolean) => void>;
}>();

function observeFaceThumbnail(root: Element, node: Element, onVisibility: (visible: boolean) => void) {
  let tasks = faceThumbnailObservers.get(root);
  if (!tasks) {
    const listeners = new Map<Element, (visible: boolean) => void>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        listeners.get(entry.target)?.(entry.isIntersecting);
      }
    }, { root });
    tasks = { observer, listeners };
    faceThumbnailObservers.set(root, tasks);
  }
  const { observer, listeners } = tasks;
  listeners.set(node, onVisibility);
  observer.observe(node);
  return () => { listeners.delete(node); observer.unobserve(node); };
}

const FaceThumb = React.memo(function FaceThumb({ clusterId, faceId, scope, active, scrollRoot, usePersonAvatar = true }: ({ clusterId: number; faceId?: never } | { faceId: number; clusterId?: never }) & {
  scope: string;
  active: boolean;
  scrollRoot?: React.RefObject<HTMLDivElement>;
  usePersonAvatar?: boolean;
}) {
  const cacheKey = JSON.stringify([scope, clusterId ?? `face-${faceId}`, clusterId != null && usePersonAvatar]);
  const [result, setResult] = useState<{ key: string; src?: string; error?: string }>();
  const hasResult = useRef(false);
  const ref = useRef<HTMLSpanElement>(null);
  const current = result?.key === cacheKey ? result : undefined;
  const thumb = current?.src;

  useEffect(() => {
    const node = ref.current;
    if (!node || !active) return;

    let inFlight: AbortController | undefined;
    let releaseImage: ReturnType<typeof setTimeout> | undefined;
    const onVisibility = (visible: boolean) => {
      clearTimeout(releaseImage);
      if (!visible) {
        inFlight?.abort();
        inFlight = undefined;
        // Keep decoded images briefly for quick reverse scrolling.
        if (hasResult.current) {
          releaseImage = setTimeout(() => {
            hasResult.current = false;
            setResult(undefined);
          }, 300);
        }
        return;
      }
      if (inFlight) return;
      const cached = faceThumbCache.get(cacheKey);
      if (cached) {
        faceThumbCache.delete(cacheKey);
        faceThumbCache.set(cacheKey, cached);
        hasResult.current = true;
        setResult({ key: cacheKey, src: cached });
        return;
      }
      const controller = new AbortController();
      inFlight = controller;
      const request = faceId == null
        ? api.getClusterFaceThumbnail(clusterId!, controller.signal, usePersonAvatar)
        : api.getFaceThumbnail(faceId, controller.signal);
      request
        .then((src) => {
          if (controller.signal.aborted) return;
          if (!src) throw new Error("缩略图为空");
          faceThumbCache.set(cacheKey, src);
          if (faceThumbCache.size > FACE_THUMB_CACHE_MAX) {
            const oldest = faceThumbCache.keys().next().value;
            if (oldest !== undefined) faceThumbCache.delete(oldest);
          }
          hasResult.current = true;
          setResult({ key: cacheKey, src });
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            hasResult.current = true;
            setResult({ key: cacheKey, error: String(error) });
          }
        });
    };
    const cleanup = () => {
      inFlight?.abort();
      clearTimeout(releaseImage);
    };
    const root = scrollRoot?.current;
    if (root) {
      const stop = observeFaceThumbnail(root, node, onVisibility);
      return () => { cleanup(); stop(); };
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) onVisibility(entry.isIntersecting);
    }, { rootMargin: "120px" });
    observer.observe(node);
    return () => { cleanup(); observer.disconnect(); };
  }, [active, cacheKey, clusterId, faceId, scrollRoot, usePersonAvatar]);

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
          : <span className={`h-full w-full rounded bg-bg-secondary/30 ${scrollRoot ? "" : "motion-safe:animate-pulse"}`} aria-label="正在加载头像" />}
    </span>
  );
});

const MergeCandidateCard = React.memo(function MergeCandidateCard({
  candidate, index, expanded, selected, busy, previewId, scope, active, scrollRoot,
  onToggle, onSelect, onReject, onPreview,
}: {
  candidate: api.AutomaticFaceMergeCandidate;
  index: number;
  expanded: boolean;
  selected: readonly number[];
  busy: boolean;
  previewId?: number;
  scope: string;
  active: boolean;
  scrollRoot: React.RefObject<HTMLDivElement>;
  onToggle: (key: string) => void;
  onSelect: (key: string, selected: number[]) => void;
  onReject: (candidate: api.AutomaticFaceMergeCandidate) => void;
  onPreview: (id: number) => void;
}) {
  const key = candidateKey(candidate);
  const members = useMemo(() => selectableMergeMembers(candidate), [candidate]);
  const targetId = candidate.named_target_id;
  const targetName = candidate.named_target_name;
  const people = targetId == null ? members : [targetId, ...members];
  const allSelected = selected.length === members.length;
  const ready = selected.length >= (targetId == null ? 2 : 1);
  const avatars = useRef<HTMLDivElement>(null);
  const [avatarEdges, setAvatarEdges] = useState({ start: true, end: false });

  const scrollAvatars = (direction: number) => {
    const row = avatars.current;
    if (row) row.scrollBy({ left: direction * row.clientWidth });
  };

  return (
    <article className={`flex min-w-0 flex-col rounded-xl border px-3 py-2.5 ${ready
      ? "border-accent-primary/40 bg-accent-primary/5" : "border-surface-secondary bg-bg-secondary"}`}>
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <button type="button"
            className="inline-flex items-center gap-1 rounded text-left text-sm font-semibold text-text-primary hover:text-accent-link focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
            aria-expanded={expanded} aria-controls={`merge-candidate-${key}`}
            aria-label={`${expanded ? "收起" : "展开"}候选组 ${index}`}
            onClick={() => {
              if (expanded) setAvatarEdges({ start: true, end: false });
              onToggle(key);
            }}>
            <Icon name="chevronUp" size={13} className={expanded ? "rotate-180" : "rotate-90"} />
            候选组 {index}
          </button>
          <div className="mt-0.5 flex flex-wrap gap-x-1.5 text-xs tabular-nums text-text-muted">
            <span>{people.length} 人</span><span aria-hidden="true">·</span><span>{candidate.face_count} 张人脸</span>
          </div>
        </div>
        <span className="shrink-0 rounded-md bg-surface-primary px-1.5 py-1 text-xs tabular-nums text-text-secondary">
          相似度 <strong className="font-semibold text-text-primary">{(candidate.similarity * 100).toFixed(1)}%</strong>
        </span>
      </div>

      <div id={`merge-candidate-${key}`} hidden={!expanded} className="mt-2.5 border-t border-surface-secondary pt-2.5">
        {expanded && <div ref={avatars}
          className="grid grid-flow-col auto-cols-[calc((100%_-_1.5rem)/4)] gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="group" aria-label={`候选组 ${index} 的头像`}
          onScroll={({ currentTarget: row }) => {
            const start = row.scrollLeft < 1;
            const end = row.scrollLeft + row.clientWidth >= row.scrollWidth - 1;
            setAvatarEdges((edges) => edges.start === start && edges.end === end ? edges : { start, end });
          }}>
          {people.map((id) => (
            <div key={id} className="flex min-w-0 flex-col items-center gap-1">
              <button type="button"
                className="relative aspect-square w-14 max-w-full overflow-hidden rounded-md bg-surface-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                aria-label={`查看人物 ${id} 的大图`} title="查看大图" disabled={previewId != null}
                onClick={() => onPreview(id)}>
                <FaceThumb clusterId={id} scope={scope} active={active} scrollRoot={scrollRoot} usePersonAvatar={id === targetId} />
                {id === targetId && <span className="absolute left-0.5 top-0.5 rounded bg-accent-primary px-0.5 text-[10px] leading-4 text-white" aria-hidden="true">合入</span>}
                <span className="absolute bottom-0.5 right-0.5 grid place-items-center rounded bg-black/65 p-0.5 text-white"
                  aria-hidden="true"><Icon name={previewId === id ? "activity" : "photos"} size={12} /></span>
              </button>
              {id === targetId
                ? <span className="w-full truncate text-center text-xs font-semibold leading-5 text-accent-link"
                    title={`合入：${targetName ?? `人物 ${id}`}`}>{targetName ?? `人物 ${id}`}</span>
                : <label className="flex w-full cursor-pointer items-center justify-center gap-0.5 text-xs leading-5">
                  <input type="checkbox" className="shrink-0 accent-accent-primary" checked={selected.includes(id)} disabled={busy}
                    aria-label={`人物 ${id}`}
                    onChange={(event) => onSelect(key, event.target.checked ? [...selected, id] : selected.filter((value) => value !== id))} />
                  <span className="truncate tabular-nums" title={`人物 ${id}`}>{id}</span>
                </label>}
            </div>
          ))}
        </div>}
      </div>

      <div className="mt-auto flex min-w-0 items-center justify-between gap-1 pt-2.5 text-xs">
        <label className="flex cursor-pointer items-center gap-1">
          <input type="checkbox" className="accent-accent-primary" checked={allSelected} disabled={busy}
            aria-label={`整组选中候选组 ${index}`}
            ref={(input) => { if (input) input.indeterminate = selected.length > 0 && !allSelected; }}
            onChange={(event) => onSelect(key, event.target.checked ? members : [])} />
          整组
          <span className="tabular-nums text-text-muted">{selected.length}/{members.length}</span>
        </label>
        {expanded && people.length > 4 && <div className="flex">
          <button type="button" aria-label={`上一组头像（候选组 ${index}）`} title="上一组头像" disabled={avatarEdges.start}
            className="rounded px-0.5 py-1 text-text-secondary hover:bg-surface-primary disabled:opacity-30" onClick={() => scrollAvatars(-1)}>
            <Icon name="chevronUp" size={15} className="-rotate-90" />
          </button>
          <button type="button" aria-label={`下一组头像（候选组 ${index}）`} title="下一组头像" disabled={avatarEdges.end}
            className="rounded px-0.5 py-1 text-text-secondary hover:bg-surface-primary disabled:opacity-30" onClick={() => scrollAvatars(1)}>
            <Icon name="chevronUp" size={15} className="rotate-90" />
          </button>
        </div>}
        <button type="button" disabled={busy} onClick={() => onReject(candidate)}
          className="shrink-0 rounded px-1 py-1 text-orange-700 hover:bg-surface-primary dark:text-orange-300">不是同一人</button>
      </div>
    </article>
  );
});

function PersonProfileDialog({ person, scope, onClose, onSaved }: {
  person: FaceCluster;
  scope: string;
  onClose: () => void;
  onSaved: (person: FaceCluster, name: string, avatarChanged: boolean) => void;
}) {
  const personId = person.id!;
  const named = !!person.name?.trim();
  const [name, setName] = useState(person.name ?? "");
  const [items, setItems] = useState<api.PersonAvatarPage["items"]>([]);
  const [initialAvatar, setInitialAvatar] = useState<number | null | undefined>(named ? undefined : null);
  const [avatar, setAvatar] = useState<number | null>(null);
  const [nextAfter, setNextAfter] = useState<number | null>(null);
  const [after, setAfter] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(named);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const choices = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!named) return;
    let current = true;
    setLoading(true);
    setLoadError("");
    api.getPersonAvatarChoices(personId, after).then((page) => {
      if (!current) return;
      setItems((existing) => after == null ? page.items : [...existing, ...page.items]);
      setNextAfter(page.next_after);
      if (after == null) {
        setInitialAvatar(page.selected_face_id);
        setAvatar(page.selected_face_id);
      }
    }).catch((error) => {
      if (current) setLoadError(String(error));
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [after, named, personId, retry]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || initialAvatar === undefined || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      await api.savePersonProfile(personId, name.trim(), avatar);
      onSaved(person, name.trim(), avatar !== initialAvatar);
    } catch (error) {
      setSaveError(String(error));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[1200] grid place-items-center bg-black/40 p-3"
      onMouseDown={() => { if (!saving) onClose(); }}>
      <form role="dialog" aria-modal="true" aria-labelledby="person-profile-title" onSubmit={save}
        className={`flex max-h-[92vh] min-w-0 flex-col rounded-2xl border border-surface-secondary bg-bg-secondary p-4 shadow-2xl sm:p-5 ${named ? "w-full max-w-xl" : "w-full max-w-[360px]"}`}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === "Escape" && !saving) { event.stopPropagation(); onClose(); } }}>
        <h3 id="person-profile-title" className="text-lg font-semibold text-text-primary">{named ? "编辑人物" : "命名人物"}</h3>
        <label className="mt-3 block text-xs font-medium text-text-secondary">
          人物姓名
          <input className="ui-input mt-1 w-full" value={name} onChange={(event) => setName(event.target.value)}
            placeholder="输入人物姓名" autoFocus disabled={saving} />
        </label>
        {named && <section className="mt-4 flex min-h-0 flex-col" aria-labelledby="person-avatar-heading">
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-surface-secondary pt-3">
            <div>
              <h4 id="person-avatar-heading" className="text-sm font-semibold">人物头像</h4>
              <p className="mt-0.5 text-xs text-text-muted">{avatar == null ? "当前使用自动选图" : "已选自定义头像"}</p>
            </div>
            {avatar != null && !items.some((item) => item.face_id === avatar) && <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md bg-surface-secondary">
              <FaceThumb faceId={avatar} scope={scope} active />
            </div>}
          </div>
          <div ref={choices} className="mt-2 min-h-0 overflow-y-auto overscroll-contain pr-1" aria-busy={loading}>
            {initialAvatar !== undefined && (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(75px,1fr))] gap-2 pb-1">
                <button type="button" disabled={saving} aria-pressed={avatar == null} onClick={() => setAvatar(null)}
                  className={`relative grid aspect-square place-content-center justify-items-center gap-1 rounded-lg border text-xs ${avatar == null ? "border-accent-primary bg-accent-primary/10 text-accent-link" : "border-surface-secondary bg-surface-primary text-text-secondary"}`}>
                  <Icon name="photos" size={20} /> 自动选图
                </button>
                {items.map((item) => (
                  <button key={item.face_id} type="button" disabled={saving} aria-label={`使用 ${item.filename} 中的人脸作为头像`}
                    title={item.filename} aria-pressed={avatar === item.face_id} onClick={() => setAvatar(item.face_id)}
                    className={`relative aspect-square overflow-hidden rounded-lg border-2 bg-surface-secondary ${avatar === item.face_id ? "border-accent-primary" : "border-transparent hover:border-accent-primary/40"}`}>
                    <FaceThumb faceId={item.face_id} scope={scope} active scrollRoot={choices} />
                    {avatar === item.face_id && <span aria-hidden="true" className="absolute bottom-0.5 right-0.5 rounded bg-accent-primary px-1 text-xs text-white">✓</span>}
                  </button>
                ))}
              </div>
            )}
            {loading && <p className="py-3 text-xs text-text-muted" role="status">正在读取可选头像…</p>}
            {loadError && <div className="py-2 text-xs">
              <p role="alert" className="break-words text-red-600">读取头像失败：{loadError}</p>
              <button className="ui-button mt-1" type="button" onClick={() => setRetry((value) => value + 1)}>重试读取</button>
            </div>}
            {!loading && !loadError && initialAvatar !== undefined && items.length === 0 &&
              <p className="py-2 text-xs text-text-muted">此人物暂无可用的人脸照片。</p>}
            {!loading && !loadError && nextAfter !== null && <button className="ui-button mt-2" type="button" disabled={saving}
              onClick={() => setAfter(nextAfter)}>加载更多头像</button>}
          </div>
        </section>}
        {saveError && <p role="alert" className="mt-2 break-words text-xs text-red-600">保存失败：{saveError}</p>}
        <div className="mt-4 flex shrink-0 justify-end gap-2 border-t border-surface-secondary pt-3">
          <button type="button" disabled={saving} onClick={onClose} className="ui-button">取消</button>
          <button type="submit" className="ui-button-primary" disabled={saving || !name.trim() || initialAvatar === undefined}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}

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

  const [editingPerson, setEditingPerson] = useState<FaceCluster | null>(null);
  const [profileAvatarRevisions, setProfileAvatarRevisions] = useState<Map<number, number>>(new Map());
  const [aiRunning, setAiRunning] = useState(false);
  const [clustering, setClustering] = useState(false);
  const [workerHealthy, setWorkerHealthy] = useState(false);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const faceActions = useRef<HTMLDetailsElement>(null);
  const faceActionsTrigger = useRef<HTMLElement>(null);
  const ai = useStore((state) => state.aiProcessingStatus);
  const aiStatus = ai?.status;
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
  const [analysisError, setAnalysisError] = useState("");
  const [analysisSkipped, setAnalysisSkipped] = useState(0);
  const [analysisStarted, setAnalysisStarted] = useState<number>();
  const [analysisClock, setAnalysisClock] = useState(Date.now);
  const [analysisProgress, setAnalysisProgress] = useState<(api.AutomaticFaceMergeProgress & { updatedAt: number })>();
  const activeAnalysis = useRef<string>();

  useEffect(() => {
    if (analysisStarted == null) return;
    const timer = window.setInterval(() => setAnalysisClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [analysisStarted]);
  const [autoMergeCandidates, setAutoMergeCandidates] = useState<api.AutomaticFaceMergeCandidate[]>([]);
  const [autoMergeSelected, setAutoMergeSelected] = useState<Map<string, number[]>>(new Map());
  const [collapsedMergeGroups, setCollapsedMergeGroups] = useState<Set<string>>(new Set());
  const [mergePage, setMergePage] = useState(1);
  const mergeResults = useRef<HTMLDivElement>(null);
  const [autoMergePreviewed, setAutoMergePreviewed] = useState(false);
  const [hasMergeUndo, setHasMergeUndo] = useState(false);
  const [suspectedFaceCount, setSuspectedFaceCount] = useState(0);
  const [suspectedFaces, setSuspectedFaces] = useState<api.SuspectedFace[]>([]);
  const [suspectedOpen, setSuspectedOpen] = useState(false);
  const [canReanalyzeFaces, setCanReanalyzeFaces] = useState(false);
  const [maintenanceAction, setMaintenanceAction] = useState<"rebuild" | "reanalyze" | null>(null);
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
        api.getClusterPage(requestedTab, 0, Math.min(count, 200), clusterIdFilter),
        api.getFaceDetectionCount().catch(() => 0),
        api.getUnassignedFaceCount().catch(() => 0),
      ]);
      const items = page.items;
      for (let offset = items.length; isCurrent() && offset < Math.min(count, page.total); offset = items.length) {
        const next = await api.getClusterPage(requestedTab, offset, Math.min(count - offset, 200), clusterIdFilter);
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
    } catch (error) {
      if (isCurrent()) setOperationMessage(`加载更多人物失败：${String(error)}`);
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
    setOperationMessage(null);
    try {
      const result = await api.runFaceClustering();
      setOperationMessage(result);
      await refreshData();
    } catch (err) {
      console.error("Clustering failed:", err);
      setOperationMessage("人物整理暂时无法完成：" + err);
    } finally {
      setClustering(false);
    }
  };

  const handleFullRecluster = async () => {
    setClustering(true);
    setOperationMessage("正在用已有的人脸特征重建人物分组…");
    try {
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

  const resetMergeResults = () => {
    setAutoMergeCandidates([]);
    setAutoMergeSelected(new Map());
    setCollapsedMergeGroups(new Set());
    setMergePage(1);
    setAutoMergePreviewed(false);
  };

  const openAutoMerge = () => {
    resetMergeResults();
    setPreviewClusterId(undefined);
    setPreviewError("");
    setAnalysisError("");
    setAnalysisProgress(undefined);
    setAutoMergeOpen(true);
  };

  const handlePreviewAutoMerge = async () => {
    if (activeAnalysis.current || autoMergeRunning) return;
    const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0")).join("");
    const started = Date.now();
    activeAnalysis.current = requestId;
    setAnalysisStarted(started);
    setAnalysisClock(started);
    setAnalysisProgress({ stage: "start_worker", done: 0, total: 0, skipped: 0, updatedAt: started });
    setAnalysisError("");
    resetMergeResults();
    setAutoMergeRunning(true);
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<{ requestId: string; progress: api.AutomaticFaceMergeProgress }>(
        "automatic-face-merge-progress",
        ({ payload }) => {
          if (payload.requestId === requestId) {
            setAnalysisProgress({ ...payload.progress, updatedAt: Date.now() });
          }
        },
      );
      const healthy = await api.workerHealth();
      if (!healthy) await api.startAiWorker();
      const { candidates, skipped } = await api.previewAutoMergeUnnamedFaces(autoMergeThreshold, requestId);
      setAutoMergeCandidates([...candidates].sort((left, right) =>
        Number(right.named_target_id != null) - Number(left.named_target_id != null)
        || right.face_count - left.face_count
        || right.similarity - left.similarity,
      ));
      setAnalysisSkipped(skipped);
      setAutoMergePreviewed(true);
    } catch (error) {
      setAnalysisError(String(error));
    } finally {
      unlisten?.();
      activeAnalysis.current = undefined;
      setAnalysisStarted(undefined);
      setAutoMergeRunning(false);
    }
  };

  const selectedMergeGroups = useMemo(() => autoMergeCandidates.flatMap<{ ids: number[]; target: number | null }>((candidate) => {
    const selected = autoMergeSelected.get(candidateKey(candidate)) ?? [];
    const target = candidate.named_target_id;
    if (target != null && selected.length) return [{ ids: [target, ...selected], target }];
    return selected.length >= 2 ? [{ ids: selected, target: null }] : [];
  }), [autoMergeCandidates, autoMergeSelected]);

  const mergePageCount = Math.max(1, Math.ceil(autoMergeCandidates.length / MERGE_PAGE_SIZE));
  const currentMergePage = Math.min(mergePage, mergePageCount);
  const firstMergeIndex = (currentMergePage - 1) * MERGE_PAGE_SIZE;
  const visibleMergeCandidates = autoMergeCandidates.slice(firstMergeIndex, firstMergeIndex + MERGE_PAGE_SIZE);
  const allVisibleMergeCandidatesSelected = visibleMergeCandidates.every((candidate) =>
    autoMergeSelected.get(candidateKey(candidate))?.length === selectableMergeMembers(candidate).length,
  );

  const goToMergePage = (page: number) => {
    setMergePage(Math.min(mergePageCount, Math.max(1, page)));
    if (mergeResults.current) mergeResults.current.scrollTop = 0;
  };

  const toggleMergeCandidate = useCallback((key: string) => {
    setCollapsedMergeGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const selectMergeCandidate = useCallback((key: string, selected: number[]) => {
    setAutoMergeSelected((current) => {
      const next = new Map(current);
      if (selected.length) next.set(key, selected); else next.delete(key);
      return next;
    });
  }, []);

  const previewMergeCandidate = useCallback((id: number) => {
    setPreviewError("");
    setPreviewClusterId(id);
  }, []);

  const toggleMergePageSelection = () => {
    setAutoMergeSelected((current) => {
      const next = new Map(current);
      for (const candidate of visibleMergeCandidates) {
        const key = candidateKey(candidate);
        if (allVisibleMergeCandidatesSelected) next.delete(key);
        else next.set(key, selectableMergeMembers(candidate));
      }
      return next;
    });
  };

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

  const handleRejectAutoMergeCandidate = useCallback(async (candidate: api.AutomaticFaceMergeCandidate) => {
    try {
      await api.rejectAutoMergeCandidate(candidate.cluster_ids);
      const key = candidateKey(candidate);
      setAutoMergeCandidates((items) => items.filter((item) => candidateKey(item) !== key));
      setAutoMergeSelected((selected) => { const next = new Map(selected); next.delete(key); return next; });
      setOperationMessage("已记住这些不是同一个人，今后不会再次自动推荐。");
    } catch (error) {
      setOperationMessage(`保存排除关系失败：${String(error)}`);
    }
  }, []);

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

  const handleCancelRecognition = async (ids: number[]) => {
    if (ids.length === 0) return;
    if (!window.confirm(`取消识别这 ${ids.length} 个人物分组？\n\n这些人脸将从人物页移除。原始照片会保留，可以从人物操作菜单恢复。`)) return;
    setMergeSaving(true);
    try {
      const result = await api.ignoreFaceClusters(ids);
      setMergeSelected(new Set());
      setMergeMode(false);
      useStore.getState().markFaceDataChanged();
      setOperationMessage(result);
    } catch (error) {
      setOperationMessage(`取消识别失败：${String(error)}`);
    } finally {
      setMergeSaving(false);
    }
  };

  const handleRestoreIgnoredFaces = async () => {
    if (!window.confirm(`恢复全部 ${ignoredFaceCount} 张已忽略人脸吗？它们会在下次人物整理时重新出现。`)) return;
    try {
      const result = await api.restoreAllIgnoredFaces();
      useStore.getState().markFaceDataChanged();
      setOperationMessage(result);
    } catch (error) {
      setOperationMessage(`恢复已忽略人脸失败：${String(error)}`);
    }
  };

  const handleProfileSaved = (person: FaceCluster, name: string, avatarChanged: boolean) => {
    setEditingPerson(null);
    if (avatarChanged) {
      faceThumbCache.delete(JSON.stringify([avatarScope, person.id, true]));
      setProfileAvatarRevisions((current) => {
        const next = new Map(current);
        next.set(person.id!, (next.get(person.id!) ?? 0) + 1);
        return next;
      });
    }
    if (person.name !== name) useStore.getState().markFaceDataChanged();
    else if (activeTab === "review" || person.confidence === "low") void refreshData();
    setOperationMessage(avatarChanged ? "已更新人物头像。" : `已保存人物“${name}”。`);
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
                  <button type="button" onClick={() => runFaceAction(handleRunClustering)} disabled={maintenanceDisabled} className={faceActionClass}>
                    <span className="block">整理待分组人脸</span>
                    <span className="mt-0.5 block text-xs text-text-secondary">把已识别的人脸归到人物分组</span>
                  </button>
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
                  <button type="button" onClick={() => runFaceAction(() => setMaintenanceAction("rebuild"))} disabled={maintenanceDisabled} className={faceActionClass}>
                    <span className="block">重建自动分组…</span>
                    <span className="mt-0.5 block text-xs text-text-secondary">用已有的人脸特征重新分组</span>
                  </button>
                  {canReanalyzeFaces && <button type="button" onClick={() => runFaceAction(() => setMaintenanceAction("reanalyze"))} disabled={maintenanceDisabled} className={faceActionClass}>
                    <span className="block">重新分析人脸…</span>
                    <span className="mt-0.5 block text-xs text-text-secondary">重新读取照片并检测人脸</span>
                  </button>}
                  {maintenanceDisabled && <p className="px-3 py-1 text-xs text-text-muted">请在当前分析或分组任务结束后操作。</p>}
                </div>
              </div>
            </details>
          </div>
        </div>

        {ai && isGroupingFaces(ai) && <div className="mb-4 rounded-xl border border-text-primary/5 bg-bg-secondary px-4 py-2.5">
          <FaceClusteringStatus ai={ai} />
        </div>}
        {ai?.status === "error" && ai.stage === "clustering_error" && ai.last_error && !operationMessage && (
          <p role="alert" className="mb-4 break-words rounded-xl border border-text-primary/5 bg-bg-secondary px-4 py-2.5 text-sm text-red-600">{ai.last_error}</p>
        )}
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
                  onClick={() => void handleCancelRecognition(Array.from(mergeSelected))}
                  disabled={mergeSelected.size < 1 || mergeSaving || confirmingReview}
                  className="bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 px-4 py-1.5 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed border border-red-100"
                >
                  取消识别所选 ({mergeSelected.size})
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
                  setEditingPerson(cluster);
                }
              }}
            >
              <div className="w-full aspect-square overflow-hidden rounded-lg bg-surface-secondary relative">
                <FaceThumb clusterId={cluster.id!}
                  scope={profileAvatarRevisions.has(cluster.id!) ? `${avatarScope}:${profileAvatarRevisions.get(cluster.id!)}` : avatarScope}
                  scrollRoot={peopleResults}
                  usePersonAvatar={!!cluster.name?.trim()}
                  active={active && !groupPhotosOpen && !autoMergeOpen && !suspectedOpen && !editingPerson} />
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
                      setEditingPerson(cluster);
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
                <div className={`mt-2 grid gap-1 px-1 pb-1 ${cluster.name?.trim() ? "grid-cols-3" : "grid-cols-2"}`}>
                  <button
                    type="button"
                    onClick={(event) => { event.stopPropagation(); void handleConfirmCluster(cluster.id!); }}
                    className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 px-1 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100"
                    title="确认这是一个独立人物"
                  >确认</button>
                  <button
                    type="button"
                    onClick={(event) => { event.stopPropagation(); setEditingPerson(cluster); }}
                    className="rounded-lg bg-black/[0.045] px-1 py-1.5 text-xs text-text-secondary hover:bg-text-primary/[0.08]"
                  >命名</button>
                  <button
                    type="button"
                    onClick={(event) => { event.stopPropagation(); startMergeMode("review", cluster.id!); }}
                    className="rounded-lg bg-orange-50 dark:bg-orange-950/40 px-1 py-1.5 text-xs text-orange-700 dark:text-orange-300 hover:bg-orange-100"
                  >合并</button>
                  {!cluster.name?.trim() && <button type="button" disabled={mergeSaving}
                    className="rounded-lg px-1 py-1.5 text-xs text-red-700 hover:bg-surface-primary dark:text-red-300"
                    onClick={(event) => { event.stopPropagation(); void handleCancelRecognition([cluster.id!]); }}>取消识别</button>}
                </div>
              )}
              {activeTab === "unnamed" && !mergeMode && <button type="button" disabled={mergeSaving}
                className="mt-1 rounded px-1 py-1 text-xs text-text-muted hover:bg-surface-primary hover:text-red-700"
                onClick={(event) => { event.stopPropagation(); void handleCancelRecognition([cluster.id!]); }}>取消识别</button>}
            </div>
          ))}
        </div>

        {clusters.length < pageTotal && (
          <div className="flex justify-center py-8 [overflow-anchor:none]">
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
                <p className="text-sm">{isGroupingFaces(ai)
                  ? "可以离开此页面，在后台任务里查看进度。"
                  : aiStatus === "error" || aiStatus === "paused"
                    ? "可在后台任务查看状态并继续处理。"
                    : "可从人物操作菜单开始整理。"}</p>
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

      {maintenanceAction && (
        <div className="fixed inset-0 z-[1200] grid place-items-center bg-black/40 p-3"
          onMouseDown={() => setMaintenanceAction(null)}>
          <div role="alertdialog" aria-modal="true" aria-labelledby="people-maintenance-title" aria-describedby="people-maintenance-impact"
            className="w-full max-w-md rounded-2xl border border-surface-secondary bg-bg-secondary p-5 shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") setMaintenanceAction(null);
              if (event.key !== "Tab") return;
              const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
              const first = buttons[0];
              const last = buttons[buttons.length - 1];
              if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
                event.preventDefault();
                (event.shiftKey ? last : first)?.focus();
              }
            }}>
            <h3 id="people-maintenance-title" className="text-lg font-semibold">
              {maintenanceAction === "rebuild" ? "确认重建自动分组？" : "确认重新分析人脸？"}
            </h3>
            <div id="people-maintenance-impact" className="mt-3 space-y-2 text-sm leading-6 text-text-secondary">
              <p>原始照片、已命名和已人工确认的人物分组、已设置的头像及已忽略的人脸会保留。</p>
              {maintenanceAction === "rebuild"
                ? <p className="font-medium text-text-primary">使用已有特征清空并重算自动分组。尚未确认的未命名人物及待审核分组可能改变。重建后的自动分组无法恢复到重建前。</p>
                : <p className="font-medium text-text-primary">重新读取照片并检测人脸，现有自动检测结果和自动分组可能改变。自动合并的撤销记录会被清除。</p>}
              {maintenanceAction === "reanalyze" && <p>这个过程可能耗时，启动后可在后台任务查看进度。</p>}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="ui-button" autoFocus onClick={() => setMaintenanceAction(null)}>取消</button>
              <button type="button" className="ui-button rounded-lg border-red-700 bg-red-700 font-medium text-white hover:!bg-red-800"
                disabled={maintenanceDisabled} onClick={() => {
                  const action = maintenanceAction;
                  setMaintenanceAction(null);
                  void (action === "rebuild" ? handleFullRecluster() : handleFaceReanalysis());
                }}>{maintenanceAction === "rebuild" ? "确认重建" : "确认重新分析"}</button>
            </div>
          </div>
        </div>
      )}

      {editingPerson && (
        <PersonProfileDialog key={`${projectRoot}:${editingPerson.id}`} person={editingPerson} scope={avatarScope}
          onClose={() => setEditingPerson(null)} onSaved={handleProfileSaved} />
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
        <div className={`fixed inset-0 z-[1200] bg-black/40 flex items-center justify-center ${lightboxPhotoId ? "invisible pointer-events-none" : ""}`}
          aria-hidden={lightboxPhotoId != null || undefined}
          onMouseDown={() => !autoMergeRunning && setAutoMergeOpen(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="auto-merge-title"
            className={`flex max-h-[94vh] w-[calc(100%_-_1.5rem)] max-w-[1440px] flex-col overflow-y-auto rounded-2xl border border-text-primary/10 bg-bg-secondary p-4 shadow-2xl sm:p-5 ${autoMergeCandidates.length > 0 ? "h-[94vh]" : ""}`}
            onMouseDown={(event) => event.stopPropagation()}>
            <h3 id="auto-merge-title" className="shrink-0 text-lg font-semibold text-text-primary">自动合并相似人物</h3>
            {previewError && <p role="alert" className="mt-2 text-sm text-red-600">打开大图失败：{previewError}</p>}
            <p className="mt-1 shrink-0 text-sm leading-6 text-text-muted">
              查找相似的未命名分组，也可将它们合入已命名人物。同一张照片中同时出现的人物会被排除。
            </p>
            <div className="mt-3 shrink-0 rounded-xl bg-surface-primary px-4 py-2.5">
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
                  resetMergeResults();
                }}
                className="mt-2 w-full accent-accent-primary"
              />
              <div className="mt-1 flex justify-between text-xs text-text-muted">
                <span>0.35 查找更多</span><span>0.72 平衡</span><span>0.90 更谨慎</span>
              </div>
              <p className="mt-2 text-xs text-text-secondary">
                {autoMergeThreshold < 0.60
                  ? "较低阈值可能找到更多侧脸，也会增加误匹配。请逐个勾选要合并的分组。"
                  : autoMergeThreshold < 0.68
                  ? "当前设置较宽松，适合人物较少、拍摄跨度较大的相册。建议合并后抽查。"
                  : autoMergeThreshold < 0.80
                    ? "平衡模式：允许表情和角度变化，同时要求多张脸互相支持。"
                    : "谨慎模式：只合并非常相似的分组，误合风险最低。"}
              </p>
            </div>
            {analysisStarted != null && analysisProgress && (
              <div className="mt-4 space-y-2 rounded-xl border border-surface-secondary px-4 py-3" role="status">
                <div className="flex justify-between gap-2 text-sm">
                  <span>{mergeStageLabels[analysisProgress.stage] ?? "正在分析"}</span>
                  <span className="text-text-muted tabular-nums">已用时 {Math.max(0, Math.floor((analysisClock - analysisStarted) / 1000))} 秒</span>
                </div>
                <progress className="h-2 w-full accent-accent-primary" aria-label="当前阶段进度"
                  max={analysisProgress.total || 1}
                  value={analysisProgress.total ? analysisProgress.done : undefined} />
                {analysisProgress.total > 0 && <p className="text-xs text-text-muted tabular-nums">{analysisProgress.done.toLocaleString()} / {analysisProgress.total.toLocaleString()}</p>}
                {analysisClock - analysisProgress.updatedAt >= 15_000 && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">本阶段已有 {Math.floor((analysisClock - analysisProgress.updatedAt) / 1000)} 秒没有新进度。</p>
                )}
              </div>
            )}
            {analysisError && <p className="mt-4 break-words text-sm text-red-600 dark:text-red-400" role="alert">
              分析失败：{analysisError}
            </p>}
            {autoMergePreviewed && analysisSkipped > 0 && <p className="mt-4 text-sm text-amber-700 dark:text-amber-300">
              跳过了 {analysisSkipped} 份缺失或无法读取的人脸特征。
            </p>}
            {autoMergePreviewed && (
              <div className="mt-4 flex min-h-40 flex-1 flex-col">
                <div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <span className="text-sm font-medium">候选结果（{autoMergeCandidates.length.toLocaleString()} 组）</span>
                  {autoMergeCandidates.length > 0 && (
                    <div className="flex flex-wrap items-center gap-3 text-xs">
                      <button type="button" className="text-accent-link disabled:opacity-50" disabled={autoMergeRunning} onClick={toggleMergePageSelection}>
                        {allVisibleMergeCandidatesSelected ? "取消本页选择" : "全选本页"}
                      </button>
                      {autoMergeSelected.size > 0 && <button type="button" className="text-accent-link disabled:opacity-50" disabled={autoMergeRunning}
                        onClick={() => setAutoMergeSelected(new Map())}>清除所有选择</button>}
                    </div>
                  )}
                </div>
                {autoMergeCandidates.length === 0 ? (
                  <div className="rounded-xl border border-text-primary/5 bg-black/[0.025] px-4 py-8 text-center text-sm text-text-muted">
                    当前阈值下没有可靠候选。可以稍微降低阈值后重新分析。
                  </div>
                ) : (
                  <div ref={mergeResults} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-2.5">
                      {visibleMergeCandidates.map((candidate, pageIndex) => {
                        const key = candidateKey(candidate);
                        return <MergeCandidateCard
                          key={key}
                          candidate={candidate}
                          index={firstMergeIndex + pageIndex + 1}
                          expanded={!collapsedMergeGroups.has(key)}
                          selected={autoMergeSelected.get(key) ?? EMPTY_MERGE_SELECTION}
                          busy={autoMergeRunning}
                          previewId={previewClusterId}
                          scope={avatarScope}
                          active={active && lightboxPhotoId == null}
                          scrollRoot={mergeResults}
                          onToggle={toggleMergeCandidate}
                          onSelect={selectMergeCandidate}
                          onReject={handleRejectAutoMergeCandidate}
                          onPreview={previewMergeCandidate}
                        />;
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="mt-4 flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-text-primary/10 pt-3">
              {autoMergePreviewed && mergePageCount > 1 && (
                <nav className="flex flex-wrap items-center gap-2 text-sm" aria-label="候选结果分页">
                  <button type="button" className="ui-button" disabled={autoMergeRunning || currentMergePage === 1}
                    onClick={() => goToMergePage(currentMergePage - 1)}>上一页</button>
                  <span className="tabular-nums text-text-muted" aria-live="polite">第 {currentMergePage} / {mergePageCount} 页</span>
                  <button type="button" className="ui-button" disabled={autoMergeRunning || currentMergePage === mergePageCount}
                    onClick={() => goToMergePage(currentMergePage + 1)}>下一页</button>
                  <form key={currentMergePage} className="flex items-center gap-1" onSubmit={(event) => {
                    event.preventDefault();
                    const page = Number(new FormData(event.currentTarget).get("page"));
                    if (Number.isInteger(page)) goToMergePage(page);
                  }}>
                    <input className="ui-input w-20" name="page" type="number" min={1} max={mergePageCount}
                      aria-label="跳转到页码" placeholder="页码" required disabled={autoMergeRunning} />
                    <button type="submit" className="ui-button" disabled={autoMergeRunning}>跳转</button>
                  </form>
                </nav>
              )}
              <div className="ml-auto flex flex-wrap justify-end gap-2">
                <button disabled={autoMergeRunning} onClick={() => setAutoMergeOpen(false)} className="px-4 py-2 rounded-lg text-sm text-text-secondary hover:bg-text-primary/5 disabled:opacity-50">取消</button>
                {!autoMergePreviewed ? (
                  <button disabled={autoMergeRunning} onClick={handlePreviewAutoMerge} className="px-4 py-2 rounded-lg bg-accent-primary text-white text-sm font-medium disabled:opacity-50">
                    {autoMergeRunning ? "正在分析…" : analysisError ? "重试分析" : "查找合并候选"}
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
