import type { FaceDetection } from "../types";

export interface DisplayFaceBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Convert a detector box in raw JPEG pixel space into the browser's
 * EXIF-oriented display space. Values are returned as percentages. */
export function faceBoxForDisplay(
  face: FaceDetection,
  rawWidth: number,
  rawHeight: number,
  orientation: number,
): DisplayFaceBox | null {
  if (rawWidth <= 0 || rawHeight <= 0) return null;
  const x = face.bbox_x;
  const y = face.bbox_y;
  const w = face.bbox_w;
  const h = face.bbox_h;
  let tx = x;
  let ty = y;
  let tw = w;
  let th = h;
  let displayWidth = rawWidth;
  let displayHeight = rawHeight;

  switch (orientation) {
    case 2: tx = rawWidth - x - w; break;
    case 3: tx = rawWidth - x - w; ty = rawHeight - y - h; break;
    case 4: ty = rawHeight - y - h; break;
    case 5:
      tx = y; ty = x; tw = h; th = w;
      displayWidth = rawHeight; displayHeight = rawWidth;
      break;
    case 6:
      tx = rawHeight - y - h; ty = x; tw = h; th = w;
      displayWidth = rawHeight; displayHeight = rawWidth;
      break;
    case 7:
      tx = rawHeight - y - h; ty = rawWidth - x - w; tw = h; th = w;
      displayWidth = rawHeight; displayHeight = rawWidth;
      break;
    case 8:
      tx = y; ty = rawWidth - x - w; tw = h; th = w;
      displayWidth = rawHeight; displayHeight = rawWidth;
      break;
  }

  return {
    left: (tx / displayWidth) * 100,
    top: (ty / displayHeight) * 100,
    width: (tw / displayWidth) * 100,
    height: (th / displayHeight) * 100,
  };
}
