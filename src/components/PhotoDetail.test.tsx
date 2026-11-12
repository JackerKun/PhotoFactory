import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import type { FaceCluster, FaceDetection, Photo } from "../types";
import ActiveFilters from "./ActiveFilters";
import Lightbox from "./Lightbox";
import PhotoDetail from "./PhotoDetail";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path }));
vi.mock("../api/tauri", () => ({
  getPhoto: vi.fn(),
  getLightboxPhotos: vi.fn(),
  getPhotoEdit: vi.fn(async () => null),
  getPhotoFaces: vi.fn(),
  getClusters: vi.fn(),
  getPhotoAttributes: vi.fn(async () => []),
  getManualTags: vi.fn(async () => []),
  getPhotoManualTags: vi.fn(async () => []),
  getThumbnailPath: vi.fn(async () => "/preview.jpg"),
  renameCluster: vi.fn(),
  mergeClustersBatch: vi.fn(),
  createNamedPersonForFace: vi.fn(async () => 42),
  reassignPhotoFace: vi.fn(),
}));

function photo(id: number): Photo {
  return {
    id, filename: `${id}.jpg`, path: `/photos/${id}.jpg`, file_size: 1, file_mtime: 0,
    width: 200, height: 300, format: "jpeg", taken_at: null, camera_make: null,
    camera_model: null, exposure_time: null, f_number: null, iso: null,
    latitude: null, longitude: null, orientation: 1, thumbnail_status: 1,
    ai_status: 0, deleted: false, is_favorite: false, imported_at: 0,
  };
}

function face(photoId: number, personId: number | null): FaceDetection {
  return {
    id: photoId + 100, photo_id: photoId, person_id: personId, bbox_x: 30, bbox_y: 30,
    bbox_w: 30, bbox_h: 30, created_at: 0, embedding_path: null,
  };
}

beforeEach(() => {
  vi.mocked(api.getPhoto).mockImplementation(async (id) => photo(id));
  vi.mocked(api.getLightboxPhotos).mockResolvedValue([photo(1), photo(2)]);
  vi.mocked(api.getPhotoFaces).mockImplementation(async (id) => [face(id, 41)]);
  const cluster: FaceCluster = { id: 41, name: null, face_count: 2, photo_count: 2, confidence: "medium", created_at: 0 };
  vi.mocked(api.getClusters).mockImplementation(async () => [{ ...cluster }]);
  vi.mocked(api.renameCluster).mockImplementation(async (id, name) => {
    if (id === cluster.id) cluster.name = name;
  });
});

afterEach(() => {
  cleanup();
  useStore.getState().reset();
  vi.clearAllMocks();
});

it("scrolls the lightbox filmstrip in both directions with a vertical mouse wheel", async () => {
  useStore.setState({ lightboxPhotoId: 1 });
  render(<MemoryRouter><Lightbox photoId={1} onClose={vi.fn()} /></MemoryRouter>);
  await screen.findByRole("img", { name: "1.jpg" });
  const filmstrip = screen.getByRole("region", { name: "照片缩略图带" });
  Object.defineProperties(filmstrip, {
    scrollWidth: { value: 1200 },
    clientWidth: { value: 400 },
  });

  expect(fireEvent.wheel(filmstrip, { deltaY: 160 })).toBe(false);
  expect(filmstrip.scrollLeft).toBe(160);
  expect(fireEvent.wheel(filmstrip, { deltaY: -3, deltaMode: WheelEvent.DOM_DELTA_LINE })).toBe(false);
  expect(filmstrip.scrollLeft).toBe(112);
  expect(fireEvent.wheel(filmstrip, { deltaX: 80, deltaY: 4 })).toBe(true);
  expect(fireEvent.wheel(filmstrip, { ctrlKey: true, deltaY: 50 })).toBe(true);
  expect(filmstrip.scrollLeft).toBe(112);
  expect(useStore.getState().lightboxPhotoId).toBe(1);
});

it("names the original group from the photo detail and refreshes both photos and the active filter", async () => {
  useStore.setState({ selectedPhotoId: 1, filter: { person_id: 41 } });
  const page = (id: number) => <MemoryRouter><ActiveFilters /><Lightbox photoId={id} onClose={vi.fn()} /></MemoryRouter>;
  const { rerender } = render(page(1));

  fireEvent.click(await screen.findByRole("button", { name: "修改" }));
  expect(screen.getByText("组名将应用于该组的 2 张照片。")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "人物组姓名" }), { target: { value: " 张三 " } });
  fireEvent.click(screen.getByRole("button", { name: "保存组名" }));

  expect(await screen.findByText("人物：张三")).toBeInTheDocument();
  await waitFor(() => expect(screen.getAllByText("张三")).toHaveLength(2));
  expect(api.renameCluster).toHaveBeenCalledExactlyOnceWith(41, "张三");
  expect(api.createNamedPersonForFace).not.toHaveBeenCalled();
  expect(api.reassignPhotoFace).not.toHaveBeenCalled();

  rerender(page(2));
  expect(await screen.findByRole("img", { name: "2.jpg" })).toBeInTheDocument();
  await waitFor(() => expect(screen.getAllByText("张三")).toHaveLength(2));
});

it("creates a person when the selected face does not belong to a group", async () => {
  vi.mocked(api.getPhotoFaces).mockResolvedValue([face(1, null)]);
  render(<MemoryRouter><PhotoDetail photoId={1} onClose={vi.fn()} /></MemoryRouter>);

  fireEvent.click(await screen.findByRole("button", { name: "修改" }));
  fireEvent.change(screen.getByRole("textbox", { name: "新人物姓名" }), { target: { value: "李四" } });
  fireEvent.click(screen.getByRole("button", { name: "新建人物", exact: true }));

  await screen.findByRole("button", { name: "修改" });
  expect(api.createNamedPersonForFace).toHaveBeenCalledExactlyOnceWith(101, "李四");
  expect(api.renameCluster).not.toHaveBeenCalled();
});

it("merges all eight photos into the chosen existing person and follows that person in the grid", async () => {
  const source: FaceCluster = { id: 41, name: null, face_count: 8, photo_count: 8, confidence: "medium", created_at: 0 };
  const target: FaceCluster = { ...source, id: 42, name: "张三", face_count: 1, photo_count: 1 };
  let merged = false;
  vi.mocked(api.getClusters).mockImplementation(async () => merged ? [{ ...target, photo_count: 9 }] : [source, target]);
  vi.mocked(api.getPhotoFaces).mockImplementation(async (id) => [face(id, merged ? 42 : 41)]);
  vi.mocked(api.mergeClustersBatch).mockImplementation(async () => {
    merged = true;
    return 42;
  });
  useStore.setState({ filter: { person_id: 41, sort_by: "name" } });
  render(<MemoryRouter><ActiveFilters /><PhotoDetail photoId={1} onClose={vi.fn()} /></MemoryRouter>);

  fireEvent.click(await screen.findByRole("button", { name: "修改" }));
  fireEvent.change(screen.getByRole("combobox", { name: "选择整组合并到的人物" }), { target: { value: "42" } });
  fireEvent.click(screen.getByRole("button", { name: "整组合并" }));

  expect(await screen.findByText("人物：张三")).toBeInTheDocument();
  expect(await screen.findByText("张三", { selector: "span" })).toBeInTheDocument();
  expect(api.mergeClustersBatch).toHaveBeenCalledExactlyOnceWith([41], undefined, 42);
  expect(api.reassignPhotoFace).not.toHaveBeenCalled();
  expect(api.renameCluster).not.toHaveBeenCalled();
  expect(useStore.getState().filter).toEqual({ person_id: 42, sort_by: "name" });
});
