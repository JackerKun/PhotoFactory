import React, { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as api from "../api/tauri";

/** Per-label thumbnail cache (file paths, persists across renders). */
const labelThumbCache = new Map<string, string>();
const LABEL_THUMB_CACHE_MAX = 256;

function remember(label: string, path: string) {
  if (labelThumbCache.has(label)) labelThumbCache.delete(label);
  labelThumbCache.set(label, path);
  while (labelThumbCache.size > LABEL_THUMB_CACHE_MAX) {
    const oldest = labelThumbCache.keys().next().value;
    if (oldest === undefined) break;
    labelThumbCache.delete(oldest);
  }
}

export default React.memo(function LabelThumb({ label, previewPath, size = "small" }: { label: string; previewPath?: string | null; size?: "small" | "large" }) {
  const [thumb, setThumb] = useState<string | null>(() => {
    const cached = previewPath || labelThumbCache.get(label);
    return cached ? convertFileSrc(cached) : null;
  });
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (previewPath) {
      remember(label, previewPath);
      setThumb(convertFileSrc(previewPath));
      return;
    }
    const cached = labelThumbCache.get(label);
    if (cached) {
      setThumb(convertFileSrc(cached));
      return;
    }
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      api.getLabelPreview(label)
        .then((path) => {
          if (!cancelled) {
            remember(label, path);
            setThumb(convertFileSrc(path));
          }
        })
        .catch(() => { if (!cancelled) setThumb(null); });
    }, { rootMargin: "160px" });
    observer.observe(host);
    return () => { cancelled = true; observer.disconnect(); };
  }, [label, previewPath]);

  if (thumb) {
    return <img src={thumb} alt="" className={size === "large" ? "w-full h-full object-cover" : "w-6 h-6 rounded object-cover flex-shrink-0"} />;
  }
  // Fallback: colored badge with "?" for labels without preview photos
  const hue = label.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
  return (
    <div
      ref={hostRef}
      className={size === "large" ? "w-full h-full flex items-center justify-center text-white text-3xl font-bold select-none" : "w-6 h-6 rounded flex-shrink-0 flex items-center justify-center text-white text-[10px] font-bold select-none"}
      style={{ backgroundColor: `hsl(${hue}, 50%, 45%)` }}
    >
      ?
    </div>
  );
});
