import { useEffect, useState } from "react";
import { useStore } from "../hooks/usePhotos";
import type { AiProcessingStatus } from "../types";

const labels: Record<string, string> = {
  start_worker: "检查本地 AI 服务",
  read_database: "读取待分组人脸",
  load_worker: "等待 AI 服务开始本批分组",
  read_embeddings: "读取人脸特征",
  compare_people: "与已有分组比对",
  prepare_distances: "计算组间距离",
  load_clustering: "加载聚类库",
  run_linkage: "计算新人物分组",
  retry_batch: "正在重启 AI 服务，随后重试本批",
  form_groups: "整理新分组",
  save_groups: "保存人物分组",
};

export function isGroupingFaces(ai: AiProcessingStatus | null) {
  return ai?.status === "running" && (ai.stage === "clustering" || ai.stage === "recovering_faces");
}

export default function FaceClusteringStatus({ ai }: { ai: AiProcessingStatus }) {
  const progress = useStore((state) => state.faceClusteringProgress);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!progress) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [progress?.updatedAt]);
  const phase = progress?.phase;
  const quietSeconds = progress ? Math.max(0, Math.floor((now - progress.updatedAt) / 1000)) : 0;
  return <div className="space-y-1 text-xs text-text-secondary" role="status">
    <p>
      {progress && progress.batch > 0 && <span className="font-medium">第 {progress.batch} 批 · </span>}
      {phase ? labels[phase.stage] ?? "正在整理人脸" : "正在准备本批人脸分组"}
      {!!phase?.total && <span className="ml-2 tabular-nums">{phase.done.toLocaleString()} / {phase.total.toLocaleString()}</span>}
    </p>
    <div className="flex items-center gap-2">
      <progress className="ui-progress" aria-label="人脸分组总进度" max={Math.max(ai.total, 1)} value={ai.total > 0 ? Math.min(ai.processed, ai.total) : undefined} />
      <span className="shrink-0 tabular-nums">已归组 {ai.processed.toLocaleString()} / {ai.total.toLocaleString()}</span>
    </div>
    {!!phase?.skipped && <p>本批有 {phase.skipped.toLocaleString()} 份特征无法读取。</p>}
    {quietSeconds >= 15 && <p className="text-amber-700 dark:text-amber-300">本阶段已有 {quietSeconds} 秒没有新进度。</p>}
  </div>;
}
