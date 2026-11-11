"""Open photos for inference with a bounded scaled JPEG fallback."""

from contextlib import contextmanager

from PIL import Image, JpegImagePlugin


MAX_LARGE_JPEG_PIXELS = 256 * 1024 * 1024
MAX_REDUCED_PIXELS = 16 * 1024 * 1024


@contextmanager
def open_ai_image(path):
    """Yield the decoder and the original pixel dimensions."""
    try:
        source = Image.open(path)
    except Image.DecompressionBombError as error:
        # The normal Pillow limit stays in force. Baseline JPEG can decode at
        # quarter resolution without allocating the full raster.
        with open(path, "rb") as file:
            if file.read(3) != b"\xff\xd8\xff":
                raise ValueError("超大图像的格式不支持缩小解码") from error
            file.seek(0)
            with JpegImagePlugin.JpegImageFile(file) as jpeg:
                width, height = jpeg.size
                if width * height > MAX_LARGE_JPEG_PIXELS or jpeg.info.get("progressive"):
                    raise ValueError("超大 JPEG 超出智能分析的缩小解码范围") from error
                jpeg.draft("RGB", (max(1, width // 4), max(1, height // 4)))
                if jpeg.width * jpeg.height > MAX_REDUCED_PIXELS:
                    raise ValueError("超大 JPEG 缩小后仍超过智能分析的尺寸上限") from error
                yield jpeg, (width, height)
        return
    with source:
        yield source, source.size
