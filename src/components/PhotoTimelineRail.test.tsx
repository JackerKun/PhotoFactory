import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/tauri", () => ({ getPhotoTimeline: vi.fn() }));

import * as api from "../api/tauri";
import { useStore } from "../hooks/usePhotos";
import PhotoTimelineRail from "./PhotoTimelineRail";

describe("PhotoTimelineRail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    act(() => useStore.getState().reset());
    vi.mocked(api.getPhotoTimeline).mockResolvedValue([
      { year: 2026, month: 8, count: 12 },
      { year: 2025, month: 12, count: 3 },
    ]);
  });

  it("tracks the current filtered result but navigates without changing filters", async () => {
    act(() => useStore.setState({ filter: { keyword: "峡谷", rating_min: 3 } }));
    const onJump = vi.fn();
    render(<PhotoTimelineRail active={{ year: 2026, month: 8 }} onJump={onJump} />);

    const august = await screen.findByRole("button", { name: "2026年8月，12张" });
    await waitFor(() => expect(api.getPhotoTimeline).toHaveBeenCalledWith({ keyword: "峡谷", rating_min: 3 }));
    expect(august).toHaveAttribute("aria-current", "true");

    fireEvent.click(august);
    expect(onJump).toHaveBeenCalledWith({ year: 2026, month: 8 });
    expect(useStore.getState().filter).toEqual({ keyword: "峡谷", rating_min: 3 });
  });

  it("uses an album's supplied timeline without querying the global photo filter", async () => {
    const onJump = vi.fn();
    render(<PhotoTimelineRail
      buckets={[{ year: 2024, month: 3, count: 8 }]}
      ascending
      active={{ year: 2024, month: 3 }}
      onJump={onJump}
    />);

    const march = await screen.findByRole("button", { name: "2024年3月，8张" });
    expect(api.getPhotoTimeline).not.toHaveBeenCalled();
    fireEvent.click(march);
    expect(onJump).toHaveBeenCalledWith({ year: 2024, month: 3 });
  });
});
