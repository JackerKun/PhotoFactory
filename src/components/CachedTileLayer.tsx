import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as api from "../api/tauri";
import type { MapLayerStyle } from "../api/tauri";
import { useOfflineMapPackages, useOfflineMapStore } from "../hooks/useOfflineMaps";
import { useStore } from "../hooks/usePhotos";
import L from "leaflet";
import { iconPaths } from "./Icon";

function escapeAttribution(value: string) {
  const node = document.createElement("span");
  node.textContent = value;
  return node.innerHTML;
}

export default function CachedTileLayer({ layer: requestedLayer }: { layer?: MapLayerStyle }) {
  const map = useMap();
  const projectPath = useStore((state) => state.project?.root_path);
  const layer = useOfflineMapStore((state) => requestedLayer ?? state.layer);
  const { packages, loading } = useOfflineMapPackages();

  useEffect(() => {
    if (!projectPath || loading) return;
    let live = true;
    const pending = new Map<string, Promise<api.MapTileResult>>();
    let generation = 0;
    const counts = { local: 0, network: 0, failed: 0, loading: 0 };
    const status = L.DomUtil.create("div", "map-load-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const statusText = document.createElement("span");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.title = "重试加载地图";
    retry.setAttribute("aria-label", retry.title);
    retry.className = "ui-button h-8 w-8 shrink-0 p-0";
    retry.innerHTML = `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${iconPaths.retry}"/></svg>`;
    retry.hidden = true;
    status.append(statusText, retry);
    L.DomEvent.disableClickPropagation(status);
    L.DomEvent.disableScrollPropagation(status);
    const control = new L.Control({ position: "bottomleft" });
    control.onAdd = () => status;
    control.addTo(map);
    const updateStatus = () => {
      if (!live) return;
      const sources = [counts.local ? `本地地图 ${counts.local} 张` : "", counts.network ? `联网补充 ${counts.network} 张` : ""].filter(Boolean).join(" · ");
      statusText.textContent = counts.loading ? `正在加载地图… ${sources}` : counts.failed ? `${counts.failed} 张未能加载，请检查网络或离线覆盖范围。 ${sources}` : sources || "等待地图加载";
      retry.hidden = counts.failed === 0;
    };
    const relevant = packages.filter((item) => item.layer === layer);
    const credits = new Set(relevant.flatMap((item) => item.attribution ? [item.attribution] : []));
    const baseCredit = layer === "satellite" ? "Tiles © Esri" : "© OpenStreetMap contributors";
    const attribution = [baseCredit, ...credits].map(escapeAttribution).join(" · ");
    const TileLayer = L.GridLayer.extend({
      createTile(coords: L.Coords, done: L.DoneCallback) {
        const tileGeneration = generation;
        const tile = document.createElement("div");
        tile.style.backgroundColor = "rgb(var(--bg-tertiary))";
        const { z, x, y } = coords;
        const key = `${z}/${x}/${y}`;
        let request = pending.get(key);
        if (!request) {
          request = api.getMapTileStatus(z, x, y, layer).finally(() => pending.delete(key));
          pending.set(key, request);
        }
        counts.loading += 1;
        updateStatus();
        const finished = (failed: boolean) => {
          if (!live || tileGeneration !== generation) return;
          counts.loading = Math.max(0, counts.loading - 1);
          if (failed) counts.failed += 1;
          updateStatus();
          done(undefined, tile);
        };
        request.then(({ url: file, source }) => {
          if (!live || tileGeneration !== generation) return;

          const img = document.createElement("img");
          img.alt = "";
          img.style.cssText = "width:100%;height:100%;display:block";
          img.onload = () => { if (!live || tileGeneration !== generation) return; if (source === "network") counts.network += 1; else counts.local += 1; finished(false); };
          img.onerror = () => { img.remove(); finished(true); };
          img.src = file.startsWith("data:") || file.startsWith("https://") ? file : convertFileSrc(file);
          tile.appendChild(img);
        }).catch((error) => {
          if (!live) return;
          console.warn(`Map tile ${key} unavailable:`, error);
          finished(true);
        });
        return tile;
      },
    }) as new (options: L.GridLayerOptions) => L.GridLayer;
    const tileLayer = new TileLayer({
      minZoom: 0,
      maxZoom: 19,
      attribution,
    }).addTo(map);
    retry.onclick = () => {
      generation += 1;
      counts.local = counts.network = counts.failed = counts.loading = 0;
      tileLayer.redraw();
      updateStatus();
    };
    return () => { live = false; control.remove(); map.removeLayer(tileLayer); };
  }, [map, layer, projectPath, packages, loading]);

  return null;
}
