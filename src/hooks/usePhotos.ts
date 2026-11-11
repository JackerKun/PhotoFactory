import { create } from "zustand";
import type { AiProcessingStatus, Photo, PhotoCursor, PhotoFilter, Project, ThumbnailProcessingStatus } from "../types";
import * as api from "../api/tauri";
import { readPhotoData } from "../utils/photoRequests";

interface AppState {
  project: Project | null;
  setProject: (p: Project | null) => void;
  photos: Photo[];
  totalPhotos: number;
  hasNext: boolean;
  cursor: PhotoCursor | null;
  filter: PhotoFilter;
  loading: boolean;
  photoLoadError: { message: string; page: "first" | "next" } | null;
  thumbnailShape: "square" | "proportional";
  thumbnailSize: number;
  photoRoute: string;
  photoGridScrollOffsets: Record<"square" | "proportional", number>;
  lightboxPhotoId: number | null;
  selectedPhotoId: number | null;
  faceDataRevision: number;
  markFaceDataChanged: () => void;
  ratingSelectionMode: boolean;
  ratingSelection: number[];
  setRatingSelectionMode: (enabled: boolean) => void;
  toggleRatingSelection: (photoId: number) => void;
  clearRatingSelection: () => void;
  showGpsBatchEditor: boolean;
  setShowGpsBatchEditor: (show: boolean) => void;
  batchEditorPhotoId: number;
  setBatchEditorPhotoId: (id: number) => void;
  batchGpsPending: Map<number, { lat: number; lng: number }>;
  setBatchGpsPending: (pending: Map<number, { lat: number; lng: number }>) => void;
  mapFocusRequest: { lat: number; lng: number; photoId: number; requestId: number } | null;
  requestMapFocus: (lat: number, lng: number, photoId: number) => void;
  clearMapFocusRequest: () => void;
  aiProcessingStatus: AiProcessingStatus | null;
  thumbnailProcessingStatus: ThumbnailProcessingStatus | null;
  setThumbnailProcessingStatus: (status: ThumbnailProcessingStatus | null) => void;
  preloadQueue: number[];
  queuePreload: (photoIds: number[]) => void;
  clearPreloadQueue: () => void;
  _photoRequestGeneration: number;
  setFilter: (filter: Partial<PhotoFilter>, replace?: boolean) => void;
  clearPhotoFilters: () => void;
  setThumbnailShape: (shape: "square" | "proportional") => void;
  setThumbnailSize: (size: number) => void;
  setPhotoRoute: (route: string) => void;
  setPhotoGridScrollOffset: (shape: "square" | "proportional", offset: number) => void;
  setLightboxPhotoId: (id: number | null) => void;
  setSelectedPhotoId: (id: number | null) => void;
  setAiProcessingStatus: (status: AiProcessingStatus | null) => void;
  updatePhotoInList: (photoId: number, updates: Partial<Photo>) => void;
  updatePhotosInList: (photoIds: number[], updates: Partial<Photo>) => void;
  loadPhotos: () => Promise<void>;
  loadMore: () => Promise<void>;
  reset: () => void;
}

export const useStore = create<AppState>((set, get) => ({
  project: null,
  setProject: (p) => set((state) => {
    if (p?.root_path === state.project?.root_path) return { project: p };
    return {
      project: p, photos: [], totalPhotos: 0, cursor: null, hasNext: false,
      loading: false, photoLoadError: null,
      _photoRequestGeneration: state._photoRequestGeneration + 1,
    };
  }),
  photos: [],
  totalPhotos: 0,
  hasNext: false,
  cursor: null,
  filter: {},
  loading: false,
  photoLoadError: null,
  thumbnailShape: "square",
  thumbnailSize: 200,
  photoRoute: "/",
  photoGridScrollOffsets: { square: 0, proportional: 0 },
  lightboxPhotoId: null,
  selectedPhotoId: null,
  faceDataRevision: 0,
  markFaceDataChanged: () => set((state) => ({ faceDataRevision: state.faceDataRevision + 1 })),
  ratingSelectionMode: false,
  ratingSelection: [],
  setRatingSelectionMode: (enabled) => set({ ratingSelectionMode: enabled, ratingSelection: [] }),
  toggleRatingSelection: (photoId) => set((state) => ({
    ratingSelection: state.ratingSelection.includes(photoId)
      ? state.ratingSelection.filter((id) => id !== photoId)
      : [...state.ratingSelection, photoId],
  })),
  clearRatingSelection: () => set({ ratingSelection: [] }),
  showGpsBatchEditor: false,
  setShowGpsBatchEditor: (show) => set({ showGpsBatchEditor: show }),
  batchEditorPhotoId: 0,
  setBatchEditorPhotoId: (id) => set({ batchEditorPhotoId: id }),
  batchGpsPending: new Map(),
  setBatchGpsPending: (pending) => set({ batchGpsPending: pending }),
  mapFocusRequest: null,
  requestMapFocus: (lat, lng, photoId) => set({
    mapFocusRequest: { lat, lng, photoId, requestId: Date.now() },
  }),
  clearMapFocusRequest: () => set({ mapFocusRequest: null }),
  aiProcessingStatus: null,
  thumbnailProcessingStatus: null,
  preloadQueue: [],
  _photoRequestGeneration: 0,
  setFilter: (partial, replace = false) => set((state) => {
    const nextFilter = replace ? { ...partial } : { ...state.filter, ...partial };
    if (JSON.stringify(nextFilter) === JSON.stringify(state.filter)) return state;
    return {
      filter: nextFilter,
      photos: [],
      totalPhotos: 0,
      cursor: null,
      hasNext: false,
      loading: false,
      photoLoadError: null,
      preloadQueue: [],
      ratingSelection: [],
      photoGridScrollOffsets: { square: 0, proportional: 0 },
      _photoRequestGeneration: state._photoRequestGeneration + 1,
    };
  }),
  clearPhotoFilters: () => get().setFilter({
    directory: undefined,
    tag: undefined,
    person_id: undefined,
    has_gps: undefined,
    has_favorite: undefined,
    year: undefined,
    month: undefined,
    keyword: undefined,
    format: undefined,
    camera: undefined,
    iso_min: undefined,
    iso_max: undefined,
    aperture_min: undefined,
    aperture_max: undefined,
    exposure_time: undefined,
    orientation_kind: undefined,
    rating_min: undefined,
    rating_max: undefined,
  }),
  setThumbnailShape: (shape) => set({ thumbnailShape: shape }),
  setThumbnailSize: (size) => set({ thumbnailSize: size }),
  setPhotoRoute: (route) => set({ photoRoute: route }),
  setPhotoGridScrollOffset: (shape, offset) => set((state) => ({
    photoGridScrollOffsets: {
      ...state.photoGridScrollOffsets,
      [shape]: Math.max(0, offset),
    },
  })),
  setLightboxPhotoId: (id) => set({ lightboxPhotoId: id }),
  setSelectedPhotoId: (id) => set({ selectedPhotoId: id }),
  setAiProcessingStatus: (status) => set({ aiProcessingStatus: status }),
  setThumbnailProcessingStatus: (status) => set({ thumbnailProcessingStatus: status }),
  queuePreload: (photoIds: number[]) => {
    const { preloadQueue } = get();
    const queueSet = new Set(preloadQueue);
    const newIds = photoIds.filter((id) => !queueSet.has(id));
    if (newIds.length > 0) {
      set({ preloadQueue: [...preloadQueue, ...newIds] });
      newIds.forEach((id) => {
        api.getThumbnailPath(id, "small")
          .catch(() => {})
          .finally(() => {
            const { preloadQueue: currentQueue } = get();
            set({ preloadQueue: currentQueue.filter((q) => q !== id) });
          });
      });
    }
  },
  clearPreloadQueue: () => set({ preloadQueue: [] }),
  updatePhotoInList: (photoId, updates) => set((state) => ({
    photos: state.photos.map((p) => p.id === photoId ? { ...p, ...updates } : p),
  })),
  updatePhotosInList: (photoIds, updates) => set((state) => {
    const ids = new Set(photoIds);
    return { photos: state.photos.map((photo) => photo.id != null && ids.has(photo.id) ? { ...photo, ...updates } : photo) };
  }),
  loadPhotos: async () => {
    const generation = get()._photoRequestGeneration + 1;
    const filter = { ...get().filter };
    // A refresh always starts at the first page. Reusing the previous cursor
    // here made "All Photos" silently replace page one with a later page.
    set({ loading: true, photoLoadError: null, _photoRequestGeneration: generation });
    const isCurrent = () => get()._photoRequestGeneration === generation;
    try {
      const page = await readPhotoData(() => api.getPhotos(null, 200, filter), isCurrent);
      if (get()._photoRequestGeneration !== generation) return;
      set({
        photos: page.photos,
        totalPhotos: page.total_count,
        cursor: page.next_cursor,
        hasNext: page.has_more,
        loading: false,
      });
    } catch (error) {
      console.error("Failed to load photos:", error);
      if (isCurrent()) set({ loading: false, photoLoadError: { message: String(error), page: "first" } });
    }
  },
  loadMore: async () => {
    const state = get();
    if (!state.hasNext || state.loading || !state.cursor) return;

    const generation = state._photoRequestGeneration;
    const cursor = state.cursor;
    const filter = { ...state.filter };
    const isCurrent = () => get()._photoRequestGeneration === generation;
    set({ loading: true, photoLoadError: null });
    try {
      const page = await readPhotoData(() => api.getPhotos(cursor, 200, filter), isCurrent);
      if (get()._photoRequestGeneration !== generation) return;
      set((current) => {
        const knownIds = new Set(current.photos.map((photo) => photo.id));
        const newPhotos = page.photos.filter((photo) => !knownIds.has(photo.id));
        return {
          photos: [...current.photos, ...newPhotos],
          totalPhotos: page.total_count,
          cursor: page.next_cursor,
          hasNext: page.has_more,
          loading: false,
        };
      });
    } catch (error) {
      console.error("Failed to load more photos:", error);
      if (isCurrent()) set({ loading: false, photoLoadError: { message: String(error), page: "next" } });
    }
  },
  reset: () => {
    const state = get();
    set({
      photos: [], totalPhotos: 0, cursor: null, hasNext: false, filter: {},
      selectedPhotoId: null, lightboxPhotoId: null,
      ratingSelectionMode: false, ratingSelection: [],
      showGpsBatchEditor: false, batchEditorPhotoId: 0, batchGpsPending: new Map(),
      mapFocusRequest: null,
      photoRoute: "/", photoGridScrollOffsets: { square: 0, proportional: 0 },
      aiProcessingStatus: null,
      _photoRequestGeneration: state._photoRequestGeneration + 1,
      loading: false,
      photoLoadError: null,
      preloadQueue: [],
    });
  },
}));
