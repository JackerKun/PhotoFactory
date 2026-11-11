import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import * as api from "../api/tauri";
import GroupPhotosView from "./GroupPhotosView";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("./PhotoCard", () => ({ default: ({ photo }: { photo: { filename: string } }) => <div>{photo.filename}</div> }));
vi.mock("../api/tauri", () => ({
  getClusters: vi.fn(async () => [{ id: 1, name: "甲" }, { id: 2, name: "乙" }, { id: 3, name: null }]),
  getGroupPhotos: vi.fn(async () => [{ photo: { id: 10, filename: "合影.jpg" }, people_count: 2, unconfirmed_count: 1 }]),
  createPersonCombination: vi.fn(async () => 3),
}));

it("filters by people and saves the exact combination separately from the size filter", async () => {
  render(<MemoryRouter><GroupPhotosView onBack={vi.fn()} /></MemoryRouter>);
  expect(await screen.findByText("合影.jpg")).toBeInTheDocument();
  expect(screen.getByText("2 人 · 1 人待确认")).toBeInTheDocument();
  await screen.findByRole("option", { name: "甲" });
  const picker = screen.getByRole("combobox", { name: "添加筛选人物" });
  fireEvent.click(screen.getByRole("button", { name: "双人" }));
  fireEvent.change(picker, { target: { value: "1" } });
  fireEvent.change(picker, { target: { value: "2" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "仅包含所选人物" }));
  await waitFor(() => expect(api.getGroupPhotos).toHaveBeenLastCalledWith(2, [1, 2], true));
  fireEvent.change(screen.getByRole("textbox", { name: "人物组合相册名称" }), { target: { value: "  家人  " } });
  fireEvent.click(screen.getByRole("button", { name: "保存为人物组合相册" }));
  expect(await screen.findByRole("link", { name: "打开相册" })).toHaveAttribute("href", "/albums");
  expect(api.createPersonCombination).toHaveBeenCalledWith("家人", [1, 2], true);
});
