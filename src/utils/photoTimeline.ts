import type { Photo } from "../types";

export interface TimelinePosition {
  year: number;
  month?: number;
}

export interface TimelineJump extends TimelinePosition {
  requestId: number;
}

export function photoTimelinePosition(photo: Photo | null | undefined): TimelinePosition | null {
  if (!photo) return null;
  const timestamp = photo.taken_at ?? photo.file_mtime;
  if (!timestamp || timestamp <= 0) return null;
  const date = new Date(timestamp * 1000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

export function matchesTimeline(photo: Photo, target: TimelinePosition): boolean {
  const position = photoTimelinePosition(photo);
  return position?.year === target.year && (target.month == null || position.month === target.month);
}
