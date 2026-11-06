import { useEffect, useRef } from "react";

interface UseKeyboardNavigationProps {
  selectedPhotoId: number | null;
  onSelectPhoto: (id: number) => void;
  /** List of photo IDs in the current view, in display order */
  photoIds: number[];
  /** Number of columns in the grid (for up/down navigation) */
  columnCount: number;
  /** Whether keyboard navigation is enabled */
  enabled?: boolean;
  /** Additional callback to check if lightbox is open (should skip if true) */
  isLightboxOpen?: boolean;
  onOpenPhoto?: (id: number) => void;
  onRatePhoto?: (id: number, rating: number) => void | Promise<void>;
  onToggleFavorite?: (id: number) => void | Promise<void>;
}

export function useKeyboardNavigation({
  selectedPhotoId,
  onSelectPhoto,
  photoIds,
  columnCount,
  enabled = true,
  isLightboxOpen = false,
  onOpenPhoto,
  onRatePhoto,
  onToggleFavorite,
}: UseKeyboardNavigationProps) {
  const selectedRef = useRef(selectedPhotoId);
  const photoIdsRef = useRef(photoIds);
  selectedRef.current = selectedPhotoId;
  photoIdsRef.current = photoIds;

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if focus is in input, textarea, or select
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable) {
        return;
      }
      if (isLightboxOpen || document.querySelector('[role="dialog"][aria-label="键盘快捷键"]')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const ids = photoIdsRef.current;
      const current = selectedRef.current;

      if (ids.length === 0) return;

      const currentIndex = current != null ? ids.indexOf(current) : -1;

      let newIndex: number;

      switch (e.key) {
        case "ArrowRight":
          e.preventDefault();
          newIndex = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, ids.length - 1);
          onSelectPhoto(ids[newIndex]);
          break;
        case "ArrowLeft":
          e.preventDefault();
          newIndex = currentIndex < 0 ? 0 : Math.max(currentIndex - 1, 0);
          onSelectPhoto(ids[newIndex]);
          break;
        case "ArrowDown":
          e.preventDefault();
          newIndex = currentIndex < 0 ? 0 : Math.min(currentIndex + columnCount, ids.length - 1);
          onSelectPhoto(ids[newIndex]);
          break;
        case "ArrowUp":
          e.preventDefault();
          newIndex = currentIndex < 0 ? 0 : Math.max(currentIndex - columnCount, 0);
          onSelectPhoto(ids[newIndex]);
          break;
        case "Home":
          e.preventDefault();
          onSelectPhoto(ids[0]);
          break;
        case "End":
          e.preventDefault();
          onSelectPhoto(ids[ids.length - 1]);
          break;
        case "Enter":
        case " ":
          if (current != null && onOpenPhoto) {
            e.preventDefault();
            onOpenPhoto(current);
          }
          break;
        case "f":
        case "F":
          if (current != null && onToggleFavorite) {
            e.preventDefault();
            void onToggleFavorite(current);
          }
          break;
        case "Escape":
          if (current != null) {
            e.preventDefault();
            // Deselect
            onSelectPhoto(-1 as unknown as number); // signal to close
          }
          break;
        default:
          if (/^[0-5]$/.test(e.key) && current != null && onRatePhoto) {
            e.preventDefault();
            void onRatePhoto(current, Number(e.key));
          }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, columnCount, onSelectPhoto, isLightboxOpen, onOpenPhoto, onRatePhoto, onToggleFavorite]);
}
