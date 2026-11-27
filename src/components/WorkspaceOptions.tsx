import React, { useEffect, useRef, useState } from "react";
import Icon, { type IconName } from "./Icon";

interface Props {
  label: string;
  icon: IconName;
  iconOnly?: boolean;
  upward?: boolean;
  children: (close: () => void) => React.ReactNode;
}

export default function WorkspaceOptions({ label, icon, iconOnly, upward, children }: Props) {
  const details = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const element = details.current;
      if (element && !element.contains(event.target as Node)) element.open = false;
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const close = () => {
    if (details.current) details.current.open = false;
    trigger.current?.focus();
  };

  return (
    <details ref={details} className={`workspace-options ${upward ? "workspace-options-up" : ""}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && event.currentTarget.open) {
          event.stopPropagation();
          close();
        }
      }}>
      <summary ref={trigger} className={iconOnly ? "ui-button ui-icon-button" : "ui-button-primary"}
        aria-label={label} title={label}>
        <Icon name={icon} size={16} />{!iconOnly && label}
      </summary>
      <div className="workspace-options-panel">{children(close)}</div>
    </details>
  );
}
