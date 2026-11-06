import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MapLayerToggle from "./MapLayerToggle";

describe("MapLayerToggle", () => {
  it("switches between the standard and satellite layers", () => {
    const onChange = vi.fn();
    const { rerender } = render(<MapLayerToggle value="standard" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "卫星实景地图" }));
    expect(onChange).toHaveBeenCalledWith("satellite");

    rerender(<MapLayerToggle value="satellite" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "标准地图" }));
    expect(onChange).toHaveBeenLastCalledWith("standard");
  });
});
