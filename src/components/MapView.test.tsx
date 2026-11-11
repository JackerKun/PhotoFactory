import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Map as LeafletMap } from "leaflet";
import { listOfflineMaps, type OfflineMapPackage } from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import { useOfflineMapStore } from "../hooks/useOfflineMaps";
import type { Project } from "../types";
import MapView from "./MapView";

const viewport = vi.hoisted(() => ({ current: null as LeafletMap | null }));

vi.mock("./CachedTileLayer", async () => {
  const { useMap } = await import("react-leaflet");
  return { default: function CaptureMap() {
    viewport.current = useMap();
    return null;
  } };
});
vi.mock("../api/tauri", () => ({
  getPhotosWithGps: vi.fn().mockResolvedValue([]),
  listOfflineMaps: vi.fn(),
}));

afterEach(() => {
  cleanup();
  localStorage.removeItem("photofactory.mapViewport");
  useStore.setState({ project: null, mapFocusRequest: null });
  viewport.current = null;
});

it("opens at world zoom the first time and restores the last viewport on return", async () => {
  const pack: OfflineMapPackage = {
    id: "city.mbtiles", name: "城市地图", layer: "standard", min_zoom: 12, max_zoom: 16,
    bounds: [113.8, 35.2, 113.9, 35.3], attribution: null, bytes: 1000,
  };
  useStore.setState({ project: { root_path: "/test/library" } as Project });
  useOfflineMapStore.setState({ layer: "standard" });
  vi.mocked(listOfflineMaps).mockResolvedValue([pack]);

  const view = render(<MapView onSelectPhoto={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "离线地图", exact: true }));
  const packageButton = await screen.findByRole("button", { name: /城市地图/ });
  expect(viewport.current?.getZoom()).toBe(2);
  expect(viewport.current?.getCenter()).toMatchObject({ lat: 20, lng: 0 });

  fireEvent.click(packageButton);
  expect(viewport.current?.getZoom()).toBeGreaterThanOrEqual(12);
  act(() => { viewport.current?.setView([35.25, 113.85], 14, { animate: false }); });
  const saved = JSON.parse(localStorage.getItem("photofactory.mapViewport")!);
  expect(saved.zoom).toBe(14);
  expect(saved.center[0]).toBeCloseTo(35.25);
  expect(saved.center[1]).toBeCloseTo(113.85);
  view.unmount();

  render(<MapView onSelectPhoto={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "离线地图", exact: true }));
  await screen.findByRole("button", { name: /城市地图/ });
  expect(viewport.current?.getZoom()).toBe(14);
  expect(viewport.current?.getCenter().lat).toBeCloseTo(35.25);
  expect(viewport.current?.getCenter().lng).toBeCloseTo(113.85);
});
