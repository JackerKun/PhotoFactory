import { convertFileSrc } from "@tauri-apps/api/core";

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatDate(timestamp: number | null): string {
  if (!timestamp) return "未知";
  return new Date(timestamp * 1000).toLocaleDateString("zh-CN", {
    year: "numeric", month: "long", day: "numeric",
  });
}

export function formatDateTime(timestamp: number | null): string {
  if (!timestamp) return "未知";
  return new Date(timestamp * 1000).toLocaleString("zh-CN", {
    year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

export function fileUrl(path: string): string {
  return convertFileSrc(path);
}

export function getThumbnailUrl(thumbPath: string): string {
  return `asset://${encodeURIComponent(thumbPath)}`;
}
