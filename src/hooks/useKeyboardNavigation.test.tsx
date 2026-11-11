import { fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useKeyboardNavigation } from "./useKeyboardNavigation";

describe("useKeyboardNavigation", () => {
  it("supports Lightroom-style rating, favorite and open shortcuts", () => {
    const onSelectPhoto = vi.fn();
    const onOpenPhoto = vi.fn();
    const onRatePhoto = vi.fn();
    const onToggleFavorite = vi.fn();
    renderHook(() => useKeyboardNavigation({
      selectedPhotoId: 20,
      onSelectPhoto,
      photoIds: [10, 20, 30],
      columnCount: 2,
      onOpenPhoto,
      onRatePhoto,
      onToggleFavorite,
    }));

    fireEvent.keyDown(window, { key: "4" });
    fireEvent.keyDown(window, { key: "f" });
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "ArrowRight" });

    expect(onRatePhoto).toHaveBeenCalledWith(20, 4);
    expect(onToggleFavorite).toHaveBeenCalledWith(20);
    expect(onOpenPhoto).toHaveBeenCalledWith(20);
    expect(onSelectPhoto).toHaveBeenCalledWith(30);
  });

  it("does not trigger shortcuts while typing", () => {
    const onRatePhoto = vi.fn();
    renderHook(() => useKeyboardNavigation({
      selectedPhotoId: 10,
      onSelectPhoto: vi.fn(),
      photoIds: [10],
      columnCount: 1,
      onRatePhoto,
    }));
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "5" });
    expect(onRatePhoto).not.toHaveBeenCalled();
    input.remove();
  });
  it("does not change the selected photo while the task dialog is open", () => {
    const onSelectPhoto = vi.fn();
    renderHook(() => useKeyboardNavigation({ selectedPhotoId: 10, onSelectPhoto, photoIds: [10,20], columnCount: 1 }));
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.appendChild(dialog);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onSelectPhoto).not.toHaveBeenCalled();
    dialog.remove();
  });
});
