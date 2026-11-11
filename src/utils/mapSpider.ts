import L from "leaflet";

export const PHOTO_THUMBNAIL_SIZE = 52;
export const FIRST_PHOTO_RING_RADIUS = 80;

export function buildSpiderOffsets(count: number): Array<[number, number]> {
  if (count <= 0) return [];

  const offsets: Array<[number, number]> = [];
  let remaining = count;
  let ring = 0;
  while (remaining > 0) {
    const capacity = ring === 0 ? 8 : 12;
    const items = Math.min(remaining, capacity);
    const radius = ring === 0 ? FIRST_PHOTO_RING_RADIUS : 132 + (ring - 1) * 62;
    const phase = ring % 2 === 0 ? -Math.PI / 2 : -Math.PI / 2 + Math.PI / items;
    for (let index = 0; index < items; index += 1) {
      const angle = phase + (index * Math.PI * 2) / items;
      offsets.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
    }
    remaining -= items;
    ring += 1;
  }
  return offsets;
}

export function photoThumbnailIcon(url: string | null, selected = false): L.DivIcon {
  const frame = document.createElement("div");
  frame.className = "flex h-full w-full items-center justify-center overflow-hidden rounded-xl border-2 bg-white p-0.5 shadow-lg";
  frame.style.borderColor = selected ? "#2563eb" : "white";
  if (url) {
    const image = document.createElement("img");
    image.src = url;
    image.alt = "";
    image.draggable = false;
    image.className = "block h-full w-full min-w-0 rounded-lg object-cover";
    frame.append(image);
  } else {
    frame.classList.add("bg-gray-100", "text-gray-500");
    frame.textContent = "…";
  }
  return L.divIcon({
    className: "",
    html: frame,
    iconSize: [PHOTO_THUMBNAIL_SIZE, PHOTO_THUMBNAIL_SIZE],
    iconAnchor: [PHOTO_THUMBNAIL_SIZE / 2, PHOTO_THUMBNAIL_SIZE / 2],
    popupAnchor: [0, -PHOTO_THUMBNAIL_SIZE / 2],
  });
}
