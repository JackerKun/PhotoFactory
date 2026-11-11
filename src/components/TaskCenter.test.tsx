import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import type { Project } from "../types";
import TaskCenter from "./TaskCenter";

vi.mock("../api/tauri", () => ({
  getThumbnailProcessingStatus: vi.fn(async () => ({ running: false, processed: 10, succeeded: 8, failed: 2, total_pending: 0, last_error: "无法读取原文件" })),
  getAiPipelineStatus: vi.fn(async () => ({ status: "error", stage: "error", processed: 3, total: 10, failed: 1, last_error: "模型无法加载" })),
  getAiRuntime: vi.fn(async () => ({ models: { face_detection: "DmlExecutionProvider" }, face_batch: { photos: 10, preview_hits: 4 } })),
  getThumbnailPerformance: vi.fn(async () => "balanced"),
  setThumbnailPerformance: vi.fn(async () => {}),
  getLibraryJobs: vi.fn(async () => []),
  controlAiPipeline: vi.fn(async () => {}),
}));
afterEach(() => { cleanup(); useStore.setState({ project: null, aiProcessingStatus: null, thumbnailProcessingStatus: null }); vi.restoreAllMocks(); });
it("keeps failed thumbnail and AI jobs visible in one task dialog and retries AI", async () => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } });
  useStore.setState({ project: { root_path: "/test" } as Project });
  render(<TaskCenter />);
  await waitFor(() => expect(useStore.getState().aiProcessingStatus?.stage).toBe("error"));
  fireEvent.click(screen.getByRole("button", { name: "后台任务" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  const performance = screen.getByRole("combobox", { name: "缩略图性能" });
  await waitFor(() => expect(performance).toHaveValue("balanced"));
  fireEvent.change(performance, { target: { value: "full" } });
  await waitFor(() => expect(api.setThumbnailPerformance).toHaveBeenCalledWith("full"));
  expect(screen.getByText("无法读取原文件")).toBeInTheDocument();
  expect(screen.getByText("模型无法加载")).toBeInTheDocument();
  expect(await screen.findByText("人脸检测：DirectML (GPU)")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试失败" }));
  await waitFor(() => expect(api.controlAiPipeline).toHaveBeenCalledWith("retry"));
});
