import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import type { Project } from "../types";
import TaskCenter from "./TaskCenter";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

vi.mock("../api/tauri", () => ({
  getThumbnailProcessingStatus: vi.fn(async () => ({ running: false, processed: 10, succeeded: 8, failed: 2, total_pending: 0, last_error: "无法读取原文件" })),
  getAiPipelineStatus: vi.fn(async () => ({ status: "error", stage: "error", processed: 3, total: 10, failed: 1, last_error: "模型无法加载" })),
  getAiRuntime: vi.fn(async () => ({ models: { face_detection: "DmlExecutionProvider" }, face_batch: { photos: 10, preview_hits: 4 } })),
  getAiWorkerDiagnostics: vi.fn(async () => ({ version: "0.1.7", platform: "windows", architecture: "x86_64", status: "idle", port: 9876, pid: null, entries: [], log_error: null })),
  startAiWorker: vi.fn(async () => "AI worker ready"),
  checkAiPhoto: vi.fn(),
  clearAiWorkerDiagnostics: vi.fn(),
  getThumbnailPerformance: vi.fn(async () => "balanced"),
  setThumbnailPerformance: vi.fn(async () => {}),
  getLibraryJobs: vi.fn(async () => []),
  controlAiPipeline: vi.fn(async () => {}),
  retryLibraryAnalysis: vi.fn(),
  getTaskErrors: vi.fn(async () => ({
    groups: [], stages: [], next_before: null, history_through: 0, retryable: 0, failed_faces: 1, failed_classifications: 0, ignored_count: 0,
    platform: "windows", architecture: "x86_64", version: "0.1.4",
  })),
  getTaskErrorPhotos: vi.fn(),
  clearTaskErrorHistory: vi.fn(),
  getIgnoredTaskPhotos: vi.fn(),
  ignoreTaskErrorPhotos: vi.fn(),
  restoreTaskPhoto: vi.fn(),
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
  fireEvent.click(screen.getByText(/^当前提示/));
  expect(screen.getByText("无法读取原文件")).toBeInTheDocument();
  expect(screen.getByText("模型无法加载")).toBeInTheDocument();
  expect(await screen.findByText("人脸检测：DirectML (GPU)")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试失败" }));
  await waitFor(() => expect(api.controlAiPipeline).toHaveBeenCalledWith("retry"));
});

it("retries an index job by ID and replaces the stopped card with the active one", async () => {
  const stopped = { id: 12, job_type: "intelligence+ocr", status: "canceled", progress: 4,
    total: 20, message: "", error: null, created_at: 1, updated_at: 1 };
  vi.mocked(api.getLibraryJobs).mockResolvedValueOnce([stopped])
    .mockResolvedValueOnce([{ ...stopped, status: "running", progress: 0 }]);
  vi.mocked(api.retryLibraryAnalysis).mockResolvedValueOnce(stopped.id);
  useStore.setState({ project: { root_path: "/test" } as Project });
  render(<TaskCenter />);
  fireEvent.click(screen.getByRole("button", { name: "后台任务" }));
  const retry = await screen.findByRole("button", { name: "重试", exact: true });
  fireEvent.click(retry);
  fireEvent.click(retry);
  await waitFor(() => expect(api.retryLibraryAnalysis).toHaveBeenCalledExactlyOnceWith(stopped.id));
  expect(screen.getAllByRole("heading", { name: "智能索引与文字识别" })).toHaveLength(1);
  await waitFor(() => expect(screen.queryByRole("button", { name: "重试", exact: true })).not.toBeInTheDocument());
});

it("groups repeated failures and lets the user inspect, ignore and restore photos", async () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    vi.mocked(api.getAiPipelineStatus).mockResolvedValueOnce({ status: "running", stage: "face_detection", processed: 655, total: 3560, failed: 1 });
    const key = { stage: "face_detection", reason: "HTTP error", through: 5 };
    const photo = { photo_id: 42, filename: "DSC001.jpg", path: "D:\\Photos\\DSC001.jpg", attempts: 2, occurred_at: 1759999999 };
    const details = { photos: [{ ...photo, ignored: false, can_ignore: true }], total: 1, can_ignore: 1, next_after: null };
    const page: api.TaskErrorPage = {
      groups: [{
        key, occurrences: 5, first_occurred_at: 1759999998, occurred_at: 1760000000,
        message: "原因：Connection reset by peer (os error 10054)",
      }],
      stages: ["face_detection"], next_before: null, history_through: 5, retryable: 0, failed_faces: 1, failed_classifications: 0, ignored_count: 0,
      platform: "windows", architecture: "x86_64", version: "0.1.4",
    };
    vi.mocked(api.getTaskErrors).mockResolvedValueOnce(page)
      .mockResolvedValueOnce({ ...page, failed_faces: 0, ignored_count: 1 });
    vi.mocked(api.getTaskErrorPhotos).mockResolvedValueOnce(details)
      .mockResolvedValueOnce({ ...details, photos: [{ ...photo, ignored: true, can_ignore: false }], can_ignore: 0 });
    vi.mocked(api.ignoreTaskErrorPhotos).mockResolvedValueOnce(1);
    vi.mocked(api.getIgnoredTaskPhotos)
      .mockResolvedValueOnce({ photos: [{ ...photo, stage: key.stage }], next_offset: null })
      .mockResolvedValueOnce({ photos: [], next_offset: null });
    vi.mocked(api.restoreTaskPhoto).mockResolvedValueOnce(1);
    useStore.setState({ project: { root_path: "/test" } as Project });
    render(<TaskCenter />);
    fireEvent.click(screen.getByRole("button", { name: "后台任务" }));
    const group = await screen.findByRole("button", { name: /识别人脸 · 5 条记录/ });
    expect(group).toHaveAttribute("aria-expanded", "false");
    expect(api.getTaskErrorPhotos).not.toHaveBeenCalled();
    expect(screen.getByText(/已跳过失败的照片/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试失败" })).toBeDisabled();
    fireEvent.click(group);
    expect(await screen.findByText(photo.path)).toBeInTheDocument();
    expect(screen.getByText("最近出错").querySelector("time")).toHaveAttribute("datetime", new Date(photo.occurred_at * 1000).toISOString());
    fireEvent.click(screen.getByRole("button", { name: "复制本页诊断" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Connection reset by peer")));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(photo.path));
    fireEvent.click(screen.getByRole("button", { name: "忽略 DSC001.jpg" }));
    await waitFor(() => expect(api.ignoreTaskErrorPhotos).toHaveBeenCalledWith("/test", key, 42));
    expect(await screen.findByText("已忽略", { exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "已忽略照片" }));
    fireEvent.click(await screen.findByRole("button", { name: "取消忽略 DSC001.jpg的识别人脸" }));
    await waitFor(() => expect(api.restoreTaskPhoto).toHaveBeenCalledWith("/test", "face_detection", 42));
    expect(await screen.findByText("暂无已忽略的照片")).toBeInTheDocument();
  } finally {
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("clears the confirmed history snapshot and leaves the failed tasks available", async () => {
  const emptyPage = await api.getTaskErrors(null, null);
  vi.mocked(api.getTaskErrors).mockResolvedValueOnce({ ...emptyPage, history_through: 7 });
  vi.mocked(api.clearTaskErrorHistory).mockResolvedValueOnce(7);
  useStore.setState({ project: { root_path: "/test" } as Project });
  render(<TaskCenter />);
  fireEvent.click(screen.getByRole("button", { name: "后台任务" }));
  const clear = screen.getByRole("button", { name: "清空错误历史" });
  await waitFor(() => expect(clear).toBeEnabled());
  fireEvent.click(clear);
  expect(api.clearTaskErrorHistory).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认清空" }));
  expect(await screen.findByText("已清空 7 条历史错误记录")).toBeInTheDocument();
  expect(api.clearTaskErrorHistory).toHaveBeenCalledWith("/test", 7);
  expect(screen.getByRole("button", { name: "重试失败" })).toBeEnabled();
});

it("copies worker crash details and can test a photo without opening a library", async () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.mocked(api.getAiWorkerDiagnostics).mockResolvedValueOnce({
    version: "0.1.7", platform: "windows", architecture: "x86_64",
    status: "exited", port: 9876, pid: 42, log_error: null,
    entries: [{ id: 1, occurred_at: 1794510000, source: "error", pid: 42, message: "AI 服务进程已退出（exit code: 120）\n详细堆栈" }],
  });
  vi.mocked(open).mockResolvedValueOnce("D:\\测试.jpeg");
  vi.mocked(api.checkAiPhoto).mockResolvedValueOnce({ faces: { Ok: 2 }, tags: { Err: "broken data stream" } });
  try {
    render(<TaskCenter />);
    fireEvent.click(screen.getByRole("button", { name: "后台任务" }));
    expect(await screen.findByText("进程已退出 · 127.0.0.1:9876 · PID 42")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制本页诊断" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("详细堆栈")));
    fireEvent.click(screen.getByRole("button", { name: "测试单张照片" }));
    await waitFor(() => expect(api.checkAiPhoto).toHaveBeenCalledWith("D:\\测试.jpeg"));
    expect(await screen.findByText(/人脸检测成功，找到 2 张人脸/)).toHaveTextContent("broken data stream");
  } finally {
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});
