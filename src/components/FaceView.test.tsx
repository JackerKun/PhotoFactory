import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import FaceView from "./FaceView";

it("shows first-batch progress before any person has been saved", () => {
  const initial = useStore.getState();
  try {
    useStore.setState({
      aiProcessingStatus: { status: "running", stage: "recovering_faces", processed: 0, total: 1120 },
      faceClusteringProgress: { project_path: "/sample", batch: 1, phase: { stage: "read_embeddings", done: 320, total: 1000, skipped: 0 }, updatedAt: Date.now() - 16000 },
    });
    render(<MemoryRouter><FaceView /></MemoryRouter>);
    expect(screen.getByText("读取人脸特征")).toBeInTheDocument();
    expect(screen.getByText("320 / 1,000")).toBeInTheDocument();
    expect(screen.getByText(/秒没有新进度/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "人脸分组总进度" })).toHaveAttribute("value", "0");
    act(() => useStore.setState({ aiProcessingStatus: { status: "done", stage: "clustering_done", processed: 1120, total: 1120 } }));
    expect(screen.queryByText("读取人脸特征")).not.toBeInTheDocument();
  } finally {
    act(() => useStore.setState({ aiProcessingStatus: initial.aiProcessingStatus, faceClusteringProgress: initial.faceClusteringProgress }));
  }
});

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("./GroupPhotosView", () => ({ default: () => null }));
vi.mock("../api/tauri", () => ({
  getClusterPage: vi.fn(async () => ({ items: [], total: 0, named_count: 2, unnamed_count: 96, review_count: 0 })),
  getFaceDetectionCount: vi.fn(async () => 100),
  getUnassignedFaceCount: vi.fn(async () => 0),
  getSuspectedFaceCount: vi.fn(async () => 0),
  getIgnoredFaceCount: vi.fn(async () => 0),
  hasAutomaticFaceMergeToUndo: vi.fn(async () => false),
  getFaceAiVersionStatus: vi.fn(async () => ({ upgrade_available: false })),
  workerHealth: vi.fn(async () => true),
  previewAutoMergeUnnamedFaces: vi.fn(),
  rejectAutoMergeCandidate: vi.fn(async () => undefined),
  getPersonAvatarChoices: vi.fn(),
  savePersonProfile: vi.fn(async () => undefined),
  ignoreFaceClusters: vi.fn(async () => "已取消识别。"),
  confirmFaceClusters: vi.fn(async (ids: number[]) => ids.length),
  rebuildFaceClusters: vi.fn(async () => "已整理。"),
  prepareFaceAiReanalysis: vi.fn(async () => "已准备。"),
  triggerAutoAi: vi.fn(async () => "已启动。"),
}));

it("loads more avatar choices and saves the selected face for a named person", async () => {
  const person = { id: 1, name: "小张", face_count: 40, photo_count: 40, confidence: "high" as const, created_at: 0 };
  vi.mocked(api.getClusterPage).mockResolvedValueOnce({ items: [person], total: 1, named_count: 1, unnamed_count: 0, review_count: 0 });
  vi.mocked(api.getPersonAvatarChoices)
    .mockResolvedValueOnce({ items: [{ face_id: 10, filename: "原头像.jpg" }], selected_face_id: 10, next_after: 10 })
    .mockResolvedValueOnce({ items: [{ face_id: 12, filename: "新头像.jpg" }], selected_face_id: 10, next_after: null });
  render(<MemoryRouter><FaceView /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: "小张操作" }));
  fireEvent.click(screen.getByRole("button", { name: "编辑人物" }));
  const dialog = within(screen.getByRole("dialog", { name: "编辑人物" }));
  expect(await dialog.findByRole("button", { name: /原头像.jpg/, pressed: true })).toBeInTheDocument();
  fireEvent.click(dialog.getByRole("button", { name: "加载更多头像" }));
  fireEvent.click(await dialog.findByRole("button", { name: /新头像.jpg/ }));
  expect(dialog.getByRole("button", { name: /新头像.jpg/, pressed: true })).toBeInTheDocument();
  fireEvent.click(dialog.getByRole("button", { name: "保存" }));
  expect(await screen.findByText("已更新人物头像。")).toBeInTheDocument();
  expect(api.savePersonProfile).toHaveBeenCalledWith(1, "小张", 12);
});

it("reveals review actions after a selection and confirms a Shift range from the bottom bar", async () => {
  const items = [1, 2, 3, 4].map((id) => ({
    id, face_count: 1, photo_count: 1, confidence: "low" as const, created_at: 0,
  }));
  vi.mocked(api.getClusterPage).mockResolvedValueOnce({ items, total: 4, named_count: 0, unnamed_count: 4, review_count: 4 });
  render(<MemoryRouter initialEntries={["/faces?tab=review"]}><FaceView /></MemoryRouter>);
  await screen.findByRole("button", { name: "打开人物 1" });
  const dock = { name: "人物选区操作" };
  expect(screen.queryByRole("group", dock)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "选择", exact: true }));
  expect(screen.queryByRole("group", dock)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "选择人物 1" }));
  fireEvent.click(screen.getByRole("button", { name: "选择人物 3" }), { shiftKey: true });
  const selection = within(screen.getByRole("group", dock));
  expect(selection.getByRole("status")).toHaveTextContent("已选 3 人");
  fireEvent.click(selection.getByRole("button", { name: "批量确认" }));
  expect(await screen.findByText(/已确认 3 个独立人物/)).toBeInTheDocument();
  expect(api.confirmFaceClusters).toHaveBeenCalledWith([1, 2, 3]);
});

it("asks for explicit confirmation for both advanced maintenance actions", async () => {
  vi.mocked(api.getFaceAiVersionStatus).mockResolvedValueOnce({ upgrade_available: true } as Awaited<ReturnType<typeof api.getFaceAiVersionStatus>>);
  render(<MemoryRouter><FaceView /></MemoryRouter>);
  const menu = screen.getByLabelText("人物操作").closest("details")!;
  menu.open = true;
  fireEvent.click(await screen.findByRole("button", { name: /重建自动分组/ }));
  const rebuild = within(screen.getByRole("alertdialog", { name: "确认重建自动分组？" }));
  expect(rebuild.getByRole("button", { name: "取消" })).toHaveFocus();
  expect(api.rebuildFaceClusters).not.toHaveBeenCalled();
  fireEvent.click(rebuild.getByRole("button", { name: "取消" }));
  expect(api.rebuildFaceClusters).not.toHaveBeenCalled();
  menu.open = true;
  fireEvent.click(await screen.findByRole("button", { name: /重新分析人脸/ }));
  const reanalyze = within(screen.getByRole("alertdialog", { name: "确认重新分析人脸？" }));
  expect(reanalyze.getByText(/撤销记录会被清除/)).toBeInTheDocument();
  expect(api.prepareFaceAiReanalysis).not.toHaveBeenCalled();
  fireEvent.click(reanalyze.getByRole("button", { name: "确认重新分析" }));
  expect(await screen.findByText(/已在后台开始重新分析/)).toBeInTheDocument();
  expect(api.prepareFaceAiReanalysis).toHaveBeenCalledTimes(1);
});

it("orders and expands candidates, keeps selections across pages, and clamps after rejection", async () => {
  const unnamed = Array.from({ length: 47 }, (_, index) => ({
    cluster_ids: [101 + index * 2, 102 + index * 2], face_count: index + 10, similarity: 0.8,
  }));
  vi.mocked(api.previewAutoMergeUnnamedFaces).mockResolvedValue({
    skipped: 0,
    candidates: [...unnamed,
      { cluster_ids: [1, 2], named_target_id: 1, named_target_name: "甲", face_count: 3, similarity: 0.85 },
      { cluster_ids: [3, 4], named_target_id: 3, named_target_name: "乙", face_count: 8, similarity: 0.75 },
    ],
  });
  render(<MemoryRouter initialEntries={["/faces?tab=unnamed"]}><FaceView /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "查找相似" }));
  const dialog = within(screen.getByRole("dialog", { name: "自动合并相似人物" }));
  fireEvent.click(dialog.getByRole("button", { name: "查找合并候选" }));

  const expanded = await dialog.findAllByLabelText(/收起候选组/);
  expect(expanded).toHaveLength(24);
  expect(expanded.every((group) => group.getAttribute("aria-expanded") === "true")).toBe(true);
  const displayedCounts = dialog.getAllByText(/^\d+ 张人脸$/).map((element) => element.textContent);
  expect(displayedCounts.slice(0, 4)).toEqual(["8 张人脸", "3 张人脸", "56 张人脸", "55 张人脸"]);
  fireEvent.click(expanded[0]);
  fireEvent.click(dialog.getByLabelText("整组选中候选组 1"));
  fireEvent.click(dialog.getByText("下一页"));
  expect(dialog.getByText("第 2 / 3 页")).toBeInTheDocument();
  expect(dialog.queryByLabelText("整组选中候选组 1")).not.toBeInTheDocument();
  fireEvent.click(dialog.getByText("全选本页"));
  expect(dialog.getByText("确认合并 25 组")).toBeEnabled();
  fireEvent.click(dialog.getByText("取消本页选择"));
  expect(dialog.getByText("确认合并 1 组")).toBeEnabled();
  fireEvent.click(dialog.getByText("上一页"));
  expect(dialog.getByLabelText("展开候选组 1")).toHaveAttribute("aria-expanded", "false");
  expect(dialog.getByLabelText("整组选中候选组 1")).toBeChecked();

  fireEvent.change(dialog.getByLabelText("跳转到页码"), { target: { value: "3" } });
  fireEvent.click(dialog.getByText("跳转"));
  expect(dialog.getByText("第 3 / 3 页")).toBeInTheDocument();
  expect(dialog.getByLabelText("收起候选组 49")).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(dialog.getByRole("button", { name: "不是同一人" }));
  expect(await dialog.findByText("第 2 / 2 页")).toBeInTheDocument();
  expect(api.rejectAutoMergeCandidate).toHaveBeenCalledWith([101, 102]);
}, 15000);
