import { describe, expect, it } from "vitest";
import { photoFilterFromSearchParams, photoRouteForTag, photoSearchParamsFromFilter } from "./photoRoutes";

describe("photoRouteForTag", () => {
  it("round-trips multilingual tag names without double encoding", () => {
    const label = "中国·玛沁县 རྨ་ཆེན། 天空";
    const route = photoRouteForTag(label);
    expect(route.pathname).toBe("/");
    expect(new URLSearchParams(route.search).get("tag")).toBe(label);
    expect(route.search).not.toContain("%25E5");
  });

  it("keeps a Chinese tag stable across URL and store synchronization", () => {
    const label = "人物·家人（精选）";
    const initial = new URLSearchParams(photoRouteForTag(label).search);
    const filter = photoFilterFromSearchParams(initial);
    const encoded = photoSearchParamsFromFilter(filter);

    expect(filter.tag).toBe(label);
    expect(encoded.get("tag")).toBe(label);
    expect(photoFilterFromSearchParams(encoded)).toEqual(filter);
  });
});

  it("preserves the no-GPS filter through URL serialization", () => {
    const params = photoSearchParamsFromFilter({ has_gps: false });
    expect(photoFilterFromSearchParams(params).has_gps).toBe(false);
  });
