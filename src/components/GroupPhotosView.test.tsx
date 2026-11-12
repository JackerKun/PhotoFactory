import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import * as api from "../api/tauri";
import GroupPhotosView from "./GroupPhotosView";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path }));
vi.mock("./PhotoCard", () => ({ default: () => null }));
vi.mock("../api/tauri", () => ({
  getClusters: vi.fn(async () => [{ id: 1, name: "甲" }, { id: 2, name: "乙" }, { id: 3, name: null }]),
  getThumbnailPath: vi.fn(async () => "/cover.jpg"),
  getNamedPhotoGroups: vi.fn(async () => [{ person_ids: [1, 2], names: ["甲", "乙"], cover_photo_id: 11, photo_count: 3 }]),
  getGroupPhotos: vi.fn(async (_size, _ids, _exact, _cursor, namedOnly) => namedOnly
    ? [{ photo: { id: 11, filename: "已命名合影.jpg" }, people_count: 2, unconfirmed_count: 0 }]
    : [{ photo: { id: 10, filename: "合影.jpg" }, people_count: 2, unconfirmed_count: 1 }]),
  createPersonCombination: vi.fn(async () => 3),
}));

it("opens named groups by default and drills into the exact roster", async () => {
  render(<MemoryRouter><GroupPhotosView /></MemoryRouter>);
  expect(screen.getByRole("button", { name: "人物分组", pressed: true })).toBeInTheDocument();
  const group = await screen.findByRole("button", { name: /甲、乙.*3 张照片/ });
  expect(api.getNamedPhotoGroups).toHaveBeenLastCalledWith(0, [], false, 0);
  fireEvent.click(group);
  expect(await screen.findByText("已命名合影.jpg")).toBeInTheDocument();
  expect(api.getGroupPhotos).toHaveBeenLastCalledWith(0, [1, 2], true, undefined, true);
  fireEvent.click(screen.getByRole("button", { name: "返回分组" }));
  expect(screen.getByRole("button", { name: /甲、乙.*3 张照片/ })).toBeInTheDocument();
});

it("filters by people and saves the exact combination separately from the size filter", async () => {
  render(<MemoryRouter><GroupPhotosView /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "合影列表" }));
  expect(await screen.findByText("合影.jpg")).toBeInTheDocument();
  expect(screen.getByText("2 人 · 1 人待确认")).toBeInTheDocument();
  await screen.findByRole("option", { name: "甲" });
  const picker = screen.getByRole("combobox", { name: "按人物筛选" });
  expect(screen.getByRole("option", { name: "按人物筛选" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "双人" }));
  fireEvent.change(picker, { target: { value: "1" } });
  fireEvent.change(picker, { target: { value: "2" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "仅包含所选人物" }));
  await waitFor(() => expect(api.getGroupPhotos).toHaveBeenLastCalledWith(2, [1, 2], true, undefined));
  fireEvent.change(screen.getByRole("textbox", { name: "人物组合相册名称" }), { target: { value: "  家人  " } });
  fireEvent.click(screen.getByRole("button", { name: "保存为人物组合相册" }));
  expect(await screen.findByRole("link", { name: "打开相册" })).toHaveAttribute("href", "/albums");
  expect(api.createPersonCombination).toHaveBeenCalledWith("家人", [1, 2], true);
});
