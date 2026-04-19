import { describe, it, expect } from 'vitest';
import { ReolinkFLVTransform } from './flv-transform.js';

/** Collect all output chunks from a transform into a single Buffer. */
function collect(transform: ReolinkFLVTransform, chunks: Buffer[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    transform.on('data', (chunk: Buffer) => parts.push(chunk));
    transform.on('end', () => resolve(Buffer.concat(parts)));
    transform.on('error', reject);
    for (const chunk of chunks) transform.write(chunk);
    transform.end();
  });
}

/** Minimal valid FLV file header (9 bytes) + PreviousTagSize0 (4 bytes) = 13 bytes. */
function makeFlvHeader(): Buffer {
  const buf = Buffer.alloc(13);
  buf[0] = 0x46; buf[1] = 0x4C; buf[2] = 0x56; // 'FLV'
  buf[3] = 0x01;              // version
  buf[4] = 0x01;              // flags: video present
  buf.writeUInt32BE(9, 5);    // header size = 9
  // PreviousTagSize0 = 0 (already zeroed by alloc)
  return buf;
}

/**
 * Build a complete FLV tag: 11-byte tag header + data + 4-byte PreviousTagSize.
 * The timestamp field is 32-bit split across bytes 4–6 (low 24 bits) + byte 7 (high 8 bits).
 */
function makeFlvTag(tagType: number, data: Buffer, timestamp = 0): Buffer {
  const buf = Buffer.alloc(11 + data.length + 4);
  buf[0] = tagType;
  buf[1] = (data.length >> 16) & 0xFF;
  buf[2] = (data.length >> 8) & 0xFF;
  buf[3] = data.length & 0xFF;
  buf[4] = (timestamp >> 16) & 0xFF;
  buf[5] = (timestamp >> 8) & 0xFF;
  buf[6] = timestamp & 0xFF;
  buf[7] = (timestamp >> 24) & 0xFF; // TimestampExtended
  // StreamID = 0 (bytes 8–10 already zeroed)
  data.copy(buf, 11);
  buf.writeUInt32BE(11 + data.length, 11 + data.length);
  return buf;
}

/**
 * Build the raw data portion of a Reolink HEVC video tag (codec ID 12).
 *   frameType  — 1 = keyframe, 2 = inter frame
 *   packetType — 0 = SequenceStart, 1 = CodedFrames, 2 = EndOfSequence
 */
function makeReolinkVideoData(
  frameType: number,
  packetType: number,
  ct: Buffer = Buffer.from([0x00, 0x00, 0x00]),
  payload: Buffer = Buffer.alloc(0),
): Buffer {
  const firstByte = (frameType << 4) | 12;
  return Buffer.concat([Buffer.from([firstByte, packetType]), ct, payload]);
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Read the 3-byte big-endian DataSize field from a FLV tag at the given offset. */
function readDataSize(buf: Buffer, tagOffset: number): number {
  return (buf[tagOffset + 1]! << 16) | (buf[tagOffset + 2]! << 8) | buf[tagOffset + 3]!;
}

/** FourCC for Enhanced FLV HEVC: 'hvc1'. */
const HVC1 = Buffer.from([0x68, 0x76, 0x63, 0x31]);

// ─── tests ────────────────────────────────────────────────────────────────────

describe('ReolinkFLVTransform', () => {

  describe('FLV file header', () => {
    it('passes through the 13-byte header + PreviousTagSize0 unchanged', async () => {
      const header = makeFlvHeader();
      const out = await collect(new ReolinkFLVTransform(), [header]);
      expect(out).toEqual(header);
    });

    it('handles header delivered in single-byte chunks', async () => {
      const header = makeFlvHeader();
      const chunks = Array.from({ length: header.length }, (_, i) => header.subarray(i, i + 1));
      const out = await collect(new ReolinkFLVTransform(), chunks);
      expect(out).toEqual(header);
    });
  });

  describe('non-video tags — pass through unchanged', () => {
    it('passes through audio tags (0x08)', async () => {
      const input = Buffer.concat([
        makeFlvHeader(),
        makeFlvTag(0x08, Buffer.from([0xAF, 0x00, 0x12, 0x10])),
      ]);
      const out = await collect(new ReolinkFLVTransform(), [input]);
      expect(out).toEqual(input);
    });

    it('passes through script data tags (0x12)', async () => {
      const input = Buffer.concat([
        makeFlvHeader(),
        makeFlvTag(0x12, Buffer.from([0x02, 0x00, 0x0A, 0x6F, 0x6E, 0x4D, 0x65, 0x74, 0x61, 0x44, 0x61, 0x74, 0x61])),
      ]);
      const out = await collect(new ReolinkFLVTransform(), [input]);
      expect(out).toEqual(input);
    });
  });

  describe('video tags — pass through when no conversion needed', () => {
    it('passes through H.264 (codec ID 7) video tags', async () => {
      const data = Buffer.from([0x17, 0x00, 0x00, 0x00, 0x00, 0xDE, 0xAD, 0xBE, 0xEF]);
      const input = Buffer.concat([makeFlvHeader(), makeFlvTag(0x09, data)]);
      const out = await collect(new ReolinkFLVTransform(), [input]);
      expect(out).toEqual(input);
    });

    it('passes through already-enhanced video tags (bit 7 set on first byte)', async () => {
      const data = Buffer.from([0x90, 0x68, 0x76, 0x63, 0x31, 0x00, 0x00, 0x00]);
      const input = Buffer.concat([makeFlvHeader(), makeFlvTag(0x09, data)]);
      const out = await collect(new ReolinkFLVTransform(), [input]);
      expect(out).toEqual(input);
    });
  });

  describe('SequenceStart (packet_type=0) conversion', () => {
    it('rewrites codec-12 SequenceStart to Enhanced FLV — same output size', async () => {
      const frameType = 1;
      const hvcc = Buffer.from([0x01, 0x02, 0x03, 0x04]); // fake HVCC decoder config
      const videoData = makeReolinkVideoData(frameType, 0, Buffer.from([0x00, 0x00, 0x00]), hvcc);
      const input = Buffer.concat([makeFlvHeader(), makeFlvTag(0x09, videoData)]);

      const out = await collect(new ReolinkFLVTransform(), [input]);

      expect(out.subarray(0, 13)).toEqual(makeFlvHeader());

      const outDataSize = readDataSize(out, 13);
      expect(outDataSize).toBe(videoData.length); // same size

      const outData = out.subarray(24, 24 + outDataSize);
      expect(outData[0]).toBe(0x80 | (frameType << 4) | 0); // 0x90
      expect(outData.subarray(1, 5)).toEqual(HVC1);
      expect(outData.subarray(5)).toEqual(hvcc); // HVCC payload preserved
    });
  });

  describe('CodedFrames (packet_type=1) conversion', () => {
    it('rewrites codec-12 CodedFrames to Enhanced FLV — output is 3 bytes larger', async () => {
      const frameType = 2;
      const ct = Buffer.from([0x00, 0x01, 0x00]);
      const nalus = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE]);
      const videoData = makeReolinkVideoData(frameType, 1, ct, nalus);
      const input = Buffer.concat([makeFlvHeader(), makeFlvTag(0x09, videoData)]);

      const out = await collect(new ReolinkFLVTransform(), [input]);

      const outDataSize = readDataSize(out, 13);
      expect(outDataSize).toBe(videoData.length + 3); // 3 bytes larger

      const outData = out.subarray(24, 24 + outDataSize);
      expect(outData[0]).toBe(0x80 | (frameType << 4) | 1); // 0xA1
      expect(outData.subarray(1, 5)).toEqual(HVC1);
      expect(outData.subarray(5, 8)).toEqual(ct);    // composition time preserved
      expect(outData.subarray(8)).toEqual(nalus);    // NAL units preserved

      // PreviousTagSize at end of tag must match 11 + new data size
      const pts = out.readUInt32BE(out.length - 4);
      expect(pts).toBe(11 + outDataSize);
    });
  });

  describe('EndOfSequence (packet_type=2) conversion', () => {
    it('rewrites codec-12 EndOfSequence to Enhanced FLV — same output size', async () => {
      const frameType = 1;
      const videoData = makeReolinkVideoData(frameType, 2);
      const input = Buffer.concat([makeFlvHeader(), makeFlvTag(0x09, videoData)]);

      const out = await collect(new ReolinkFLVTransform(), [input]);

      const outDataSize = readDataSize(out, 13);
      expect(outDataSize).toBe(videoData.length); // same size

      const outData = out.subarray(24, 24 + outDataSize);
      expect(outData[0]).toBe(0x80 | (frameType << 4) | 3); // 0x93 — PacketType 3 = SequenceEnd in Enhanced FLV
      expect(outData.subarray(1, 5)).toEqual(HVC1);
    });
  });

  describe('chunked input', () => {
    it('produces identical output when input arrives one byte at a time', async () => {
      const hvcc = Buffer.from([0x01, 0x02, 0x03]);
      const videoData = makeReolinkVideoData(1, 0, Buffer.from([0x00, 0x00, 0x00]), hvcc);
      const input = Buffer.concat([makeFlvHeader(), makeFlvTag(0x09, videoData)]);

      const reference = await collect(new ReolinkFLVTransform(), [input]);
      const chunked = Array.from({ length: input.length }, (_, i) => input.subarray(i, i + 1));
      const out = await collect(new ReolinkFLVTransform(), chunked);

      expect(out).toEqual(reference);
    });

    it('produces identical output when input arrives in arbitrary two-byte chunks', async () => {
      const ct = Buffer.from([0x00, 0x00, 0x05]);
      const nalus = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const videoData = makeReolinkVideoData(1, 1, ct, nalus);
      const input = Buffer.concat([makeFlvHeader(), makeFlvTag(0x09, videoData)]);

      const reference = await collect(new ReolinkFLVTransform(), [input]);
      const chunked: Buffer[] = [];
      for (let i = 0; i < input.length; i += 2) chunked.push(input.subarray(i, i + 2));
      const out = await collect(new ReolinkFLVTransform(), chunked);

      expect(out).toEqual(reference);
    });
  });

  describe('multiple tags in sequence', () => {
    it('correctly transforms a stream of mixed audio + HEVC video tags', async () => {
      const audioTag = makeFlvTag(0x08, Buffer.from([0xAF, 0x00]));

      const hvcc = Buffer.from([0x01, 0x02]);
      const seqData = makeReolinkVideoData(1, 0, Buffer.from([0x00, 0x00, 0x00]), hvcc);
      const seqTag = makeFlvTag(0x09, seqData);

      const ct = Buffer.from([0x00, 0x00, 0x01]);
      const nalus = Buffer.from([0xAA, 0xBB]);
      const frameData = makeReolinkVideoData(1, 1, ct, nalus);
      const frameTag = makeFlvTag(0x09, frameData);

      const input = Buffer.concat([makeFlvHeader(), audioTag, seqTag, frameTag]);
      const out = await collect(new ReolinkFLVTransform(), [input]);

      // File header is intact
      expect(out.subarray(0, 13)).toEqual(makeFlvHeader());

      // Audio tag is byte-for-byte identical
      const audioEnd = 13 + audioTag.length;
      expect(out.subarray(13, audioEnd)).toEqual(audioTag);

      // SequenceStart: same data size
      const seqDataSizeOut = readDataSize(out, audioEnd);
      expect(seqDataSizeOut).toBe(seqData.length);

      // CodedFrames: data size is 3 bytes larger
      const frameOffset = audioEnd + 11 + seqDataSizeOut + 4;
      const frameDataSizeOut = readDataSize(out, frameOffset);
      expect(frameDataSizeOut).toBe(frameData.length + 3);
    });
  });
});
