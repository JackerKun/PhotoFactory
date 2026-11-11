import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { open, save } from "@tauri-apps/plugin-dialog";
import { exportOfflineMap, importOfflineMap, type OfflineMapPackage } from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import type { Project } from "../types";
import OfflineMapPanel from "./OfflineMapPanel";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../api/tauri", () => ({ importOfflineMap: vi.fn(), exportOfflineMap: vi.fn() }));

const pack: OfflineMapPackage = {
  id: "map.mbtiles", name: "上海周边", layer: "satellite", min_zoom: 2, max_zoom: 8,
  bounds: [120.85, 30.65, 122, 31.9], attribution: "NASA GIBS", bytes: 12345,
};
const maps = { packages: [], loading: false, error: "" };

function startImport(onView = vi.fn()) {
  useStore.setState({ project: { root_path: "/test/library" } as Project });
  vi.mocked(open).mockResolvedValue("E:\\地图\\上海.mbtiles");
  render(<OfflineMapPanel maps={maps} layer="standard" onView={onView} />);
  fireEvent.click(screen.getByRole("button", { name: "离线地图", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "导入离线地图包" }));
  return onView;
}

afterEach(() => {
  cleanup();
  useStore.setState({ project: null });
  vi.clearAllMocks();
});

describe("OfflineMapPanel", () => {
  it("imports without focusing the region", async () => {
    vi.mocked(importOfflineMap).mockResolvedValue([pack]);
    const onView = startImport();
    expect(await screen.findByRole("status")).toHaveTextContent("已导入「上海周边」");
    expect(onView).not.toHaveBeenCalled();
    expect(importOfflineMap).toHaveBeenCalledWith(["E:\\地图\\上海.mbtiles"]);
    expect(screen.getByText("优先使用离线地图")).toBeInTheDocument();
  });

  it("imports both layers at once and keeps the currently selected layer", async () => {
    const standardPack = { ...pack, id: "standard", layer: "standard" as const };
    vi.mocked(importOfflineMap).mockResolvedValue([pack, standardPack]);
    const onView = startImport();
    expect(await screen.findByRole("status")).toHaveTextContent("已导入标准地图和卫星实景地图");
    expect(onView).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ multiple: true }));
  });

  it("shows validation errors without changing the map", async () => {
    vi.mocked(importOfflineMap).mockRejectedValue("地图包数据库损坏");
    const onView = startImport();
    expect(await screen.findByRole("alert")).toHaveTextContent("地图包数据库损坏");
    expect(onView).not.toHaveBeenCalled();
  });

  it("exports both layers as a single bundle to the chosen location", async () => {
    useStore.setState({ project: { root_path: "/test/library" } as Project });
    vi.mocked(save).mockResolvedValue("/test/双图层.pfmap");
    vi.mocked(exportOfflineMap).mockResolvedValue({ tile_count: 42, bytes: 3000 });
    render(<OfflineMapPanel maps={maps} layer="standard" onView={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "导出离线地图" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "离线地图" }));
    fireEvent.change(screen.getByRole("combobox", { name: "导出图层" }), { target: { value: "both" } });
    fireEvent.click(screen.getByRole("button", { name: "导出离线地图" }));
    expect(await screen.findByRole("status")).toHaveTextContent("已导出 42 张瓦片");
    expect(exportOfflineMap).toHaveBeenCalledWith("/test/双图层.pfmap", "both");
  });
});
