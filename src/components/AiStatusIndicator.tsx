import React, { useCallback } from "react";
import { useStore } from "../hooks/usePhotos";

const stageLabels: Record<string, string> = {
  starting: "正在准备智能分析…",
  recovering_faces: "正在恢复上次中断的人物整理…",
  face_detection: "正在识别人脸",
  classification: "正在理解照片内容",
  clustering: "正在整理人物…",
  clustering_done: "人物整理完成",
  geo_tagging: "正在补充地点信息",
  time_tagging: "正在整理拍摄时间",
  device_tagging: "正在识别拍摄设备",
  event_tagging: "正在整理旅行与事件",
  done: "智能分析已完成",
  clustering_error: "人物分组稍后重试",
  paused: "智能分析已暂停，断点已经保存",
  canceled: "智能分析已停止，已完成结果仍然保留",
};

/** Shared AI processing status indicator with progress bar. */
export default React.memo(function AiStatusIndicator() {
  const aiProcessingStatus = useStore((s) => s.aiProcessingStatus);
  const aiPipelineComplete = useStore((s) => s.aiPipelineComplete);
  const dismissPipeline = useCallback(() => {
    useStore.getState().setAiPipelineComplete(false);
    useStore.getState().setAiProcessingStatus(null);
  }, []);

  // Active processing state
  if (aiProcessingStatus && aiProcessingStatus.stage && aiProcessingStatus.stage !== "done" && aiProcessingStatus.stage !== "error") {
    return (
      <div className="mb-4 px-4 py-3 bg-white/70 rounded-xl border border-black/5 shadow-sm backdrop-blur-xl">
        <div className="flex items-center justify-between text-xs text-text-secondary mb-1">
          <span className="font-medium">{stageLabels[aiProcessingStatus.stage] || "正在进行智能分析…"}</span>
          {aiProcessingStatus.total > 0 && (
            <span>{aiProcessingStatus.processed}/{aiProcessingStatus.total}</span>
          )}
        </div>
        {aiProcessingStatus.total > 0 && aiProcessingStatus.stage !== "clustering" && (
          <div className="w-full bg-bg-tertiary rounded-full h-1.5">
            <div
              className="bg-accent-primary h-1.5 rounded-full transition-all duration-300"
              style={{ width: `${Math.min(100, (aiProcessingStatus.processed / aiProcessingStatus.total) * 100)}%` }}
            />
          </div>
        )}
      </div>
    );
  }

  // Pipeline complete banner
  if (aiPipelineComplete) {
    return (
      <div className="mb-4 px-4 py-3 bg-emerald-50 rounded-xl border border-emerald-100">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-emerald-700">智能分析已完成，人物与标签已自动更新</span>
          <button
            onClick={dismissPipeline}
            className="text-emerald-600/70 hover:text-emerald-700 ml-2"
          >
            知道了
          </button>
        </div>
      </div>
    );
  }

  // Error state
  if (aiProcessingStatus && aiProcessingStatus.stage === "error") {
    return (
      <div className="mb-4 px-4 py-3 bg-amber-50 rounded-xl border border-amber-100">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-amber-800">智能分析暂时暂停，下次打开图库时会自动重试</span>
          <button
            onClick={dismissPipeline}
            className="text-amber-700/70 hover:text-amber-800 ml-2"
          >
            关闭
          </button>
        </div>
      </div>
    );
  }

  return null;
});
