import { useEffect, useState } from "react";
import { create } from "zustand";
import { listOfflineMaps, type MapLayerStyle, type OfflineMapPackage } from "../api/tauri";
import { useStore } from "./usePhotos";

const LAYER_KEY = "photofactory.offlineMapLayer";
function readPreference(key: string) {
  try { return localStorage.getItem(key); }
  catch { return null; }
}
function savePreference(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* session preference still applies */ }
}

export const useOfflineMapStore = create<{
  revision: number;
  layer: MapLayerStyle;
  setLayer: (layer: MapLayerStyle) => void;
  refresh: () => void;
}>((set) => ({
  layer: readPreference(LAYER_KEY) === "satellite" ? "satellite" : "standard",
  revision: 0,
  setLayer: (layer) => { savePreference(LAYER_KEY, layer); set({ layer }); },
  refresh: () => set((state) => ({ revision: state.revision + 1 })),
}));

const EMPTY: OfflineMapPackage[] = [];

export function useOfflineMapPackages() {
  const projectPath = useStore((state) => state.project?.root_path);
  const revision = useOfflineMapStore((state) => state.revision);
  const [result, setResult] = useState<{
    path: string; revision: number; packages: OfflineMapPackage[]; error: string;
  } | null>(null);
  useEffect(() => {
    if (!projectPath) return;
    let live = true;
    listOfflineMaps().then((packages) => {
      if (live) setResult({ path: projectPath, revision, packages, error: "" });
    }).catch((error) => {
      if (live) setResult({ path: projectPath, revision, packages: EMPTY, error: String(error) });
    });
    return () => { live = false; };
  }, [projectPath, revision]);
  const current = result?.path === projectPath && result?.revision === revision ? result : null;
  return { packages: current?.packages ?? EMPTY, loading: !!projectPath && !current, error: current?.error ?? "" };
}
