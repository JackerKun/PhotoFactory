import { describe, expect, it } from "vitest";
import type { Photo } from "../types";
import { buildJustifiedRows } from "./ProportionalVirtualGrid";

function photo(id: number, width: number, height: number, orientation = 1): Photo {
  return {
    id,
    path: `/photos/${id}.jpg`,
    filename: `${id}.jpg`,
    file_size: 100,
    file_mtime: id,
    width,
    height,
    format: "jpg",
    taken_at: id,
    camera_make: null,
    camera_model: null,
    exposure_time: null,
    f_number: null,
    iso: null,
    latitude: null,
    longitude: null,
    orientation,
    thumbnail_status: 1,
    ai_status: 0,
    deleted: false,
    is_favorite: false,
    imported_at: id,
  };
}

describe("buildJustifiedRows", () => {
  it("fills completed rows without distorting image ratios", () => {
    const rows = buildJustifiedRows(
      [photo(1, 4, 3), photo(2, 3, 2), photo(3, 16, 9), photo(4, 1, 1)],
      900,
      200,
    );
    const first = rows[0];
    const occupied = first.items.reduce((sum, item) => sum + item.width, 0) + (first.items.length - 1) * 4;
    expect(occupied).toBeCloseTo(900, 5);
    expect(first.items[0].width / first.height).toBeCloseTo(4 / 3, 5);
  });

  it("does not enlarge the unfinished final row", () => {
    const rows = buildJustifiedRows([photo(1, 4, 3)], 1200, 180);
    expect(rows).toHaveLength(1);
    expect(rows[0].height).toBe(180);
  });

  it("accounts for EXIF rotation when laying out portrait images", () => {
    const normal = buildJustifiedRows([photo(1, 1200, 800)], 1200, 200)[0];
    const rotated = buildJustifiedRows([photo(1, 1200, 800, 6)], 1200, 200)[0];
    expect(normal.items[0].width).toBeGreaterThan(rotated.items[0].width);
  });
});
