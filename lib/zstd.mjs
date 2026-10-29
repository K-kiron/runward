import * as zlib from 'node:zlib';

// Frame boundaries follow https://github.com/facebook/zstd/blob/dev/doc/zstd_compression_format.md.
// Native decoding alone can silently accept a truncated frame, including an incomplete checksum.
function frameEnd(bytes, start) {
  const requireBytes = end => {
    if (end > bytes.length) throw new Error('Incomplete Zstandard frame; waiting for a complete append');
  };
  requireBytes(start + 4);
  const magic = bytes.readUInt32LE(start);
  if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
    requireBytes(start + 8);
    const end = start + 8 + bytes.readUInt32LE(start + 4);
    requireBytes(end);
    return { end, skip: true };
  }
  if (magic !== 0xfd2fb528) throw new Error('Invalid Zstandard frame magic');
  requireBytes(start + 5);
  const flags = bytes[start + 4];
  if (flags & 8) throw new Error('Unsupported Zstandard reserved frame flag');
  const single = Boolean(flags & 32);
  const sizeFlag = flags >>> 6;
  const sizeBytes = sizeFlag ? 1 << sizeFlag : single ? 1 : 0;
  let offset = start + 5 + (single ? 0 : 1) + [0, 1, 2, 4][flags & 3] + sizeBytes;
  requireBytes(offset);
  let last = false;
  while (!last) {
    requireBytes(offset + 3);
    const block = bytes.readUIntLE(offset, 3);
    const type = (block >>> 1) & 3;
    if (type === 3) throw new Error('Invalid Zstandard block type');
    last = Boolean(block & 1);
    offset += 3 + (type === 1 ? 1 : block >>> 3);
    requireBytes(offset);
  }
  if (flags & 4) offset += 4;
  requireBytes(offset);
  return { end: offset, skip: false };
}

export function decompressFrames(bytes, maxBytes = 32 * 1024 * 1024) {
  if (!zlib.zstdDecompressSync) throw new Error('Zstandard transcripts require Node.js 22.15+ with Zstandard support; use an uncompressed export instead');
  const chunks = [];
  let size = 0;
  let offset = 0;
  let frames = 0;
  while (offset < bytes.length) {
    if (++frames > 100000) throw new Error('Selected transcript exceeds 100000 Zstandard frames');
    const { end, skip } = frameEnd(bytes, offset);
    if (!skip) {
      // Decode each complete frame: the native decoder stops after its first frame.
      const decoded = zlib.zstdDecompressSync(bytes.subarray(offset, end), { info: true,
        maxOutputLength: Math.max(1, maxBytes - size), params: { [zlib.constants.ZSTD_d_windowLogMax]: 25 } });
      if (decoded.engine.bytesWritten !== end - offset) throw new Error('Invalid Zstandard frame length');
      size += decoded.buffer.length;
      if (size > maxBytes) throw new Error('Decompressed transcript exceeds the size limit');
      chunks.push(decoded.buffer);
    }
    offset = end;
  }
  return Buffer.concat(chunks, size);
}
