import type { TrackPhoto } from "../api/tauri";

export type TrackPoint = {
  photos: TrackPhoto[];
  latitude: number;
  longitude: number;
};

export type TrackDay = {
  date: string;
  points: TrackPoint[];
};

export function localDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const twoDigits = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
}

export function dateRange(start: string, end: string) {
  const startAt = start ? new Date(`${start}T00:00:00`).getTime() / 1000 : null;
  const lastDay = end ? new Date(`${end}T00:00:00`) : null;
  if (lastDay) lastDay.setDate(lastDay.getDate() + 1);
  const endBefore = lastDay ? lastDay.getTime() / 1000 : null;
  if ((startAt !== null && !Number.isFinite(startAt)) ||
      (endBefore !== null && !Number.isFinite(endBefore)) ||
      (startAt !== null && endBefore !== null && startAt >= endBefore)) {
    throw new Error("请选择有效的日期范围。");
  }
  return { startAt, endBefore };
}

function distance(a: TrackPoint, b: Pick<TrackPhoto, "latitude" | "longitude">) {
  const radians = Math.PI / 180;
  const sinLat = Math.sin((b.latitude - a.latitude) * radians / 2);
  const sinLon = Math.sin((b.longitude - a.longitude) * radians / 2);
  const haversine = sinLat ** 2 + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * sinLon ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

export function buildTrackDays(photos: TrackPhoto[]): TrackDay[] {
  const days: TrackDay[] = [];
  const ordered = [...photos].sort((a, b) => a.taken_at - b.taken_at || a.id - b.id);
  for (const photo of ordered) {
    if (!Number.isFinite(new Date(photo.taken_at * 1000).getTime())) continue;
    const date = localDate(photo.taken_at);
    let day = days[days.length - 1];
    if (day?.date !== date) {
      day = { date, points: [] };
      days.push(day);
    }
    const point = day.points[day.points.length - 1];
    if (point && photo.taken_at - point.photos[0].taken_at <= 300 && distance(point, photo) <= 30) {
      point.photos.push(photo);
    } else {
      day.points.push({ photos: [photo], latitude: photo.latitude, longitude: photo.longitude });
    }
  }
  return days;
}

export function trackGap(previous: TrackPoint, current: TrackPoint) {
  const last = previous.photos[previous.photos.length - 1];
  const first = current.photos[0];
  const seconds = first.taken_at - last.taken_at;
  const meters = distance(previous, current);
  const reason = seconds >= 90 * 60 ? "拍摄间隔超过或达到 90 分钟"
    : meters >= 500 && (seconds <= 0 || meters / seconds * 3.6 > 100) ? "位置跳变较大"
    : null;
  return { id: `${last.id}:${first.id}`, reason };
}
