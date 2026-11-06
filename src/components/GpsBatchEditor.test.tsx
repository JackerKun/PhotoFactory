import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Photo } from "../types";

const mockMap = vi.hoisted(() => ({
  stop: vi.fn(),
  panTo: vi.fn(),
  invalidateSize: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  latLngToContainerPoint: vi.fn(() => ({ x: 100, y: 100 })),
}));

vi.mock("react-leaflet", () => ({
  MapContainer: ({ children }: { children: React.ReactNode }) => <div data-testid="map">{children}</div>,
  Marker: () => <div data-testid="marker" />,
  useMap: () => mockMap,
  useMapEvents: () => ({}),
}));
vi.mock("./CachedTileLayer", () => ({ default: () => null }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path, invoke: vi.fn() }));
vi.mock("../api/tauri", () => ({
  getThumbnailPath: vi.fn(() => new Promise<string>(() => {})),
  searchMapLocation: vi.fn(),
}));

import { GpsBatchEditor } from "./PhotoDetail";

function photo(id: number, latitude: number | null, longitude: number | null): Photo {
  return {
    id, path: `/tmp/${id}.jpg`, filename: `${id}.jpg`, file_size: 1, file_mtime: 0,
    width: 100, height: 100, format: "jpg", taken_at: null, camera_make: null,
    camera_model: null, exposure_time: null, f_number: null, iso: null, latitude,
    longitude, orientation: 1, thumbnail_status: 1, ai_status: 0, deleted: false,
    is_favorite: false, imported_at: 0,
  };
}

describe("GpsBatchEditor", () => {
  it("opens in per-photo mode and switches to shared batch mode", () => {
    const photos = [photo(1, 31.2, 121.5), photo(2, null, null)];
    render(<GpsBatchEditor
      photos={photos}
      currentPhotoId={1}
      photoLocations={new Map([[1, { lat: 31.2, lng: 121.5 }]])}
      onApply={vi.fn()}
      onApplyIndividual={vi.fn()}
      onClose={vi.fn()}
    />);

    expect(screen.getByText("逐张定位")).toBeInTheDocument();
    expect(screen.getByText("保存全部草稿 (0)")).toBeInTheDocument();
    fireEvent.click(screen.getByText("统一位置"));
    expect(screen.getByText("已选 1 张")).toBeInTheDocument();
  });

  it("keeps the focused photo and its marker when refreshed props temporarily lose GPS metadata", () => {
    const first = photo(1, 31.2, 121.5);
    const second = photo(2, 32.260282, 117.807255);
    const props = {
      currentPhotoId: 1,
      onApply: vi.fn(),
      onApplyIndividual: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(<GpsBatchEditor
      {...props}
      photos={[first, second]}
      photoLocations={new Map([
        [1, { lat: 31.2, lng: 121.5 }],
        [2, { lat: 32.260282, lng: 117.807255 }],
      ])}
    />);

    fireEvent.click(screen.getByRole("button", { name: "切换到 2.jpg" }));
    expect(screen.getByText("本张：32.260282, 117.807255")).toBeInTheDocument();
    expect(screen.getByTestId("gps-overlay-marker")).toBeInTheDocument();

    // Thumbnail/AI refreshes can reorder photos and briefly send an empty GPS
    // map. The editor must retain both the focused id and the last known GPS.
    rerender(<GpsBatchEditor
      {...props}
      photos={[second, first]}
      photoLocations={new Map()}
    />);

    expect(screen.getByText("本张：32.260282, 117.807255")).toBeInTheDocument();
    expect(screen.getByTestId("gps-overlay-marker")).toBeInTheDocument();

    // The open editor is a frozen session. A parent refresh may briefly empty
    // the global photo list, but must not remove the card, draft, or GPS pin.
    rerender(<GpsBatchEditor
      {...props}
      photos={[]}
      photoLocations={new Map()}
    />);
    expect(screen.getByText("本张：32.260282, 117.807255")).toBeInTheDocument();
    expect(screen.getByTestId("gps-overlay-marker")).toBeInTheDocument();
  });
});
