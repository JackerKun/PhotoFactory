import { useEffect, useRef, useState, type FormEvent } from "react";
import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import type { ManualTag } from "../types";

export type BatchMetadataMode = "exif" | "tags";

interface Props {
  mode: BatchMetadataMode;
  photoIds: number[];
  onClose: () => void;
}

const exifFields = [
  { key: "camera_make", label: "相机品牌", placeholder: "Nikon", maxLength: 120 },
  { key: "camera_model", label: "相机型号", placeholder: "FM2", maxLength: 120 },
  { key: "lens_make", label: "镜头品牌", placeholder: "Nikon", maxLength: 120 },
  { key: "lens_model", label: "镜头型号", placeholder: "AI-S Nikkor 50mm f/1.4", maxLength: 120 },
  { key: "exposure_time", label: "快门（秒）", placeholder: "1/125", maxLength: 65 },
  { key: "f_number", label: "光圈", placeholder: "2.8", maxLength: 32 },
] as const;

export default function BatchMetadataDialog({ mode, photoIds, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [writeOriginals, setWriteOriginals] = useState(false);
  const [operation, setOperation] = useState<"add" | "remove">("add");
  const [tags, setTags] = useState<ManualTag[]>([]);
  const [tagQuery, setTagQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<number[]>([]);
  const [newTag, setNewTag] = useState("");
  const [loadingTags, setLoadingTags] = useState(mode === "tags");
  const isExif = mode === "exif";
  const title = isExif ? "批量编辑 EXIF" : "批量管理标签";

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    if (isExif) return;
    let live = true;
    api.getManualTags().then((items) => {
      if (live) setTags(items);
    }).catch((reason) => {
      if (live) setError(`读取标签失败：${String(reason)}`);
    }).finally(() => {
      if (live) setLoadingTags(false);
    });
    return () => { live = false; };
  }, [isExif]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current || message) return;
    const data = new FormData(event.currentTarget);
    const project = useStore.getState().project?.root_path;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      if (isExif) {
        const patch: api.CaptureExifPatch = Object.fromEntries(exifFields.map(({ key }) => [
          key, String(data.get(key) ?? "").trim() || undefined,
        ]));
        const iso = data.get("iso");
        if (iso) patch.iso = Number(iso);
        const focalLength = data.get("focal_length");
        if (focalLength) patch.focal_length = Number(focalLength);
        const captureTime = data.get("capture_time");
        if (captureTime) patch.capture_time = String(captureTime);
        const result = await api.updateBatchExif(photoIds, patch, writeOriginals);
        const fileSummary = writeOriginals
          ? `。原文件写入 ${result.files_written} 张，未写入 ${result.files_failed} 张`
          : "";
        setMessage(`已保存 ${result.updated} 张照片的 EXIF 信息${fileSummary}。`);
        setFileErrors(result.file_errors);
      } else {
        const remove = operation === "remove";
        const affected = await api.updateBatchTags(photoIds, selectedTags, remove ? null : newTag.trim() || null, remove);
        setMessage(`已${remove ? "移除" : "添加"}标签，实际变更 ${affected} 张照片。`);
      }
      if (project === useStore.getState().project?.root_path) {
        await useStore.getState().refreshPhotoMetadata();
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const visibleTags = tags.filter((tag) => tag.name.toLowerCase().includes(tagQuery.trim().toLowerCase()));
  const canSaveTags = !loadingTags && (selectedTags.length > 0 || (operation === "add" && !!newTag.trim()));

  return (
    <dialog ref={dialog} aria-label={title} onCancel={(event) => {
      event.preventDefault();
      if (!savingRef.current) onClose();
    }} className="max-h-[85vh] w-[calc(100%-2rem)] max-w-lg overflow-auto rounded-xl border border-surface-secondary bg-bg-secondary p-0 text-text-primary shadow-xl backdrop:bg-black/50">
      <form onSubmit={(event) => void save(event)}>
        <header className="border-b border-surface-secondary px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-text-secondary">已选 {photoIds.length.toLocaleString()} 张照片</p>
        </header>
        {!message && <fieldset disabled={saving} className="min-w-0 space-y-4 p-5">
          {isExif ? <>
            <p className="text-sm text-text-secondary">仅更新填写的字段，留空的字段保留各张照片现有的值。</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {exifFields.map(({ key, label, placeholder, maxLength }) => (
                <label key={key} className="flex flex-col gap-1 text-sm">
                  {label}<input name={key} placeholder={placeholder} maxLength={maxLength} className="ui-input w-full" />
                </label>
              ))}
              <label className="flex flex-col gap-1 text-sm">
                ISO<input name="iso" type="number" min={1} max={65535} step={1} placeholder="400" className="ui-input w-full" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                焦距（mm）<input name="focal_length" type="number" min={0.01} max={100000} step="any" placeholder="50" className="ui-input w-full" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                拍摄时间<input name="capture_time" type="datetime-local" min="0001-01-01T00:00" max="9999-12-31T23:59" className="ui-input w-full" />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={writeOriginals} onChange={(event) => setWriteOriginals(event.target.checked)} />
              同时写入原文件 EXIF
            </label>
          </> : <>
            <div className="ui-segments" role="group" aria-label="标签操作">
              <button type="button" className="ui-segment" aria-pressed={operation === "add"} onClick={() => setOperation("add")}>添加标签</button>
              <button type="button" className="ui-segment" aria-pressed={operation === "remove"} onClick={() => setOperation("remove")}>移除标签</button>
            </div>
            <input type="search" aria-label="搜索现有标签" placeholder="搜索现有标签…" className="ui-input w-full"
              value={tagQuery} onChange={(event) => setTagQuery(event.target.value)} />
            <div className="max-h-44 space-y-1 overflow-auto rounded-md border border-surface-secondary p-2">
              {loadingTags && <p role="status" className="p-2 text-sm text-text-secondary">正在读取标签…</p>}
              {!loadingTags && !visibleTags.length && <p className="p-2 text-sm text-text-secondary">没有匹配的标签</p>}
              {visibleTags.map((tag) => {
                const checked = selectedTags.includes(tag.id);
                return <label key={tag.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-surface-primary">
                  <input type="checkbox" checked={checked} onChange={(event) => setSelectedTags((ids) => event.target.checked
                    ? [...ids, tag.id] : ids.filter((id) => id !== tag.id))} />
                  <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: tag.color }} />
                  <span className="break-all">{tag.name}</span>
                </label>;
              })}
            </div>
            {selectedTags.length > 0 && <p className="text-sm text-text-secondary">已选 {selectedTags.length} 个现有标签</p>}
            {operation === "add" && <label className="flex flex-col gap-1 text-sm">
              新标签（可选）<input value={newTag} onChange={(event) => setNewTag(event.target.value)} maxLength={40}
                placeholder="例如：胶片扫描" className="ui-input w-full" />
            </label>}
          </>}
        </fieldset>}
        {message && <p role="status" className="px-5 pt-4 text-sm text-text-primary">{message}</p>}
        {fileErrors.length > 0 && <details className="px-5 py-3 text-sm text-text-secondary">
          <summary className="cursor-pointer">查看写入问题（最多显示 8 条）</summary>
          <ul className="mt-2 list-disc space-y-1 break-all pl-5">{fileErrors.map((detail) => <li key={detail}>{detail}</li>)}</ul>
        </details>}
        {error && <p role="alert" className="break-words px-5 pb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
        <footer className="flex justify-end gap-2 border-t border-surface-secondary px-5 py-3">
          <button type="button" onClick={onClose} disabled={saving} className="ui-button">{message ? "完成" : "取消"}</button>
          {!message && <button type="submit" disabled={saving || (!isExif && !canSaveTags)} className="ui-button-primary">
            {saving ? "正在保存…" : "应用到所选照片"}
          </button>}
        </footer>
      </form>
    </dialog>
  );
}
