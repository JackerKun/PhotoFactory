import { create } from "zustand";
import type { AiProcessingStatus, Photo, PhotoCursor, PhotoFilter, Project, ThumbnailProcessingStatus } from "../types";
import * as api from "../api/tauri";
import { readPhotoData } from "../utils/photoRequests";

interface GpsBatchSession {
  photoId: number;
  mode: "single" | "batch";
  selectedPhotoIds?: number[];
  sourcePhoto?: Photo;
}

export type LightboxItem = Pick<Photo, "id" | "filename"> & Partial<Pick<Photo, "path" | "file_size">>;
export interface LightboxSource {
  items: readonly LightboxItem[];
  candidatePersonId?: number;
  loadNext?: (items: readonly LightboxItem[]) => Promise<readonly LightboxItem[]>;
}

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
  lightboxSource: LightboxSource | null;
  selectedPhotoId: number | null;
  selectedLightboxSource: LightboxSource | null;
  photoMetadataRevision: number;
  refreshPhotoMetadata: () => Promise<void>;
  faceDataRevision: number;
  markFaceDataChanged: () => void;
  ratingSelectionMode: boolean;
  ratingSelection: number[];
  ratingSelectionAnchor: number | null;
  selectAllRatingPhotos: () => Promise<void>;
  setRatingSelectionMode: (enabled: boolean) => void;
  toggleRatingSelection: (photoId: number, extend?: boolean) => void;
  clearRatingSelection: () => void;
  gpsBatchSession: GpsBatchSession | null;
  openGpsBatchEditor: (session: GpsBatchSession) => void;
  closeGpsBatchEditor: () => void;
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
  setFilter: (filter: Partial<PhotoFilter>, replace?: boolean, restore?: boolean) => void;
  clearPhotoFilters: () => void;
  setThumbnailShape: (shape: "square" | "proportional") => void;
  setThumbnailSize: (size: number) => void;
  setPhotoRoute: (route: string) => void;
  setPhotoGridScrollOffset: (shape: "square" | "proportional", offset: number, filterKey?: string) => void;
  setLightboxPhotoId: (id: number | null) => void;
  openLightbox: (id: number, source: LightboxSource) => void;
  setSelectedPhotoId: (id: number | null, source?: LightboxSource) => void;
  setAiProcessingStatus: (status: AiProcessingStatus | null) => void;
  updatePhotoInList: (photoId: number, updates: Partial<Photo>) => void;
  updatePhotosInList: (photoIds: number[], updates: Partial<Photo>) => void;
  loadPhotos: () => Promise<void>;
  loadMore: () => Promise<void>;
  reset: () => void;
}

export function photoFilterKey(filter: PhotoFilter) {
  return JSON.stringify(Object.entries(filter).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)));
}

type PhotoListSnapshot = Pick<AppState, "photos" | "totalPhotos" | "cursor" | "hasNext" | "photoGridScrollOffsets">;
const photoLists = new Map<string, PhotoListSnapshot>();

export const useStore = create<AppState>((set, get) => ({
  project: null,
  setProject: (p) => set((state) => {
    if (p?.root_path === state.project?.root_path) return { project: p };
    photoLists.clear();
    return {
      ratingSelectionMode: false, ratingSelection: [], ratingSelectionAnchor: null,
      project: p, photos: [], totalPhotos: 0, cursor: null, hasNext: false,
      loading: false, photoLoadError: null, photoGridScrollOffsets: { square: 0, proportional: 0 },
      lightboxPhotoId: null, lightboxSource: null, selectedPhotoId: null, selectedLightboxSource: null,
      gpsBatchSession: null, batchGpsPending: new Map(),
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
  lightboxSource: null,
  selectedPhotoId: null,
  selectedLightboxSource: null,
  photoMetadataRevision: 0,
  refreshPhotoMetadata: async () => {
    photoLists.clear();
    set((state) => ({ photoMetadataRevision: state.photoMetadataRevision + 1 }));
    await get().loadPhotos();
  },
  faceDataRevision: 0,
  markFaceDataChanged: () => {
    photoLists.clear();
    set((state) => ({ faceDataRevision: state.faceDataRevision + 1 }));
  },
  ratingSelectionMode: false,
  ratingSelection: [],
  ratingSelectionAnchor: null,
  setRatingSelectionMode: (enabled) => set({ ratingSelectionMode: enabled, ratingSelection: [], ratingSelectionAnchor: null }),
  toggleRatingSelection: (photoId, extend = false) => set((state) => {
    if (extend && state.ratingSelectionAnchor != null) {
      const start = state.photos.findIndex((photo) => photo.id === state.ratingSelectionAnchor);
      const end = state.photos.findIndex((photo) => photo.id === photoId);
      if (start >= 0 && end >= 0) {
        const selected = new Set(state.ratingSelection);
        for (const photo of state.photos.slice(Math.min(start, end), Math.max(start, end) + 1)) {
          if (photo.id != null) selected.add(photo.id);
        }
        return { ratingSelection: [...selected] };
      }
    }
    return {
      ratingSelection: state.ratingSelection.includes(photoId)
        ? state.ratingSelection.filter((id) => id !== photoId)
        : [...state.ratingSelection, photoId],
      ratingSelectionAnchor: photoId,
    };
  }),
  selectAllRatingPhotos: async () => {
    const { photos, filter, totalPhotos, loading, cursor, hasNext, _photoRequestGeneration } = get();
    if (loading || !photos.length) return;
    if (totalPhotos > 5000) {
      set({ ratingSelection: photos.map(({ id }) => id).filter((id): id is number => id != null).slice(0, 5000), ratingSelectionAnchor: null });
      return;
    }
    const isCurrent = () => get()._photoRequestGeneration === _photoRequestGeneration;
    const all = new Map(photos.map((photo) => [photo.id, photo]));
    let next = cursor;
    let more = hasNext;
    let total = totalPhotos;
    set({ loading: true });
    try {
      while (more && next && isCurrent()) {
        const page = await readPhotoData(() => api.getPhotos(next, 500, filter), isCurrent);
        if (page.total_count > 5000) throw new Error("批量操作上限为 5000 张，请缩小筛选范围。");
        for (const photo of page.photos) all.set(photo.id, photo);
        if (page.has_more && page.next_cursor?.id === next.id) throw new Error("照片分页未前进，请重试。");
        next = page.next_cursor;
        more = page.has_more;
        total = page.total_count;
      }
      if (!isCurrent()) return;
      if (more) throw new Error("未能读取全部照片，请重试。");
      set({
        photos: [...all.values()], cursor: next, hasNext: false, totalPhotos: total,
        ratingSelection: [...all.keys()].filter((id): id is number => id != null),
        ratingSelectionAnchor: null,
      });
    } finally {
      if (isCurrent()) set({ loading: false });
    }
  },
  clearRatingSelection: () => set({ ratingSelection: [], ratingSelectionAnchor: null }),
  gpsBatchSession: null,
  openGpsBatchEditor: (gpsBatchSession) => set({ gpsBatchSession, selectedPhotoId: null }),
  closeGpsBatchEditor: () => set({ gpsBatchSession: null, batchGpsPending: new Map() }),
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
  setFilter: (partial, replace = false, restore = false) => set((state) => {
    const nextFilter = replace ? { ...partial } : { ...state.filter, ...partial };
    const previousKey = photoFilterKey(state.filter);
    const nextKey = photoFilterKey(nextFilter);
    if (previousKey === nextKey) return state;
    if (state.photos.length) {
      photoLists.delete(previousKey);
      const { photos, totalPhotos, cursor, hasNext, photoGridScrollOffsets } = state;
      photoLists.set(previousKey, { photos, totalPhotos, cursor, hasNext, photoGridScrollOffsets });
      if (photoLists.size > 6) photoLists.delete(photoLists.keys().next().value!);
    }
    const snapshot = restore ? photoLists.get(nextKey) : undefined;
    return {
      filter: nextFilter,
      photos: [],
      totalPhotos: 0,
      cursor: null,
      hasNext: false,
      loading: false,
      photoLoadError: null,
      preloadQueue: [],
      ratingSelection: [], ratingSelectionAnchor: null,
      photoGridScrollOffsets: { square: 0, proportional: 0 },
      ...snapshot,
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
  setPhotoGridScrollOffset: (shape, offset, key = photoFilterKey(get().filter)) => {
    if (key === photoFilterKey(get().filter)) {
      set((state) => ({ photoGridScrollOffsets: { ...state.photoGridScrollOffsets, [shape]: offset } }));
    } else {
      const snapshot = photoLists.get(key);
      if (snapshot) snapshot.photoGridScrollOffsets = { ...snapshot.photoGridScrollOffsets, [shape]: offset };
    }
  },
  setLightboxPhotoId: (id) => set((state) => ({
    lightboxPhotoId: id,
    lightboxSource: id == null ? null : state.lightboxSource,
  })),
  openLightbox: (id, source) => set({ lightboxPhotoId: id, lightboxSource: source }),
  setSelectedPhotoId: (id, source) => set({ selectedPhotoId: id, selectedLightboxSource: source ?? null }),
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
    photoLists.clear();
    const state = get();
    set({
      photos: [], totalPhotos: 0, cursor: null, hasNext: false, filter: {},
      selectedPhotoId: null, lightboxPhotoId: null,
      selectedLightboxSource: null, lightboxSource: null,
      ratingSelectionMode: false, ratingSelection: [], ratingSelectionAnchor: null,
      gpsBatchSession: null, batchGpsPending: new Map(),
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
