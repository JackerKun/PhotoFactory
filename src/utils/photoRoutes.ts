import type { PhotoFilter } from "../types";

/** Build a router location without pre-encoding values. URLSearchParams owns
 * encoding exactly once, including Chinese, Tibetan and punctuation. */
export function photoRouteForTag(label: string) {
  const params = new URLSearchParams();
  params.set("tag", label);
  return { pathname: "/", search: `?${params.toString()}` };
}

const FILTER_KEYS = new Set([
  "dir", "tag", "person", "gps", "fav", "year", "month", "q", "format", "camera",
  "isoMin", "isoMax", "apertureMin", "apertureMax", "shutter", "orientation",
  "ratingMin", "ratingMax", "sort", "order",
]);

/** Decode the complete photo filter from the router search string. */
export function photoFilterFromSearchParams(params: URLSearchParams): PhotoFilter {
  return {
    directory: params.get("dir") || undefined,
    tag: params.get("tag") || undefined,
    person_id: params.get("person") ? Number(params.get("person")) : undefined,
    has_gps: params.get("gps") === "true" ? true : undefined,
    has_favorite: params.get("fav") === "true" ? true : params.get("fav") === "false" ? false : undefined,
    year: params.get("year") ? Number(params.get("year")) : undefined,
    month: params.get("month") ? Number(params.get("month")) : undefined,
    keyword: params.get("q") || undefined,
    format: params.get("format") || undefined,
    camera: params.get("camera") || undefined,
    iso_min: params.get("isoMin") ? Number(params.get("isoMin")) : undefined,
    iso_max: params.get("isoMax") ? Number(params.get("isoMax")) : undefined,
    aperture_min: params.get("apertureMin") ? Number(params.get("apertureMin")) : undefined,
    aperture_max: params.get("apertureMax") ? Number(params.get("apertureMax")) : undefined,
    exposure_time: params.get("shutter") || undefined,
    orientation_kind: (params.get("orientation") as PhotoFilter["orientation_kind"]) || undefined,
    rating_min: params.get("ratingMin") ? Number(params.get("ratingMin")) : undefined,
    rating_max: params.get("ratingMax") ? Number(params.get("ratingMax")) : undefined,
    sort_by: (params.get("sort") as PhotoFilter["sort_by"]) || undefined,
    sort_direction: (params.get("order") as PhotoFilter["sort_direction"]) || undefined,
  };
}

/** Encode the store filter while retaining unrelated navigation state. */
export function photoSearchParamsFromFilter(filter: PhotoFilter, current?: URLSearchParams) {
  const params = new URLSearchParams();
  if (filter.directory) params.set("dir", filter.directory);
  if (filter.tag) params.set("tag", filter.tag);
  if (filter.person_id != null) params.set("person", String(filter.person_id));
  if (filter.has_gps != null) params.set("gps", String(filter.has_gps));
  if (filter.has_favorite != null) params.set("fav", String(filter.has_favorite));
  if (filter.year) params.set("year", String(filter.year));
  if (filter.month) params.set("month", String(filter.month));
  if (filter.keyword) params.set("q", filter.keyword);
  if (filter.format) params.set("format", filter.format);
  if (filter.camera) params.set("camera", filter.camera);
  if (filter.iso_min != null) params.set("isoMin", String(filter.iso_min));
  if (filter.iso_max != null) params.set("isoMax", String(filter.iso_max));
  if (filter.aperture_min != null) params.set("apertureMin", String(filter.aperture_min));
  if (filter.aperture_max != null) params.set("apertureMax", String(filter.aperture_max));
  if (filter.exposure_time) params.set("shutter", filter.exposure_time);
  if (filter.orientation_kind) params.set("orientation", filter.orientation_kind);
  if (filter.rating_min != null) params.set("ratingMin", String(filter.rating_min));
  if (filter.rating_max != null) params.set("ratingMax", String(filter.rating_max));
  if (filter.sort_by) params.set("sort", filter.sort_by);
  if (filter.sort_direction) params.set("order", filter.sort_direction);
  current?.forEach((value, key) => {
    if (!FILTER_KEYS.has(key)) params.set(key, value);
  });
  return params;
}
