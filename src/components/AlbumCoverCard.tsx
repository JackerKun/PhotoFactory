import { memo, useEffect, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getThumbnailPath } from "../api/tauri";
import { useStore } from "../hooks/usePhotos";

export const albumGridStyle = (size: number) => ({
  gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${size}px), 1fr))`,
});

const coverCache = new Map<string, string>();

export const AlbumCoverThumbnail = memo(function AlbumCoverThumbnail({ photoId }: { photoId: number }) {
  const projectRoot = useStore((state) => state.project?.root_path);
  const key = `${projectRoot ?? ""}\0${photoId}`;
  const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(null);
  const url = coverCache.get(key) ?? (loaded?.key === key ? loaded.url : null);

  useEffect(() => {
    const cached = coverCache.get(key);
    if (cached) {
      setLoaded({ key, url: cached });
      return;
    }
    let active = true;
    getThumbnailPath(photoId, "small").then((path) => {
      if (!active) return;
      const next = convertFileSrc(path);
      coverCache.set(key, next);
      setLoaded({ key, url: next });
    }).catch(() => {});
    return () => { active = false; };
  }, [key, photoId]);

  return url ? <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" /> : <div className="h-full w-full animate-pulse bg-bg-tertiary" />;
});

export default function AlbumCoverCard({ title, badge, description, cover, actions, onOpen, wide = false }: {
  title: string;
  badge: string;
  description: string;
  cover: ReactNode;
  actions?: ReactNode;
  onOpen: () => void;
  wide?: boolean;
}) {
  const badgeLabel = <span className="shrink-0 rounded bg-text-primary/5 px-1.5 py-0.5 text-xs text-text-muted">{badge}</span>;
  return <article className="group relative overflow-hidden rounded-xl border border-surface-secondary/70 bg-surface-primary transition-colors hover:border-accent-link/50">
    <button type="button" onClick={onOpen} className={`w-full text-left focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-accent-primary ${wide ? "flex h-full flex-col" : "block"}`}>
      <div className={`relative w-full shrink-0 overflow-hidden bg-bg-tertiary text-text-muted ${wide ? "aspect-[4/3]" : "aspect-square"}`}>{cover}</div>
      {wide ? <div className="album-cover-body flex w-full flex-1 flex-col gap-2">
        <h3 className="text-sm font-medium [overflow-wrap:anywhere]">{title}</h3>
        <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
          {badgeLabel}
          <p>{description}</p>
        </div>
      </div> : <div className="album-cover-body">
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate text-sm font-medium" title={title}>{title}</h3>
          {badgeLabel}
        </div>
        <p className="mt-1 truncate text-xs text-text-muted" title={description}>{description}</p>
      </div>}
    </button>
    {actions && <div className="absolute right-2 top-2 flex gap-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">{actions}</div>}
  </article>;
}
