import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useStore } from "../hooks/usePhotos";
import ActiveFilters from "./ActiveFilters";

afterEach(() => { cleanup(); useStore.setState({ filter: {} }); });
it("removes a whole range and clears filters while preserving sorting", () => {
  useStore.setState({ filter: { rating_min: 3, rating_max: 5, has_gps: false, format: "heic", sort_by: "name", sort_direction: "asc" } });
  render(<ActiveFilters />);
  expect(screen.getByText("无定位")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "移除星级 3–5" }));
  expect(useStore.getState().filter.rating_min).toBeUndefined();
  expect(useStore.getState().filter.rating_max).toBeUndefined();
  expect(useStore.getState().filter.format).toBe("heic");
  fireEvent.click(screen.getByText("清除全部筛选"));
  expect(useStore.getState().filter.has_gps).toBeUndefined();
  expect(useStore.getState().filter.sort_by).toBe("name");
});
