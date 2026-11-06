import { describe, expect, it } from "vitest";
import type { FaceDetection } from "../types";
import { faceBoxForDisplay } from "./faceGeometry";

const face = { bbox_x: 10, bbox_y: 20, bbox_w: 30, bbox_h: 40 } as FaceDetection;

describe("faceBoxForDisplay", () => {
  it("keeps unrotated detector coordinates", () => {
    expect(faceBoxForDisplay(face, 100, 200, 1)).toEqual({ left: 10, top: 10, width: 30, height: 20 });
  });

  it("maps a 90 degree clockwise EXIF orientation", () => {
    expect(faceBoxForDisplay(face, 100, 200, 6)).toEqual({ left: 70, top: 10, width: 20, height: 30 });
  });

  it("maps a 90 degree counter-clockwise EXIF orientation", () => {
    expect(faceBoxForDisplay(face, 100, 200, 8)).toEqual({ left: 10, top: 60, width: 20, height: 30 });
  });
});
