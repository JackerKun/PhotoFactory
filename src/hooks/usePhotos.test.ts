import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Photo, PhotoPage } from "../types";

vi.mock("../api/tauri", () => ({
  getPhotos: vi.fn(),
  getThumbnailPath: vi.fn(() => Promise.resolve("/tmp/thumb.webp")),
}));

import * as api from "../api/tauri";
import { useStore } from "./usePhotos";

function photo(id: number): Photo {
  return {
    id,
    path: `/photos/${id}.jpg`,
    filename: `${id}.jpg`,
    file_size: 100,
    file_mtime: id,
    width: 100,
    height: 100,
    format: "jpg",
    taken_at: id,
    camera_make: null,
    camera_model: null,
    exposure_time: null,
    f_number: null,
    iso: null,
    latitude: null,
    longitude: null,
    orientation: 1,
    thumbnail_status: 1,
    ai_status: 0,
    deleted: false,
    is_favorite: false,
    imported_at: id,
  };
}

function page(photos: Photo[], totalCount: number, hasMore: boolean): PhotoPage {
  const last = photos.at(-1);
  return {
    photos,
    total_count: totalCount,
    has_more: hasMore,
    next_cursor: hasMore && last ? { id: last.id!, sort_value: last.taken_at! } : null,
  };
}

describe("photo pagination store", () => {
  beforeEach(() => {
    vi.mocked(api.getPhotos).mockReset();
    useStore.getState().reset();
  });

  it("always refreshes from the first page and records the filtered total", async () => {
    useStore.setState({
      photos: [photo(99)],
      totalPhotos: 99,
      cursor: { id: 99, sort_value: 99 },
      hasNext: true,
    });
    vi.mocked(api.getPhotos).mockResolvedValue(page([photo(5), photo(4)], 5, true));

    await useStore.getState().loadPhotos();

    expect(api.getPhotos).toHaveBeenCalledWith(null, 200, {});
    expect(useStore.getState().photos.map((item) => item.id)).toEqual([5, 4]);
    expect(useStore.getState().totalPhotos).toBe(5);
  });

  it("retries a locked database without clearing existing photos", async () => {
    useStore.setState({ photos: [photo(1)] });
    vi.mocked(api.getPhotos)
      .mockRejectedValueOnce("database is locked")
      .mockResolvedValueOnce(page([photo(2)], 1, false));
    const load = useStore.getState().loadPhotos();
    expect(useStore.getState().photos.map((item) => item.id)).toEqual([1]);
    await load;
    expect(api.getPhotos).toHaveBeenCalledTimes(2);
    expect(useStore.getState().photos.map((item) => item.id)).toEqual([2]);
  });

  it("ends loading on a stalled request and ignores its late response after retry", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let finish!: (result: PhotoPage) => void;
      vi.mocked(api.getPhotos).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
      const stalled = useStore.getState().loadPhotos();
      await vi.advanceTimersByTimeAsync(12_000);
      await stalled;
      expect(useStore.getState().loading).toBe(false);
      expect(useStore.getState().photoLoadError?.message).toContain("超时");
      vi.mocked(api.getPhotos).mockResolvedValueOnce(page([photo(2)], 1, false));
      await useStore.getState().loadPhotos();
      finish(page([photo(1)], 1, false));
      await Promise.resolve();
      expect(useStore.getState().photos.map((item) => item.id)).toEqual([2]);
      expect(useStore.getState().photoLoadError).toBeNull();
    } finally {
      vi.useRealTimers();
      log.mockRestore();
    }
  });

  it("keeps every lazily loaded page instead of discarding photos after 2000", async () => {
    const initial = Array.from({ length: 2000 }, (_, index) => photo(3000 - index));
    useStore.setState({
      photos: initial,
      totalPhotos: 2200,
      cursor: { id: 1001, sort_value: 1001 },
      hasNext: true,
      loading: false,
    });
    const additional = Array.from({ length: 200 }, (_, index) => photo(1000 - index));
    vi.mocked(api.getPhotos).mockResolvedValue(page(additional, 2200, false));

    await useStore.getState().loadMore();

    expect(useStore.getState().photos).toHaveLength(2200);
    expect(useStore.getState().hasNext).toBe(false);
    expect(useStore.getState().totalPhotos).toBe(2200);
  });

  it("keeps the Photos route and per-layout scroll positions until the project is reset", () => {
    const state = useStore.getState();
    state.setPhotoRoute("/?dir=%2Fphotos%2Ftrip");
    state.setPhotoGridScrollOffset("square", 920);
    state.setPhotoGridScrollOffset("proportional", 640);

    expect(useStore.getState().photoRoute).toBe("/?dir=%2Fphotos%2Ftrip");
    expect(useStore.getState().photoGridScrollOffsets).toEqual({ square: 920, proportional: 640 });

    state.reset();
    expect(useStore.getState().photoRoute).toBe("/");
    expect(useStore.getState().photoGridScrollOffsets).toEqual({ square: 0, proportional: 0 });
  });

  it("resets saved grid positions when the photo filter changes", () => {
    const state = useStore.getState();
    state.setPhotoGridScrollOffset("square", 500);
    state.setPhotoGridScrollOffset("proportional", 300);

    state.setFilter({ directory: "/photos/another-folder" });

    expect(useStore.getState().photoGridScrollOffsets).toEqual({ square: 0, proportional: 0 });
  });

  it("does not discard the current page when the same filter is selected again", () => {
    useStore.setState({
      photos: [photo(3), photo(2)],
      filter: { directory: "/photos/trip" },
      photoGridScrollOffsets: { square: 400, proportional: 250 },
    });

    useStore.getState().setFilter({ directory: "/photos/trip" });

    expect(useStore.getState().photos.map((item) => item.id)).toEqual([3, 2]);
    expect(useStore.getState().photoGridScrollOffsets).toEqual({ square: 400, proportional: 250 });
  });

  it("clears every contextual filter when returning to All Photos", () => {
    useStore.setState({
      filter: {
        directory: "/photos/trip",
        tag: "夜景",
        person_id: 32,
        has_gps: true,
        has_favorite: true,
        year: 2026,
        month: 8,
      },
      photos: [photo(1)],
    });

    useStore.getState().clearPhotoFilters();

    expect(useStore.getState().filter).toEqual({
      directory: undefined,
      tag: undefined,
      person_id: undefined,
      has_gps: undefined,
      has_favorite: undefined,
      year: undefined,
      month: undefined,
    });
    expect(useStore.getState().photos).toEqual([]);
  });
});
