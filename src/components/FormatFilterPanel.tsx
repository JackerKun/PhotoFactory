import React, { useEffect, useId, useRef, useState } from "react";

interface ExtensionGroup {
  label: string;
  extensions: { ext: string; label: string }[];
}

const GROUPS: ExtensionGroup[] = [
  {
    label: "常见图片格式",
    extensions: [
      { ext: "jpg", label: "JPG" },
      { ext: "jpeg", label: "JPEG" },
      { ext: "png", label: "PNG" },
      { ext: "gif", label: "GIF" },
      { ext: "bmp", label: "BMP" },
      { ext: "webp", label: "WebP" },
      { ext: "heic", label: "HEIC" },
      { ext: "heif", label: "HEIF" },
    ],
  },
  {
    label: "RAW 格式",
    extensions: [
      { ext: "cr2", label: "CR2" },
      { ext: "cr3", label: "CR3" },
      { ext: "nef", label: "NEF" },
      { ext: "arw", label: "ARW" },
      { ext: "orf", label: "ORF" },
      { ext: "rw2", label: "RW2" },
      { ext: "pef", label: "PEF" },
      { ext: "dng", label: "DNG" },
      { ext: "raf", label: "RAF" },
      { ext: "tif", label: "TIF" },
      { ext: "tiff", label: "TIFF" },
    ],
  },
  {
    label: "专业格式",
    extensions: [
      { ext: "psd", label: "PSD" },
      { ext: "xcf", label: "XCF" },
      { ext: "exr", label: "EXR" },
    ],
  },
];

interface Props {
  mode?: "import" | "scan";
  currentExtensions: string[];
  onConfirm: (extensions: string[]) => void;
  onCancel: () => void;
}

export default React.memo(function FormatFilterPanel({ mode = "import", currentExtensions, onConfirm, onCancel }: Props) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(currentExtensions));
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => { element?.close(); };
  }, []);

  const isGroupAllChecked = (group: ExtensionGroup) =>
    group.extensions.every((e) => selected.has(e.ext));
  const isGroupSomeChecked = (group: ExtensionGroup) =>
    group.extensions.some((e) => selected.has(e.ext));

  const toggleGroup = (group: ExtensionGroup) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (isGroupAllChecked(group)) {
        group.extensions.forEach((e) => next.delete(e.ext));
      } else {
        group.extensions.forEach((e) => next.add(e.ext));
      }
      return next;
    });
  };

  const toggleExt = (ext: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ext)) next.delete(ext);
      else next.add(ext);
      return next;
    });
  };

  const handleConfirm = () => {
    if (selected.size > 0) onConfirm(Array.from(selected));
  };

  return (
    <dialog ref={dialog} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onCancel(); }}
      className="m-auto max-h-[calc(100vh-2rem)] w-[min(32rem,calc(100%-2rem))] overflow-x-hidden overflow-y-auto overscroll-contain scroll-pb-16 rounded-2xl border border-surface-secondary bg-bg-secondary p-0 text-text-primary shadow-2xl backdrop:bg-black/45">
      <header className="border-b border-surface-secondary px-5 py-4">
        <h2 id={titleId} className="text-lg font-semibold">{mode === "scan" ? "增量扫描" : "选择导入的文件格式"}</h2>
        {mode === "scan" && <p className="mt-1 text-sm text-text-secondary">选择要扫描的文件格式。</p>}
      </header>
      <div className="space-y-4 px-5 py-4">
        {GROUPS.map((group) => (
          <div key={group.label}>
            <label className="flex items-center gap-2 mb-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isGroupAllChecked(group)}
                ref={(el) => { if (el) el.indeterminate = isGroupSomeChecked(group) && !isGroupAllChecked(group); }}
                onChange={() => toggleGroup(group)}
                className="accent-accent-primary"
              />
              <span className="text-sm font-medium text-text-primary">{group.label}</span>
            </label>
            <div className="ml-5 grid grid-cols-2 gap-x-3 gap-y-2 min-[420px]:grid-cols-4">
              {group.extensions.map(({ ext, label }) => (
                <label key={ext} className="flex items-center gap-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(ext)}
                    onChange={() => toggleExt(ext)}
                    className="h-4 w-4 shrink-0 accent-accent-primary"
                  />
                  <span className="text-xs text-text-secondary">{label}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
      <footer className="sticky bottom-0 flex justify-end gap-2 border-t border-surface-secondary bg-bg-secondary px-5 py-3">
        <button type="button" onClick={onCancel} className="ui-button" autoFocus>取消</button>
        <button type="button" onClick={handleConfirm} disabled={selected.size === 0} className="ui-button-primary">
          {mode === "scan" ? "开始扫描" : "确认"}
        </button>
      </footer>
    </dialog>
  );
});
