import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Mock @tauri-apps/api/core
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `http://localhost:1420/_app/data${path}`,
}));

// Mock the api module
vi.mock("../api/tauri", () => ({
  getThumbnailPath: vi.fn((_photoId: number, _size: string) =>
    Promise.resolve("/mock/thumbnails/thumb.jpg"),
  ),
  getPhotoDataUrl: vi.fn((_path: string) =>
    Promise.resolve("data:image/png;base64,mock"),
  ),
  togglePhotoFavorite: vi.fn(() => Promise.resolve(true)),
  revealInFileManager: vi.fn(() => Promise.resolve()),
}));

// Mock zustand store
vi.mock("../hooks/usePhotos", () => {
  const { create } = require("zustand");
  const useStore = create(() => ({
    photos: [],
    updatePhotoInList: () => {},
  }));
  return { useStore, default: () => useStore() };
});

import PhotoCard from "./PhotoCard";
import type { Photo } from "../types";

afterEach(() => vi.useRealTimers());

const mockPhoto: Photo = {
  id: 1,
  path: "/mock/photo.jpg",
  filename: "photo.jpg",
  file_size: 1024 * 1024,
  file_mtime: Date.now(),
  width: 1920,
  height: 1080,
  format: "jpeg",
  taken_at: Date.now(),
  camera_make: "Canon",
  camera_model: "EOS R5",
  exposure_time: "1/125",
  f_number: "f/2.8",
  iso: 400,
  latitude: null,
  longitude: null,
  orientation: 1,
  thumbnail_status: 0,
  ai_status: 0,
  deleted: false,
  is_favorite: false,
  imported_at: Date.now(),
};

describe("PhotoCard", () => {
  it("renders with a photo filename", () => {
    render(
      <PhotoCard
        photo={mockPhoto}
        onClick={() => {}}
        size={200}
      />,
    );

    expect(screen.getByText("photo.jpg")).toBeInTheDocument();
  });

  it("shows a spinner while loading (no URL yet)", () => {
    const { container } = render(
      <PhotoCard
        photo={mockPhoto}
        onClick={() => {}}
        size={200}
      />,
    );

    // Before IntersectionObserver fires, should show spinner
    const spinner = container.querySelector(".animate-spin");
    expect(spinner).toBeInTheDocument();
  });

  it("shows a distinct favorite heart for favorite photos", () => {
    render(
      <PhotoCard
        photo={{ ...mockPhoto, is_favorite: true }}
        onClick={() => {}}
        size={200}
      />,
    );

    expect(screen.getByTitle("收藏")).toHaveTextContent("♥");
  });

  it("runs the single-click action after the double-click window", () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    const { container } = render(<PhotoCard photo={mockPhoto} onClick={onClick} size={200} />);

    fireEvent.click(container.firstElementChild!);
    expect(onClick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(220);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("cancels detail selection when the same gesture becomes a double click", () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    const onDoubleClick = vi.fn();
    const { container } = render(
      <PhotoCard photo={mockPhoto} onClick={onClick} onDoubleClick={onDoubleClick} size={200} />,
    );

    fireEvent.click(container.firstElementChild!);
    fireEvent.doubleClick(container.firstElementChild!);
    vi.advanceTimersByTime(220);
    expect(onClick).not.toHaveBeenCalled();
    expect(onDoubleClick).toHaveBeenCalledOnce();
  });
});

describe("thumbnail loading recovery", () => {
  async function observeVisibleCard() {
    const { act } = await import("@testing-library/react");
    const { getThumbnailPath } = await import("../api/tauri");
    let visible: IntersectionObserverCallback = () => {};
    const observer = { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    vi.stubGlobal("IntersectionObserver", vi.fn((callback: IntersectionObserverCallback) => {
      visible = callback;
      return observer;
    }));
    const view = render(<PhotoCard photo={mockPhoto} onClick={() => {}} size={200} />);
    await act(async () => {
      visible([{ isIntersecting: true, target: view.container.firstElementChild! } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
    });
    return { ...view, getThumbnailPath, act, visible, observer };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("retries when native thumbnail decoder slots are temporarily full", async () => {
    vi.useFakeTimers();
    const api = await import("../api/tauri");
    vi.mocked(api.getThumbnailPath)
      .mockRejectedValueOnce("Too many concurrent thumbnail generations, try again later")
      .mockResolvedValue("/mock/recovered.webp");
    const { container, act, getThumbnailPath } = await observeVisibleCard();
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(getThumbnailPath).toHaveBeenCalledTimes(2);
    expect(container.querySelector("img")?.getAttribute("src")).toContain("recovered.webp");
  });

  it("reloads a failed card after background generation completes", async () => {
    const api = await import("../api/tauri");
    vi.mocked(api.getThumbnailPath).mockRejectedValueOnce("decoder not ready").mockResolvedValue("/mock/completed.webp");
    const { container, act, observer, getThumbnailPath } = await observeVisibleCard();
    const { useStore } = await import("../hooks/usePhotos");
    await act(async () => {
      useStore.setState({ thumbnailProcessingStatus: {
        running: true, batch_size: 100, total_pending: 1, processed: 1,
        succeeded: 1, failed: 0, current_file: null, last_error: null,
      } });
    });
    // The new effect registers a new visibility callback.
    const callback = vi.mocked(IntersectionObserver).mock.calls.at(-1)![0];
    await act(async () => { callback([{ isIntersecting: true } as IntersectionObserverEntry], observer as unknown as IntersectionObserver); });
    expect(getThumbnailPath).toHaveBeenCalledTimes(2);
    expect(container.querySelector("img")?.getAttribute("src")).toContain("completed.webp");
  });
  it("shows an inaccessible source and retries that card without remounting", async () => {
    const api = await import("../api/tauri");
    vi.mocked(api.getThumbnailPath).mockRejectedValueOnce("No such file or directory").mockResolvedValue("/mock/restored.webp");
    const { container, act } = await observeVisibleCard();
    expect(screen.getByText("原文件无法访问")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重试" })); });
    const callback = vi.mocked(IntersectionObserver).mock.calls.at(-1)![0];
    await act(async () => { callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver); });
    expect(container.querySelector("img")?.getAttribute("src")).toContain("restored.webp");
  });
});
