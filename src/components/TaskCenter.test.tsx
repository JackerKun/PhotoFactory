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
  getTaskErrors: vi.fn(async () => ({
    entries: [], next_before: null, retryable: 0, failed_faces: 1, failed_classifications: 0,
    platform: "windows", architecture: "x86_64", version: "0.1.4",
  })),
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

it("shows a previous batch interruption after the pipeline resumes and copies its files and cause", async () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    vi.mocked(api.getAiPipelineStatus).mockResolvedValueOnce({ status: "running", stage: "face_detection", processed: 655, total: 3560, failed: 1 });
    vi.mocked(api.getTaskErrors).mockResolvedValueOnce({
      entries: [{
        id: 1, stage: "face_detection", kind: "batch", occurred_at: 1760000000,
        message: "原因：Connection reset by peer (os error 10054)",
        photos: [{ filename: "DSC001.jpg", path: "D:\\Photos\\DSC001.jpg", attempts: 2 }],
      }],
      next_before: null, retryable: 1, failed_faces: 0, failed_classifications: 0,
      platform: "windows", architecture: "x86_64", version: "0.1.4",
    });
    useStore.setState({ project: { root_path: "/test" } as Project });
    render(<TaskCenter />);
    fireEvent.click(screen.getByRole("button", { name: "后台任务" }));
    expect(await screen.findByText("识别人脸 · 批次中断 · 1 张")).toBeInTheDocument();
    expect(screen.getByText(/已跳过失败的照片/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试失败" })).toBeDisabled();
    expect(screen.getByText("D:\\Photos\\DSC001.jpg")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制本页诊断" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Connection reset by peer")));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("D:\\Photos\\DSC001.jpg"));
  } finally {
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});
