import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { getPhotoMemories } from "../api/tauri";
import type { PhotoMemory } from "../types";
import { useStore } from "./usePhotos";

interface MemoriesState {
  root: string | null;
  memories: PhotoMemory[];
  loading: boolean;
  error: string | null;
  load: (root: string | null, reason?: "refresh" | "visibility") => Promise<void>;
  update: (root: string, id: number, favorite: boolean, tags: string[]) => void;
}

let request = 0;
export const usePhotoMemories = create<MemoriesState>((set, get) => ({
  root: null,
  memories: [],
  loading: false,
  error: null,
  async load(root, reason) {
    const current = get();
    if (!reason && root === current.root) return;
    const generation = ++request;
    const memories = reason !== "visibility" && root === current.root ? current.memories : [];
    set({ root, memories, loading: !!root, error: null });
    if (!root) return;
    try {
      const memories = await getPhotoMemories();
      if (generation === request) set({ memories, loading: false });
    } catch (error) {
      if (generation === request) set({ error: String(error), loading: false });
    }
  },
  update(root, id, favorite, tags) {
    if (get().root !== root) return;
    ++request;
    set(({ memories }) => ({
      memories: memories.map((memory) => memory.id === id ? { ...memory, favorite, tags } : memory),
      loading: false,
    }));
  },
}));

export function usePreparePhotoMemories() {
  const root = useStore((state) => state.project?.root_path ?? null);
  useEffect(() => {
    let active = true;
    void usePhotoMemories.getState().load(root);
    if (!root) return;
    const subscriptions = [
      listen<{ stage?: string }>("ai_status_changed", ({ payload }) => {
        if (active && payload.stage === "done") void usePhotoMemories.getState().load(root, "refresh");
      }),
      listen("photo_memory_visibility_changed", () => {
        if (active) void usePhotoMemories.getState().load(root, "visibility");
      }),
    ];
    return () => {
      active = false;
      for (const subscription of subscriptions) void subscription.then((stop) => stop()).catch(() => {});
    };
  }, [root]);
}
