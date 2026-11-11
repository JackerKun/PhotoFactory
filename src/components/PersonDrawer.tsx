import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { PersonDetail } from "../types";
import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";

interface Props {
  personId: number;
  onClose: () => void;
  onSelectPhoto: (id: number) => void;
  onRename: (name: string) => Promise<void>;
}

export default function PersonDrawer({ personId, onClose, onSelectPhoto: _onSelectPhoto, onRename }: Props) {
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [timeline, setTimeline] = useState<[string, number][]>([]);
  const [tags, setTags] = useState<[string, number][]>([]);
  const [editName, setEditName] = useState("");
  const [editing, setEditing] = useState(false);
  const navigate = useNavigate();
  const { setFilter } = useStore();

  useEffect(() => {
    setDetail(null);
    setTimeline([]);
    setTags([]);
    setEditing(false);
    api.getPersonDetail(personId).then(setDetail).catch(console.error);
    api.getPersonTimeline(personId).then(setTimeline).catch(() => setTimeline([]));
    api.getPersonSceneTags(personId).then(setTags).catch(() => setTags([]));
  }, [personId]);

  useEffect(() => {
    setEditName(detail?.user_name || `Person #${personId}`);
  }, [detail, personId]);

  const handleSaveName = useCallback(async () => {
    if (editName.trim()) {
      await onRename(editName.trim());
      setEditing(false);
    }
  }, [editName, onRename]);

  const handleViewAllPhotos = useCallback(() => {
    setFilter({ person_id: personId });
    navigate("/");
    onClose();
  }, [personId, navigate, onClose, setFilter]);

  // Timeline: find the max count for bar scaling
  const maxCount = timeline.length > 0 ? Math.max(...timeline.map(([, c]) => c)) : 1;

  return (
    <div className="fixed inset-0 z-50 bg-black/30" onClick={onClose}>
      <div
        className="absolute right-0 top-0 h-full w-96 bg-bg-primary shadow-xl overflow-auto"
        style={{ animation: "slideInRight 0.3s ease-out" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-bg-primary border-b px-4 py-3 flex items-center justify-between">
          {editing ? (
            <div className="flex items-center gap-2 flex-1">
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSaveName()}
                className="flex-1 rounded border px-2 py-1 text-sm bg-surface-primary text-text-primary"
                autoFocus
              />
              <button onClick={handleSaveName} className="text-accent-link text-sm">保存</button>
              <button onClick={() => setEditing(false)} className="text-text-muted text-sm">取消</button>
            </div>
          ) : (
            <>
              <h3 className="font-medium text-lg">{editName || `Person #${personId}`}</h3>
              <div className="flex items-center gap-2">
                <button onClick={() => setEditing(true)} className="text-text-muted text-xs hover:text-text-primary">
                  编辑
                </button>
                <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl">&times;</button>
              </div>
            </>
          )}
        </div>

        <div className="p-4 space-y-6">
          {/* Person Info */}
          <div className="space-y-1 text-sm text-text-muted">
            {detail?.face_count != null && <p>{detail.face_count} 张人脸</p>}
            {detail?.confidence && <p>置信度: {detail.confidence}</p>}
            {detail?.first_seen && <p>首次出现: {detail.first_seen}</p>}
            {detail?.last_seen && <p>最近出现: {detail.last_seen}</p>}
          </div>

          {/* Timeline Bar Chart */}
          {timeline.length > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-2">时间线</h4>
              <div className="flex items-end gap-1 h-20">
                {timeline.slice(0, 12).reverse().map(([month, count]) => (
                  <div key={month} className="flex flex-col items-center flex-1">
                    <div
                      className="w-full bg-accent-primary rounded-t"
                      style={{ height: `${Math.max(4, (count / maxCount) * 64)}px` }}
                    />
                    <span className="text-xs text-text-muted mt-1">
                      {month.slice(2)} {/* Show YY-MM */}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Scene Tags */}
          {tags.length > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-2">场景标签</h4>
              <div className="flex flex-wrap gap-2">
                {tags.map(([label, count]) => (
                  <span
                    key={label}
                    className="rounded-full bg-surface-primary px-3 py-1 text-xs text-text-primary"
                  >
                    {label} ({count})
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* View 全部照片 */}
          <button
            onClick={handleViewAllPhotos}
            className="w-full rounded bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
          >
            查看所有照片
          </button>
        </div>
      </div>
    </div>
  );
}
