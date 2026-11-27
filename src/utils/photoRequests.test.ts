import { expect, it, vi } from "vitest";
import { createFaceThumbnailQueue } from "./photoRequests";

const hit = (id: number) => ({ url: `avatar-${id}`, error: null });
const miss = { url: null, error: null };

it("reads visible cache hits as a batch and runs independent crop batches in parallel", async () => {
  const finishCrops: (() => void)[] = [];
  const read = vi.fn(async (ids: number[], cacheOnly: boolean) => {
    if (cacheOnly) return ids.map((id) => id === 1 ? hit(id) : miss);
    await new Promise<void>((resolve) => finishCrops.push(resolve));
    return ids.map(hit);
  });
  const queue = createFaceThumbnailQueue(read);
  const visible = Array.from({ length: 10 }, (_, index) => queue(index + 1));
  const all = Promise.all(visible);
  try {
    await expect(visible[0]).resolves.toBe("avatar-1");
    await vi.waitFor(() => expect(finishCrops).toHaveLength(3));
    expect(read.mock.calls.map(([ids, cacheOnly]) => [ids, cacheOnly])).toEqual([
      [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], true],
      [[2, 3, 4, 5], false],
      [[6, 7, 8, 9], false],
      [[10], false],
    ]);
    finishCrops[1]();
    await expect(visible[5]).resolves.toBe("avatar-6");
  } finally {
    finishCrops.forEach((finish) => finish());
  }
  await expect(all).resolves.toHaveLength(10);
});

it("drops avatars that leave the viewport before cropping", async () => {
  let finishProbe!: () => void;
  const read = vi.fn(async (ids: number[], cacheOnly: boolean) => {
    if (!cacheOnly) return ids.map(hit);
    await new Promise<void>((resolve) => { finishProbe = resolve; });
    return ids.map(() => miss);
  });
  const queue = createFaceThumbnailQueue(read);
  const leftBeforeProbe = new AbortController();
  const leftBeforeCrop = new AbortController();
  const skippedProbe = queue(1, leftBeforeProbe.signal).catch((error) => error);
  const skippedCrop = queue(2, leftBeforeCrop.signal).catch((error) => error);
  const stillVisible = queue(3);
  leftBeforeProbe.abort();
  await vi.waitFor(() => expect(read).toHaveBeenCalledWith([2, 3], true, expect.any(AbortSignal)));
  leftBeforeCrop.abort();
  finishProbe();
  await expect(stillVisible).resolves.toBe("avatar-3");
  expect(read.mock.calls.map(([ids, cacheOnly]) => [ids, cacheOnly])).toEqual([[[2, 3], true], [[3], false]]);
  expect(await skippedProbe).toMatchObject({ name: "AbortError" });
  expect(await skippedCrop).toMatchObject({ name: "AbortError" });
});

it("releases obsolete crop batches so a new viewport can load before old IPC returns", async () => {
  const oldBatches: AbortSignal[] = [];
  const finishOldBatches: (() => void)[] = [];
  const queue = createFaceThumbnailQueue(async (ids: number[], cacheOnly, signal) => {
    if (cacheOnly) return ids.map(() => miss);
    if (ids[0] < 100) {
      oldBatches.push(signal);
      await new Promise<void>((resolve) => finishOldBatches.push(resolve));
    }
    return ids.map(hit);
  });
  const oldViewport = Array.from({ length: 12 }, () => new AbortController());
  const oldResults = Promise.allSettled(oldViewport.map((controller, index) => queue(index, controller.signal)));
  try {
    await vi.waitFor(() => expect(oldBatches).toHaveLength(3));
    oldViewport[0].abort();
    expect(oldBatches[0].aborted).toBe(false);
    oldViewport.slice(1).forEach((controller) => controller.abort());
    expect(oldBatches.every((signal) => signal.aborted)).toBe(true);
    await expect(queue(100)).resolves.toBe("avatar-100");
    expect((await oldResults).every((result) => result.status === "rejected")).toBe(true);
  } finally {
    finishOldBatches.forEach((finish) => finish());
  }
});
