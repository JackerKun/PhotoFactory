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

interface FaceThumbnailResult {
  url: string | null;
  error: string | null;
}

export function createFaceThumbnailQueue<Request>(
  readBatch: (requests: Request[], cacheOnly: boolean, signal: AbortSignal) => Promise<FaceThumbnailResult[]>,
) {
  interface Job {
    request: Request;
    signal?: AbortSignal;
    succeed: (url: string) => void;
    fail: (error: unknown) => void;
  }

  const pending: Job[] = [];
  const uncached: Job[] = [];
  let probeActive = false;
  let cropBatches = 0;
  let scheduled = false;

  async function runBatch(queue: Job[], limit: number, cacheOnly: boolean) {
    const jobs: Job[] = [];
    while (queue.length && jobs.length < limit) {
      const job = queue.shift()!;
      if (!job.signal?.aborted) jobs.push(job);
    }
    if (!jobs.length) return;
    const controller = new AbortController();
    let releaseBatch: () => void;
    const canceled = new Promise<undefined>((resolve) => {
      releaseBatch = () => resolve(undefined);
    });
    const cancelIfEmpty = () => {
      if (jobs.every(({ signal }) => signal?.aborted)) {
        controller.abort();
        releaseBatch();
      }
    };
    for (const job of jobs) job.signal?.addEventListener("abort", cancelIfEmpty);
    try {
      const results = await Promise.race([
        readBatch(jobs.map((job) => job.request), cacheOnly, controller.signal),
        canceled,
      ]);
      if (controller.signal.aborted || !results) return;
      for (const [index, job] of jobs.entries()) {
        if (job.signal?.aborted) continue;
        const result = results[index];
        if (result?.url) job.succeed(result.url);
        else if (result?.error) job.fail(new Error(result.error));
        else if (cacheOnly && result) uncached.push(job);
        else job.fail(new Error("头像缩略图不可用"));
      }
    } catch (error) {
      for (const job of jobs) job.fail(error);
    } finally {
      for (const job of jobs) job.signal?.removeEventListener("abort", cancelIfEmpty);
    }
  }

  function flush() {
    scheduled = false;
    if (!probeActive && pending.length) {
      probeActive = true;
      void runBatch(pending, 32, true).finally(() => {
        probeActive = false;
        flush();
      });
    }
    // Keep each crop batch short so a slow original only delays a few avatars.
    while (cropBatches < 3 && uncached.length) {
      cropBatches++;
      void runBatch(uncached, 4, false).finally(() => {
        cropBatches--;
        flush();
      });
    }
  }

  return (request: Request, signal?: AbortSignal): Promise<string> => new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Face thumbnail request canceled", "AbortError"));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    pending.push({
      request,
      signal,
      succeed: (url) => { signal?.removeEventListener("abort", abort); resolve(url); },
      fail: (error) => { signal?.removeEventListener("abort", abort); reject(error); },
    });
    if (!scheduled) {
      scheduled = true;
      setTimeout(flush, 0);
    }
  });
}
