import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  returnFocus?: HTMLElement;
}

export default React.memo(function ContextMenu({ x, y, items, onClose, returnFocus }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const close = (restoreFocus: boolean) => {
    onClose();
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (returnFocus) menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [returnFocus]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose, returnFocus]);

  // Adjust position to keep menu within viewport
  const menuWidth = 200;
  const menuHeight = items.length * 32 + 10;
  const adjustedX = Math.max(0, Math.min(x, window.innerWidth - menuWidth));
  const adjustedY = Math.max(0, Math.min(y, window.innerHeight - menuHeight));

  return createPortal(
    <div
      ref={menuRef}
      onBlur={returnFocus ? (event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onClose();
      } : undefined}
      className="fixed bg-bg-secondary border border-surface-secondary rounded-lg shadow-xl py-1 z-[9999] w-[200px]"
      style={{ left: adjustedX, top: adjustedY }}
    >
      {items.map((item, i) => (
        <button
          key={i}
          type="button"
          disabled={item.disabled}
          className={`w-full text-left px-3 py-1.5 text-sm transition-colors ${
            item.disabled
              ? "text-text-muted cursor-not-allowed"
              : item.danger
              ? "text-red-400 hover:bg-red-400/10"
              : "text-text-primary hover:bg-accent-primary/10"
          }`}
          onClick={() => {
            if (!item.disabled) {
              close(true);
              item.action();
            }
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
});
