import { useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { exportOfflineMap, importOfflineMap, type MapLayerStyle, type OfflineMapPackage } from "../api/tauri";
import { type useOfflineMapPackages, useOfflineMapStore } from "../hooks/useOfflineMaps";
import { useStore } from "../hooks/usePhotos";

const singleFilter = { name: "单图层地图包", extensions: ["mbtiles"] };
const dualFilter = { name: "双图层地图包", extensions: ["pfmap"] };

export default function OfflineMapPanel({ maps, layer, onView }: {
  maps: ReturnType<typeof useOfflineMapPackages>;
  layer: MapLayerStyle;
  onView: (pack: OfflineMapPackage) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<"import" | "export" | null>(null);
  const [exportLayer, setExportLayer] = useState<MapLayerStyle | "both">(layer);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const refresh = useOfflineMapStore((state) => state.refresh);
  const { packages, loading, error } = maps;
  const projectPath = useStore((state) => state.project?.root_path);

  useEffect(() => {
    if (!expanded || busy) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setExpanded(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [expanded, busy]);

  async function importPackage() {
    setBusy("import");
    setMessage("");
    setFailed(false);
    try {
      const selection = await open({ title: "选择离线地图包", multiple: true, filters: [{ name: "离线地图包", extensions: ["pfmap", "mbtiles"] }] });
      const paths = typeof selection === "string" ? [selection] : selection;
      if (!paths?.length || useStore.getState().project?.root_path !== projectPath) return;
      const imported = await importOfflineMap(paths);
      refresh();
      if (useStore.getState().project?.root_path !== projectPath) return;
      const dual = new Set(imported.map((pack) => pack.layer)).size === 2;
      setMessage(dual ? "已导入标准地图和卫星实景地图" : imported.length === 1 ? `已导入「${imported[0].name}」` : `已导入 ${imported.length} 个地图包`);
    } catch (reason) {
      setFailed(true);
      setMessage(`导入失败：${String(reason)}`);
    } finally {
      setBusy(null);
    }
  }

  async function exportPackage() {
    setBusy("export");
    setMessage("");
    setFailed(false);
    try {
      const path = await save({
        title: "保存离线地图包",
        defaultPath: exportLayer === "both" ? "offline-map.pfmap" : `${exportLayer}-map.mbtiles`,
        filters: [exportLayer === "both" ? dualFilter : singleFilter],
      });
      if (typeof path !== "string" || useStore.getState().project?.root_path !== projectPath) return;
      const result = await exportOfflineMap(path, exportLayer);
      setMessage(`已导出 ${result.tile_count.toLocaleString()} 张瓦片`);
    } catch (reason) {
      setFailed(true);
      setMessage(`导出失败：${String(reason)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div ref={root} className="relative text-sm text-gray-800">
      <button type="button" aria-label="离线地图" title="离线地图" aria-expanded={expanded}
        onClick={() => {
          if (!expanded) setExportLayer(layer);
          setExpanded(!expanded);
        }}
        className={`flex h-8 items-center justify-center rounded-md px-2.5 transition-colors ${expanded ? "bg-gray-200 text-gray-900" : "text-gray-600 hover:bg-text-primary/5"}`}>
        <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12m-5-5 5 5 5-5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
        </svg>
      </button>
      {expanded && (
        <div className="absolute right-0 top-full mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-text-primary/10 bg-bg-secondary p-3 shadow-xl">
          <p className="font-medium">优先使用离线地图</p>
          <p className="my-2 text-xs leading-relaxed text-gray-500">先读取已导入和已缓存的瓦片，缺少时联网下载。</p>
          <button type="button" disabled={!!busy || !projectPath} onClick={() => void importPackage()}
            className="ui-button-primary">
            {busy === "import" ? "正在导入…" : "导入离线地图包"}
          </button>
          <div className="mt-2 grid grid-cols-2 gap-2 border-t border-surface-secondary pt-2">
            <select aria-label="导出图层" value={exportLayer} disabled={!!busy}
              onChange={(event) => setExportLayer(event.target.value as MapLayerStyle | "both")}
              className="ui-select w-full">
              <option value="standard">标准地图</option>
              <option value="satellite">卫星实景地图</option>
              <option value="both">两种地图</option>
            </select>
            <button type="button" disabled={!!busy || !projectPath} onClick={() => void exportPackage()}
              className="ui-button min-w-0">
              {busy === "export" ? "正在导出…" : "导出离线地图"}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-gray-500">可一次导入多个包。导出包含所选图层的缓存和已导入瓦片。</p>
          {message && <p role={failed ? "alert" : "status"} className={`mt-2 break-words text-xs ${failed ? "text-red-700 dark:text-red-300" : "text-green-700 dark:text-green-300"}`}>{message}</p>}
          {error && <p role="alert" className="mt-2 break-words text-xs text-red-700 dark:text-red-300">读取地图包失败：{error}</p>}
          {loading && <p className="mt-2 text-xs text-gray-500">正在读取地图包…</p>}
          {!loading && !error && packages.length === 0 && <p className="mt-2 text-xs text-gray-500">此照片库尚未导入地图包。</p>}
          <ul className="mt-2 max-h-60 space-y-1 overflow-auto">
            {packages.map((pack) => (
              <li key={pack.id}>
                <button type="button" onClick={() => onView(pack)} className="w-full rounded-md bg-gray-50 px-2 py-1.5 text-left hover:bg-blue-50">
                  <span className="block truncate font-medium">{pack.name}</span>
                  <span className="text-xs text-gray-500">{pack.layer === "satellite" ? "卫星" : "标准"} · 层级 {pack.min_zoom}–{pack.max_zoom} · {(pack.bytes / 1024 ** 2).toFixed(1)} MB{pack.bounds ? " · 定位" : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
