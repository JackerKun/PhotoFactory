// Retry a transient SQLite lock and bound the wait for a stalled IPC response.
export async function readPhotoData<T>(read: () => Promise<T>, isCurrent = () => true): Promise<T> {
  for (const delay of [250, 750, 0]) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("照片库读取超时，请重试。")), 12_000);
        }),
      ]);
    } catch (error) {
      if (!delay || !isCurrent() || !/database (?:is (?:locked|busy)|table is locked)|SQLITE_BUSY|SQLITE_LOCKED/i.test(String(error))) {
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (!isCurrent()) throw new Error("请求已取消");
  }
  throw new Error("照片库读取失败，请重试。");
}

const waitingFaces: (() => void)[] = [];
let activeFaces = 0;

function startQueuedFaces() {
  while (activeFaces < 2 && waitingFaces.length) waitingFaces.shift()!();
}

// The native command has its own limit. This queue also lets a page discard
// work that has not yet crossed the IPC boundary when the user navigates away.
export function queueFaceThumbnail(read: () => Promise<string>, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = waitingFaces.indexOf(start);
      if (index >= 0) waitingFaces.splice(index, 1);
      reject(new DOMException("Face thumbnail request canceled", "AbortError"));
    };
    const start = () => {
      signal?.removeEventListener("abort", abort);
      activeFaces++;
      Promise.resolve().then(read).then(resolve, reject).finally(() => {
        activeFaces--;
        startQueuedFaces();
      });
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    waitingFaces.push(start);
    startQueuedFaces();
  });
}
