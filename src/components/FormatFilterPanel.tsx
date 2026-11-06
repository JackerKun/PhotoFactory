import React, { useState } from "react";

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
  currentExtensions: string[];
  onConfirm: (extensions: string[]) => void;
  onCancel: () => void;
}

export default React.memo(function FormatFilterPanel({ currentExtensions, onConfirm, onCancel }: Props) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(currentExtensions));

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
    if (selected.size === 0) {
      alert("请至少选择一种文件格式");
      return;
    }
    onConfirm(Array.from(selected));
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-bg-secondary rounded-xl p-6 w-full max-w-lg shadow-2xl">
        <h3 className="text-lg font-bold mb-4 text-text-primary">选择导入的文件格式</h3>

        {GROUPS.map((group) => (
          <div key={group.label} className="mb-4">
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
            <div className="flex flex-wrap gap-2 ml-6">
              {group.extensions.map(({ ext, label }) => (
                <label key={ext} className="flex items-center gap-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(ext)}
                    onChange={() => toggleExt(ext)}
                    className="accent-accent-primary w-3 h-3"
                  />
                  <span className="text-xs text-text-secondary">{label}</span>
                </label>
              ))}
            </div>
          </div>
        ))}

        <div className="flex gap-3 mt-6">
          <button onClick={onCancel}
            className="flex-1 bg-surface-primary border border-surface-secondary text-text-primary py-2 rounded-lg text-sm">
            取消
          </button>
          <button onClick={handleConfirm}
            className="flex-1 bg-accent-primary hover:bg-accent-primary/80 text-white py-2 rounded-lg text-sm font-medium">
            确认
          </button>
        </div>
      </div>
    </div>
  );
});
