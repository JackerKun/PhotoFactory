import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/tauri";

vi.mock("../api/tauri", () => ({ searchMapLocation: vi.fn() }));

import MapSearch from "./MapSearch";

describe("MapSearch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows full address candidates and only locates after a candidate is chosen", async () => {
    vi.mocked(api.searchMapLocation).mockResolvedValue([
      { lat: 37.6412, lng: 110.7813, display_name: "碛口古镇，碛口镇，临县，吕梁市，山西省，中国" },
      { lat: 37.6351, lng: 110.7891, display_name: "碛口镇，临县，吕梁市，山西省，中国" },
    ]);
    const onSelect = vi.fn();
    render(<MapSearch onSelect={onSelect} />);

    fireEvent.change(screen.getByLabelText("搜索地图地址"), { target: { value: "碛口古镇" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));

    expect(await screen.findByText("碛口古镇，碛口镇，临县，吕梁市，山西省，中国")).toBeInTheDocument();
    expect(screen.getByText("碛口镇，临县，吕梁市，山西省，中国")).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("碛口古镇，碛口镇，临县，吕梁市，山西省，中国"));
    expect(onSelect).toHaveBeenCalledWith({
      lat: 37.6412,
      lng: 110.7813,
      display_name: "碛口古镇，碛口镇，临县，吕梁市，山西省，中国",
    });
    expect(screen.getByLabelText("搜索地图地址")).toHaveValue("碛口古镇，碛口镇，临县，吕梁市，山西省，中国");
  });
});
