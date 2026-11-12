import { useEffect, useRef, useState } from "react";
import * as api from "../api/tauri";
import type { MapSearchResult } from "../api/tauri";

interface Props {
  onSelect: (result: MapSearchResult) => void;
  className?: string;
  compact?: boolean;
  placeholder?: string;
}

export default function MapSearch({
  onSelect,
  className = "",
  compact = false,
  placeholder = "搜索城市、景点或完整地址…",
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MapSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  const search = async () => {
    const value = query.trim();
    if (!value || searching) return;
    setSearching(true);
    setSearched(false);
    setError("");
    setOpen(true);
    try {
      const next = await api.searchMapLocation(value);
      setResults(next);
      setSearched(true);
    } catch (reason) {
      setResults([]);
      setSearched(true);
      setError(`地址搜索失败：${String(reason)}`);
    } finally {
      setSearching(false);
    }
  };

  const choose = (result: MapSearchResult) => {
    setQuery(result.display_name);
    setOpen(false);
    onSelect(result);
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <div className="ui-search">
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (results.length > 0) setOpen(true);
          }}
          onFocus={() => { if (results.length > 0 || searched) setOpen(true); }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void search();
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={placeholder}
          aria-label="搜索地图地址"
          className={`ui-input flex-1 ${compact ? "text-xs" : ""}`}
        />
        <button
          type="button"
          onClick={() => void search()}
          disabled={searching || !query.trim()}
          className={`ui-button-primary ${compact ? "text-xs" : ""}`}
        >
          {searching ? "搜索中…" : "搜索"}
        </button>
      </div>

      {open && (searching || searched || error) && (
        <div className="absolute left-0 right-0 top-full z-[3000] mt-1 max-h-80 overflow-y-auto rounded-xl border border-text-primary/10 bg-bg-secondary p-1.5 text-left shadow-2xl">
          {searching ? (
            <p className="px-3 py-4 text-center text-xs text-text-muted">正在查找完整地址…</p>
          ) : error ? (
            <p className="px-3 py-3 text-xs text-red-600 dark:text-red-300">{error}</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-text-muted">没有找到匹配地址，请补充省、市或区县后重试</p>
          ) : (
            <div role="listbox" aria-label="地址搜索结果">
              {results.map((result, index) => (
                <button
                  type="button"
                  role="option"
                  key={`${result.lat}-${result.lng}-${index}`}
                  onClick={() => choose(result)}
                  className="flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-surface-primary focus:bg-surface-primary"
                >
                  <svg className="mt-0.5 shrink-0 text-accent-link" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>
                  <span className="min-w-0">
                    <span className="block whitespace-normal text-xs font-medium leading-5 text-gray-800">{result.display_name}</span>
                    <span className="block text-xs tabular-nums text-gray-400">{result.lat.toFixed(6)}, {result.lng.toFixed(6)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
