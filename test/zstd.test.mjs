import test from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import { decompressFrames } from '../lib/zstd.mjs';

const supported = Boolean(zlib.zstdCompressSync);
const compress = text => zlib.zstdCompressSync(Buffer.from(text), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });

test('Zstandard rejects every truncated header, block, and checksum boundary', { skip: !supported }, () => {
  const frame = compress('A fictional checksummed recording.\n');
  assert.equal(decompressFrames(frame).toString(), 'A fictional checksummed recording.\n');
  for (let length = 1; length < frame.length; length++) {
    assert.throws(() => decompressFrames(frame.subarray(0, length)), /Incomplete/, `truncation at byte ${length}`);
  }
  const corrupt = Buffer.from(frame);
  corrupt[corrupt.length - 1] ^= 255;
  assert.throws(() => decompressFrames(corrupt));
});

test('Zstandard combines complete frames and skips bounded metadata frames', { skip: !supported }, () => {
  const skipped = Buffer.alloc(11);
  skipped.writeUInt32LE(0x184d2a50, 0);
  skipped.writeUInt32LE(3, 4);
  skipped.write('abc', 8);
  assert.equal(decompressFrames(Buffer.concat([compress('one\n'), skipped, compress('two\n')])).toString(), 'one\ntwo\n');
  assert.throws(() => decompressFrames(skipped.subarray(0, 9)), /Incomplete/);
  assert.throws(() => decompressFrames(Buffer.from('not-a-frame')), /magic/);
});

test('Zstandard caps total output across separate frames', { skip: !supported }, () => {
  const first = compress('123456');
  const second = compress('abcdef');
  assert.throws(() => decompressFrames(Buffer.concat([first, second]), 10));
  assert.equal(decompressFrames(Buffer.concat([first, second]), 12).toString(), '123456abcdef');
});
