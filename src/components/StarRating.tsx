import React, { useState } from "react";

interface Props {
  value: number;
  onChange?: (value: number) => void;
  size?: "sm" | "md";
  disabled?: boolean;
  showClear?: boolean;
}

export default React.memo(function StarRating({ value, onChange, size = "md", disabled = false, showClear = true }: Props) {
  const [hovered, setHovered] = useState<number | null>(null);
  const active = hovered ?? value;
  return (
    <div className="inline-flex items-center gap-0.5" aria-label={`${value} 星`} onMouseLeave={() => setHovered(null)}>
      {showClear && onChange && (
        <button type="button" disabled={disabled} onClick={() => onChange(0)} className="mr-1 text-[11px] text-text-muted hover:text-text-primary disabled:opacity-40" title="清除星级">0</button>
      )}
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          type="button"
          key={star}
          disabled={disabled || !onChange}
          onMouseEnter={() => onChange && setHovered(star)}
          onFocus={() => onChange && setHovered(star)}
          onBlur={() => setHovered(null)}
          onClick={() => onChange?.(star)}
          className={`${size === "sm" ? "text-sm" : "text-xl"} leading-none transition-colors disabled:cursor-default ${star <= active ? "text-yellow-400" : "text-text-muted/30"}`}
          aria-label={`设为 ${star} 星`}
        >★</button>
      ))}
    </div>
  );
});
