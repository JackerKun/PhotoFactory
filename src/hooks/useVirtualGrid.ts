import { useRef, useCallback, useEffect, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

interface UseVirtualGridOptions {
  itemCount: number; columnCount: number; cellHeight: number; gap: number; overscan?: number;
}

export function useVirtualGrid({ itemCount, columnCount, cellHeight, gap, overscan = 5 }: UseVirtualGridOptions) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rowCount = Math.ceil(itemCount / columnCount);
  const virtualizer = useVirtualizer({
    count: rowCount, getScrollElement: () => parentRef.current, estimateSize: () => cellHeight + gap, overscan,
  });

  // TanStack Virtual caches measurements. Width/column changes (for example
  // opening Photo Details or switching layouts) must invalidate that cache.
  useEffect(() => {
    virtualizer.measure();
  }, [cellHeight, columnCount, itemCount, virtualizer]);

  const getItemsForRow = useCallback((rowIndex: number) => {
    const start = rowIndex * columnCount;
    const items: number[] = [];
    for (let i = 0; i < columnCount; i++) { if (start + i < itemCount) items.push(start + i); }
    return items;
  }, [itemCount, columnCount]);

  return { parentRef, virtualizer, getItemsForRow, columnCount, containerWidth };
}

export function calculateColumnCount(width: number, cellSize = 200, gap = 8): number {
  return Math.max(1, Math.floor((width + gap) / (cellSize + gap)));
}

interface UseDynamicVirtualGridOptions {
  itemCount: number;
  columnCount: number;
  estimatedItemHeight: number;
  gap: number;
  overscan?: number;
}

/**
 * Virtual grid hook for dynamic (proportional) item sizes.
 * Uses measureElement for size feedback to the virtualizer.
 */
export function useDynamicVirtualGrid({
  itemCount,
  columnCount,
  estimatedItemHeight,
  gap,
  overscan = 5,
}: UseDynamicVirtualGridOptions) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rowCount = Math.ceil(itemCount / columnCount);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimatedItemHeight + gap,
    overscan,
    measureElement: (el) => {
      if (!el) return 0;
      return el.getBoundingClientRect().height + gap;
    },
  });

  const getItemsForRow = useCallback((rowIndex: number) => {
    const start = rowIndex * columnCount;
    const items: number[] = [];
    for (let i = 0; i < columnCount; i++) {
      if (start + i < itemCount) items.push(start + i);
    }
    return items;
  }, [itemCount, columnCount]);

  const columnWidth = containerWidth > 0
    ? (containerWidth - gap * (columnCount - 1)) / columnCount
    : 200;

  return { parentRef, virtualizer, getItemsForRow, columnCount, columnWidth, containerWidth };
}
