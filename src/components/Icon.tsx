import type { CSSProperties } from "react";

export const iconPaths = {
  nature: "M20 3C10 3 3 6 3 13a7 7 0 0 0 14 0c0-3 1-7 3-10z M5 19l8-9",
  weather: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5L19 19 M5 19l1.5-1.5 M17.5 6.5L19 5",
  building: "M4 21V5h10v16 M14 10h6v11 M7 9h4 M7 13h4 M7 17h4 M2 21h20",
  location: "M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0 M12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  time: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2",
  event: "M4 5h16v16H4z M4 10h16 M8 3v4 M16 3v4 M8 14h2 M14 14h2 M8 17h2",
  colors: "M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 0-4 2 2 0 0 1 0-4h3a4 4 0 0 0 4-4c0-3-4-6-9-6 M7 9h.01 M11 6h.01 M16 7h.01 M6 14h.01",
  photos: "M4 5h16v14H4z M7 14l3-3 4 4 3-3 3 3 M9 8h.01",
  map: "M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z M9 3v15 M15 6v15",
  route: "M6 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M18 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M8 5h8a4 4 0 0 1 0 8H8a3 3 0 0 0 0 6h8",
  people: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75",
  tags: "M20 13l-7 7L3 10V3h7z M7 7h.01",
  albums: "M5 4h14v17H5z M8 1h8 M8 8h8 M8 12h8",
  tools: "M14 6a5 5 0 0 0-6 6L2 18l4 4 6-6a5 5 0 0 0 6-6l-4 3-3-3z",
  activity: "M2 12h4l3-8 6 16 3-8h4",
  theme: "M12 3a9 9 0 1 0 0 18V3z M12 3a9 9 0 0 1 0 18",
  retry: "M3 10a9 9 0 1 1 2 8 M3 3v7h7",
  chevronUp: "M6 15l6-6 6 6",
  folder: "M3 7V4h6l2 3h10v13H3z",
  satellite: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M3 12h18 M12 3c5 5 5 13 0 18-5-5-5-13 0-18",
  download: "M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5",
} as const;
export type IconName = keyof typeof iconPaths;

export default function Icon({ name, size = 18, className = "", style }: {
  name: IconName; size?: number; className?: string; style?: CSSProperties;
}) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${className}`} style={style}><path d={iconPaths[name]} /></svg>;
}
