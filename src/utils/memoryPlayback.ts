import { convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { appendMemoryVideo, beginMemoryVideo, finishMemoryVideo, getThumbnailPath } from "../api/tauri";
import type { PhotoMemory } from "../types";
import { withWebmDuration } from "./webmDuration";

export const slideDuration = 3500;
export const transitionDuration = 720;
const effects = ["fade", "slide", "wipe", "zoom"] as const;
type Effect = (typeof effects)[number];

export function randomTransition(previous?: Effect): Effect {
  const choices = effects.filter((effect) => effect !== previous);
  return choices[Math.floor(Math.random() * choices.length)];
}

export async function loadMemoryFrame(id: number, signal?: AbortSignal): Promise<HTMLImageElement> {
  for (const size of ["large", "small"]) {
    signal?.throwIfAborted();
    let timeout: number | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        getThumbnailPath(id, size).then((path) => {
          const image = new Image();
          image.crossOrigin = "anonymous";
          image.src = convertFileSrc(path);
          return image.decode().then(() => image);
        }),
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(() => reject(new Error("照片读取超时")), size === "large" ? 10_000 : 4_000);
          abort = () => reject(signal?.reason);
          signal?.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } catch {
      // A cached grid thumbnail can still show a photo whose large preview failed.
    } finally {
      window.clearTimeout(timeout);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }
  throw new Error("无法读取照片");
}

export function drawMemoryFrame(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  previous?: HTMLImageElement,
  effect: Effect = "fade",
  progress = 1,
) {
  const { width, height } = ctx.canvas;
  const eased = 1 - (1 - progress) ** 3;
  const paint = (photo: HTMLImageElement, offset = 0, zoom = 1) => {
    const scale = Math.min(width / photo.naturalWidth, height / photo.naturalHeight) * zoom;
    const w = photo.naturalWidth * scale;
    const h = photo.naturalHeight * scale;
    const x = (width - w) / 2;
    const y = (height - h) / 2;
    ctx.fillStyle = "#15171b";
    ctx.fillRect(offset, 0, width, y);
    ctx.fillRect(offset, height - y, width, y);
    ctx.fillRect(offset, y, x, h);
    ctx.fillRect(offset + width - x, y, x, h);
    ctx.drawImage(photo, offset + x, y, w, h);
  };
  if (!previous || progress >= 1) {
    paint(image);
    return;
  }
  paint(previous);
  ctx.save();
  if (effect === "slide" || effect === "wipe") {
    const edge = effect === "slide" ? width * (1 - eased) : 0;
    ctx.beginPath();
    ctx.rect(edge, 0, width * eased, height);
    ctx.clip();
    paint(image, edge);
  } else {
    ctx.globalAlpha = eased;
    paint(image, 0, effect === "zoom" ? 0.84 + 0.16 * eased : 1);
  }
  ctx.restore();
}

export function renderFor(duration: number, render: (progress: number) => void, signal: AbortSignal, frameRate?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let request = 0;
    let start: number | undefined;
    const schedule = (tick: FrameRequestCallback) => frameRate
      ? window.setTimeout(() => tick(performance.now()), 1000 / frameRate)
      : requestAnimationFrame(tick);
    const stop = () => {
      if (frameRate) window.clearTimeout(request);
      else cancelAnimationFrame(request);
      reject(signal.reason);
    };
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    const tick = (now: number) => {
      start ??= now;
      const progress = Math.min(1, (now - start) / duration);
      try {
        render(progress);
      } catch (error) {
        signal.removeEventListener("abort", stop);
        reject(error);
        return;
      }
      if (progress < 1) request = schedule(tick);
      else {
        signal.removeEventListener("abort", stop);
        resolve();
      }
    };
    request = schedule(tick);
  });
}

function videoFormat() {
  if (typeof MediaRecorder === "undefined" || !HTMLCanvasElement.prototype.captureStream) {
    throw new Error("当前系统的网页组件不支持视频录制。");
  }
  const mp4 = [
    { mime: "video/mp4;codecs=avc1.42001f", extension: "mp4" },
    { mime: "video/mp4", extension: "mp4" },
  ];
  const webm = [
    { mime: "video/webm;codecs=vp8", extension: "webm" },
    { mime: "video/webm", extension: "webm" },
  ];
  // WebKit can produce unreliable timestamps in fragmented MP4 recordings.
  const webKit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg/.test(navigator.userAgent);
  const candidates = webKit ? [...webm, ...mp4] : [...mp4, ...webm];
  const supported = candidates.find(({ mime }) => MediaRecorder.isTypeSupported(mime));
  if (!supported) throw new Error("当前系统无法编码 MP4 或 WebM 视频。");
  return supported;
}

export async function exportMemoryVideo(memory: PhotoMemory, signal: AbortSignal, report: (progress: number) => void) {
  const { mime, extension } = videoFormat();
  const filename = memory.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "") || "回忆";
  const destination = await save({
    title: "导出回忆视频",
    defaultPath: `${filename}.${extension}`,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  });
  if (!destination) return null;
  if (!destination.toLowerCase().endsWith(`.${extension}`)) {
    throw new Error(`请将文件名后缀设为 .${extension}。`);
  }
  signal.throwIfAborted();

  // Decode once before recording so only actual photos occupy the video timeline.
  const frames: HTMLImageElement[] = [];
  for (const [index, id] of memory.photo_ids.entries()) {
    signal.throwIfAborted();
    const image = await loadMemoryFrame(id, signal).catch(() => {
      signal.throwIfAborted();
      return null;
    });
    if (image) frames.push(image);
    report(0.15 * (index + 1) / memory.photo_ids.length);
  }
  signal.throwIfAborted();
  if (!frames.length) throw new Error("这条回忆的照片都无法读取。");

  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法建立视频画面。");
  drawMemoryFrame(ctx, frames[0]);
  const stream = canvas.captureStream(30);
  let recorder: MediaRecorder | undefined;
  let id: string | undefined;
  try {
    const writer = await beginMemoryVideo(destination);
    id = writer;
    signal.throwIfAborted();
    const encoder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    recorder = encoder;
    const task = new AbortController();
    const abort = () => task.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    let writes = Promise.resolve();
    const stopped = new Promise<void>((resolve) => {
      encoder.onstop = () => resolve();
    });
    encoder.onerror = () => task.abort(new Error("系统视频编码器发生错误。"));
    let firstChunk = true;
    encoder.ondataavailable = ({ data }) => {
      if (!data.size) return;
      const addDuration = firstChunk && extension === "webm";
      firstChunk = false;
      writes = writes.then(async () => {
        let chunk = data;
        if (addDuration) {
          const prefix = new Uint8Array(await data.slice(0, 4096).arrayBuffer());
          const updated = withWebmDuration(prefix, frames.length * slideDuration);
          if (updated !== prefix) chunk = new Blob([updated.buffer as ArrayBuffer, data.slice(prefix.length)]);
        }
        for (let offset = 0; offset < chunk.size; offset += 512 * 1024) {
          task.signal.throwIfAborted();
          await appendMemoryVideo(writer, await chunk.slice(offset, offset + 512 * 1024).arrayBuffer());
        }
      });
      void writes.catch((error) => task.abort(error));
    };
    try {
      encoder.start(1000);
      let effect: Effect | undefined;
      for (const [index, frame] of frames.entries()) {
        effect = randomTransition(effect);
        const previous = frames[index - 1];
        const transition = effect;
        await renderFor(slideDuration, (progress) => {
          const blend = Math.min(1, progress * slideDuration / transitionDuration);
          drawMemoryFrame(ctx, frame, previous, transition, blend);
          report(0.15 + 0.84 * (index + progress) / frames.length);
        }, task.signal, 30);
      }
      if (encoder.state !== "inactive") encoder.stop();
      await new Promise<void>((resolve, reject) => {
        task.signal.throwIfAborted();
        const onAbort = () => { cleanup(); reject(task.signal.reason); };
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error("等待系统完成视频编码超时。"));
        }, 8000);
        const cleanup = () => {
          window.clearTimeout(timeout);
          task.signal.removeEventListener("abort", onAbort);
        };
        task.signal.addEventListener("abort", onAbort, { once: true });
        void stopped.then(() => { cleanup(); resolve(); });
      });
      await writes;
      task.signal.throwIfAborted();
      await finishMemoryVideo(writer, true);
      id = undefined;
      report(1);
      return { path: destination, skipped: memory.photo_ids.length - frames.length };
    } finally {
      signal.removeEventListener("abort", abort);
      encoder.ondataavailable = null;
      if (encoder.state !== "inactive") encoder.stop();
      await writes.catch(() => {});
    }
  } finally {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    stream.getTracks().forEach((track) => track.stop());
    if (id) await finishMemoryVideo(id, false).catch(() => {});
  }
}
