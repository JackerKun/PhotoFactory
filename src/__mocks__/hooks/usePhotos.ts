import { create } from "zustand";
import type { Photo } from "../../types";

interface PhotosStore {
  photos: Photo[];
  updatePhotoInList: (photoId: number, updates: Partial<Photo>) => void;
}

export const useStore = create<PhotosStore>((set) => ({
  photos: [],
  updatePhotoInList: (photoId, updates) =>
    set((state) => ({
      photos: state.photos.map((p) => (p.id === photoId ? { ...p, ...updates } : p)),
    })),
}));

export default function usePhotos() {
  return useStore();
}
