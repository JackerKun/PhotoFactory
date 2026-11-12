// MediaRecorder's live WebM stream may omit Duration. Patch the Info element
// when it opens an unindexed, unknown-sized Segment, as in WebKit's output.
const unknownSize = Number.POSITIVE_INFINITY;

function vint(bytes: Uint8Array, offset: number, size: boolean) {
  const first = bytes[offset];
  if (!first) return;
  const width = 8 - Math.floor(Math.log2(first));
  if (width > (size ? 8 : 4) || offset + width > bytes.length) return;
  const marker = 1 << (8 - width);
  let value = BigInt(size ? first & (marker - 1) : first);
  for (let i = 1; i < width; i++) value = value * 256n + BigInt(bytes[offset + i]);
  if (size && value === (1n << BigInt(width * 7)) - 1n) return { width, value: unknownSize };
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return;
  return { width, value: Number(value) };
}

function element(bytes: Uint8Array, offset: number) {
  const id = vint(bytes, offset, false);
  if (!id) return;
  const sizeAt = offset + id.width;
  const length = vint(bytes, sizeAt, true);
  if (!length) return;
  const dataAt = sizeAt + length.width;
  return { id: id.value, sizeAt, dataAt, end: dataAt + length.value };
}

export function withWebmDuration(bytes: Uint8Array, milliseconds: number): Uint8Array {
  const header = element(bytes, 0);
  if (header?.id !== 0x1a45dfa3) return bytes;
  const segment = element(bytes, header.end);
  if (segment?.id !== 0x18538067 || segment.end !== unknownSize) return bytes;
  const info = element(bytes, segment.dataAt);
  if (info?.id !== 0x1549a966 || info.end > bytes.length) return bytes;

  let timecodeScale = 1_000_000;
  for (let offset = info.dataAt; offset < info.end;) {
    const item = element(bytes, offset);
    if (!item || item.end > info.end || item.id === 0x4489 || item.id === 0xbf) return bytes;
    if (item.id === 0x2ad7b1) {
      if (item.end - item.dataAt > 6) return bytes;
      timecodeScale = 0;
      for (let pos = item.dataAt; pos < item.end; pos++) timecodeScale = timecodeScale * 256 + bytes[pos];
    }
    offset = item.end;
  }
  if (!timecodeScale) return bytes;

  const duration = new Uint8Array([0x44, 0x89, 0x88, 0, 0, 0, 0, 0, 0, 0, 0]);
  new DataView(duration.buffer).setFloat64(3, milliseconds * 1_000_000 / timecodeScale);
  const newSize = info.end - info.dataAt + duration.length;
  const sizeWidth = info.dataAt - info.sizeAt;
  if (newSize >= 2 ** (sizeWidth * 7) - 1) return bytes;
  const result = new Uint8Array(bytes.length + duration.length);
  result.set(bytes.subarray(0, info.sizeAt));
  let remaining = newSize;
  for (let offset = info.dataAt - 1; offset >= info.sizeAt; offset--) {
    result[offset] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  result[info.sizeAt] |= 1 << (8 - sizeWidth);
  result.set(bytes.subarray(info.dataAt, info.end), info.dataAt);
  result.set(duration, info.end);
  result.set(bytes.subarray(info.end), info.end + duration.length);
  return result;
}
