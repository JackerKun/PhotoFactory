export async function getThumbnailPath(photoId: number, _size: "small" | "medium" | "large"): Promise<string> {
  return `/mock/thumbnails/${photoId}.jpg`;
}

export async function getPhotoDataUrl(_path: string): Promise<string> {
  return "data:image/png;base64,mock";
}

export async function togglePhotoFavorite(_photoId: number): Promise<boolean> {
  return true;
}

export async function revealInFileManager(_path: string): Promise<void> {
  // no-op in tests
}
