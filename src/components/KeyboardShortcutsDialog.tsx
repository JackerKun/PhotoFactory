import { useEffect } from "react";
import { createPortal } from "react-dom";

const groups = [
  {
    title: "照片列表",
    shortcuts: [
      ["方向键", "移动当前照片"],
      ["Enter / 空格", "打开当前照片大图"],
      ["0–5", "给当前照片设置星级；0 清除"],
      ["F", "收藏或取消收藏"],
      ["Home / End", "跳到已加载照片的开头或末尾"],
      ["Esc", "关闭照片详情"],
    ],
  },
  {
    title: "大图模式",
    shortcuts: [
      ["← / →", "上一张 / 下一张"],
      ["0–5", "直接设置星级；0 清除"],
      ["F", "收藏或取消收藏"],
      ["I", "显示或隐藏照片详情"],
      ["空格 / Z", "适合窗口与 2 倍缩放切换"],
      ["+ / −", "逐级放大 / 缩小"],
      ["Home / End", "文件夹第一张 / 最后一张"],
      ["G / Esc", "返回照片网格"],
      ["?", "显示或隐藏本快捷键表"],
    ],
  },
] as const;

export default function KeyboardShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "?") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[1400] flex items-center justify-center bg-black/45 p-6" role="dialog" aria-modal="true" aria-label="键盘快捷键">
      <div className="w-full max-w-2xl rounded-2xl border border-white/30 bg-bg-secondary p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">键盘快捷键</h2>
            <p className="mt-1 text-xs text-text-muted">在输入框中打字时不会触发这些操作。</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full px-3 py-1 text-xl text-text-muted hover:bg-surface-primary hover:text-text-primary" aria-label="关闭快捷键帮助">×</button>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          {groups.map((group) => (
            <section key={group.title}>
              <h3 className="mb-2 text-sm font-semibold text-text-primary">{group.title}</h3>
              <div className="space-y-1.5">
                {group.shortcuts.map(([keys, action]) => (
                  <div key={keys} className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-text-secondary">{action}</span>
                    <kbd className="shrink-0 rounded border border-surface-secondary bg-surface-primary px-2 py-1 font-mono text-xs text-text-primary shadow-sm">{keys}</kbd>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
