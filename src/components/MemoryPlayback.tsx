import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { PhotoMemory } from "../types";
import { drawMemoryFrame, loadMemoryFrame, randomTransition, renderFor, slideDuration, transitionDuration } from "../utils/memoryPlayback";

const control = "rounded-lg bg-white/10 px-3 py-2 text-sm hover:bg-white/20 disabled:opacity-40";

export default function MemoryPlayback({ memory, start, autoPlay, onClose, fallback }: {
  memory: PhotoMemory;
  start: number;
  autoPlay: boolean;
  onClose: () => void;
  fallback: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const titleId = useId();
  const [index, setIndex] = useState(start);
  const [playing, setPlaying] = useState(autoPlay);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [controls, setControls] = useState(true);
  const hideTimer = useRef<number>();
  const live = useRef(false);
  const wantsFullscreen = useRef(false);
  const fullTask = useRef<Promise<void>>(Promise.resolve());
  const leaveFullscreen = useRef<() => Promise<void>>();
  const frameTask = useRef<AbortController>();
  const current = useRef<{ index: number; image: HTMLImageElement }>();
  const recentEffect = useRef<ReturnType<typeof randomTransition>>();
  const cache = useRef(new Map<number, Promise<HTMLImageElement | null>>());
  const ids = memory.photo_ids;
  const last = ids.length - 1;

  const load = useCallback((position: number) => {
    const existing = cache.current.get(position);
    if (existing) return existing;
    const promise = loadMemoryFrame(ids[position]).catch(() => null);
    cache.current.set(position, promise);
    return promise;
  }, [ids]);

  const move = useCallback(async (target: number, direction: number, wrap: boolean) => {
    frameTask.current?.abort();
    const task = new AbortController();
    frameTask.current = task;
    setBusy(true);
    try {
      let position = target;
      for (let count = 0; count < ids.length; count++, position += direction) {
        if (wrap) position = (position + ids.length) % ids.length;
        if (position < 0 || position > last || position === current.current?.index) break;
        const image = await load(position);
        if (task.signal.aborted) return;
        if (!image) continue;
        const ctx = canvas.current?.getContext("2d");
        if (!ctx) return;
        const previous = current.current?.image;
        current.current = { index: position, image };
        setIndex(position);
        setReady(true);
        setFailed(false);

        const neighbors = new Set([position, (position + 1) % ids.length, (position + 2) % ids.length, (position + last) % ids.length]);
        for (const cached of cache.current.keys()) {
          if (!neighbors.has(cached)) cache.current.delete(cached);
        }
        for (const neighbor of neighbors) void load(neighbor);

        const effect = randomTransition(recentEffect.current);
        recentEffect.current = effect;
        if (previous && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          await renderFor(transitionDuration, (progress) => drawMemoryFrame(ctx, image, previous, effect, progress), task.signal);
        } else {
          drawMemoryFrame(ctx, image);
        }
        return;
      }
      if (!current.current) setFailed(true);
      setPlaying(false);
    } catch {
      if (!task.signal.aborted) setFailed(!current.current);
    } finally {
      if (!task.signal.aborted) setBusy(false);
    }
  }, [ids.length, last, load]);

  useEffect(() => {
    const element = dialog.current;
    const stage = canvas.current;
    if (!element || !stage) return;
    live.current = true;
    if (!element.open) element.showModal();
    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      stage.width = Math.max(1, Math.round(stage.clientWidth * ratio));
      stage.height = Math.max(1, Math.round(stage.clientHeight * ratio));
      const ctx = stage.getContext("2d");
      if (ctx && current.current) drawMemoryFrame(ctx, current.current.image);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    resize();
    void move(start, 1, true);
    return () => {
      live.current = false;
      wantsFullscreen.current = false;
      frameTask.current?.abort();
      observer.disconnect();
      element.close();
      window.clearTimeout(hideTimer.current);
      const leave = leaveFullscreen.current;
      leaveFullscreen.current = undefined;
      if (leave) fullTask.current = fullTask.current.then(leave).catch(() => {});
    };
  }, [move, start]);

  useEffect(() => {
    if (!playing || !ready || busy || (fullscreen && last === 0)) return;
    const timer = window.setTimeout(() => {
      if (fullscreen || index < last) void move(index + 1, 1, fullscreen);
      else setPlaying(false);
    }, slideDuration);
    return () => window.clearTimeout(timer);
  }, [busy, fullscreen, index, last, move, playing, ready]);

  const showControls = useCallback(() => {
    setControls(true);
    window.clearTimeout(hideTimer.current);
    if (fullscreen && playing) hideTimer.current = window.setTimeout(() => setControls(false), 2500);
  }, [fullscreen, playing]);

  useEffect(showControls, [showControls]);

  useEffect(() => {
    if (!fullscreen || !navigator.wakeLock) return;
    let active = true;
    let lock: WakeLockSentinel | undefined;
    let requesting = false;
    const acquire = async () => {
      if (document.hidden || requesting || (lock && !lock.released)) return;
      requesting = true;
      try {
        const acquired = await navigator.wakeLock.request("screen");
        if (active) lock = acquired;
        else await acquired.release();
      } catch { /* Window fullscreen is still available. */ }
      finally { requesting = false; }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release().catch(() => {});
    };
  }, [fullscreen]);

  const toggleFullscreen = () => {
    if (fullscreen) {
      wantsFullscreen.current = false;
      setFullscreen(false);
      const leave = leaveFullscreen.current;
      leaveFullscreen.current = undefined;
      if (leave) fullTask.current = fullTask.current.then(leave).catch(() => {});
      return;
    }
    wantsFullscreen.current = true;
    setFullscreen(true);
    setPlaying(true);
    const element = dialog.current;
    if ("__TAURI_INTERNALS__" in window) {
      fullTask.current = fullTask.current.then(async () => {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const desktop = getCurrentWindow();
        if (await desktop.isFullscreen()) return;
        await desktop.setFullscreen(true);
        const leave = () => desktop.setFullscreen(false);
        if (live.current && wantsFullscreen.current) leaveFullscreen.current = leave;
        else await leave();
      }).catch(() => {});
    } else if (element?.requestFullscreen) {
      const enter = element.requestFullscreen();
      const leave = async () => { if (document.fullscreenElement === element) await document.exitFullscreen(); };
      leaveFullscreen.current = leave;
      fullTask.current = enter.catch(() => {});
    }
  };

  const step = (direction: number) => {
    if (!ready || busy) return;
    const target = index + direction;
    if (fullscreen || (target >= 0 && target <= last)) void move(target, direction, fullscreen);
  };
  const togglePlaying = () => {
    if (!playing && !fullscreen && index === last && last > 0) void move(0, 1, false);
    setPlaying(!playing);
  };

  const visibleControls = !fullscreen || controls;
  return <dialog
    ref={dialog}
    aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); if (fullscreen) toggleFullscreen(); else onClose(); }}
    onPointerMove={showControls}
    onFocusCapture={showControls}
    onKeyDown={(event) => {
      showControls();
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        step(event.key === "ArrowLeft" ? -1 : 1);
      }
    }}
    className={`m-auto max-h-none max-w-none overflow-hidden bg-[#15171b] p-0 text-white shadow-2xl backdrop:bg-black/75 ${fullscreen ? "fixed inset-0 h-screen w-screen" : "rounded-2xl"}`}
  >
    <div className={`relative flex flex-col ${fullscreen ? "h-full w-full" : "h-[min(48rem,calc(100vh-2rem))] w-[min(72rem,calc(100vw-2rem))]"}`}>
      <header className={`z-10 flex items-center justify-between gap-3 px-4 py-3 transition-opacity ${fullscreen ? "absolute inset-x-0 top-0 bg-black/55" : "border-b border-white/15"} ${visibleControls ? "" : "pointer-events-none opacity-0"}`}>
        <h2 id={titleId} className="truncate text-base font-semibold">{memory.title}</h2>
        <button type="button" autoFocus onClick={onClose} className={control}>关闭</button>
      </header>
      <div className="relative min-h-0 flex-1">
        {!ready && <div className="absolute inset-0">{fallback}</div>}
        <canvas ref={canvas} role="img" aria-label={`回忆中的第 ${index + 1} 张照片`} className={`absolute inset-0 h-full w-full ${ready ? "" : "invisible"}`} />
        {failed && <p role="status" className="absolute inset-x-0 bottom-4 text-center">这条回忆的照片都无法读取。</p>}
      </div>
      <footer className={`z-10 flex flex-wrap items-center justify-center gap-2 px-3 py-3 text-sm transition-opacity ${fullscreen ? "absolute inset-x-0 bottom-0 bg-black/55" : "border-t border-white/15"} ${visibleControls ? "" : "pointer-events-none opacity-0"}`}>
        <button type="button" onClick={() => step(-1)} disabled={!ready || busy || (!fullscreen && index === 0)} className={control}>上一张</button>
        <button type="button" onClick={togglePlaying} disabled={!ready} className={control}>{playing ? "暂停" : index === last && !fullscreen ? "重播" : "播放"}</button>
        <button type="button" onClick={() => step(1)} disabled={!ready || busy || (!fullscreen && index === last)} className={control}>下一张</button>
        <span aria-label="播放进度" className="mx-2 tabular-nums text-white/75">{index + 1} / {last + 1}</span>
        <button type="button" onClick={toggleFullscreen} className={control}>{fullscreen ? "退出全屏" : "全屏循环"}</button>
      </footer>
    </div>
  </dialog>;
}
