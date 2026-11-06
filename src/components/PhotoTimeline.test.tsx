import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/tauri", () => ({
  getPhotoTimeline: vi.fn(),
  getThumbnailPath: vi.fn(() => Promise.resolve("/tmp/thumb.webp")),
}));

import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import PhotoTimeline from "./PhotoTimeline";

describe("PhotoTimeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    act(() => useStore.getState().reset());
    vi.mocked(api.getPhotoTimeline).mockResolvedValue([
      { year: 2026, month: 8, count: 12 },
      { year: 2026, month: 7, count: 4 },
      { year: 2025, month: 12, count: 3 },
    ]);
  });

  it("searches the available months and applies the selected time filter", async () => {
    render(<PhotoTimeline />);

    fireEvent.click(screen.getByRole("button", { name: "时间轴" }));
    expect(await screen.findByText("2026年")).toBeInTheDocument();
    expect(api.getPhotoTimeline).toHaveBeenCalledWith({ year: undefined, month: undefined });

    fireEvent.change(screen.getByPlaceholderText("搜索年份或月份，如 2026-08"), {
      target: { value: "2026-08" },
    });

    expect(screen.getByRole("button", { name: /8月\s*12 张/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /7月\s*4 张/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /8月\s*12 张/ }));
    await waitFor(() => {
      expect(useStore.getState().filter.year).toBe(2026);
      expect(useStore.getState().filter.month).toBe(8);
    });
    expect(screen.getByRole("button", { name: "2026年8月" })).toBeInTheDocument();
  });

  it("clears an active time selection without clearing a folder", () => {
    act(() => {
      useStore.setState({ filter: { directory: "/photos/trip", year: 2026, month: 8 } });
    });
    render(<PhotoTimeline />);

    fireEvent.click(screen.getByRole("button", { name: "清除时间筛选" }));

    expect(useStore.getState().filter).toEqual({
      directory: "/photos/trip",
      year: undefined,
      month: undefined,
    });
  });
});
