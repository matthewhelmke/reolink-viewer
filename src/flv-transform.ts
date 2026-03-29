import { Transform } from 'node:stream';

type TransformCallback = (error?: Error | null) => void;

/**
 * Transforms Reolink's proprietary H.265-in-FLV format (video codec ID 12)
 * to the Enhanced FLV format using the 'hvc1' FourCC, which FFmpeg 7+ supports.
 *
 * Reolink encodes HEVC using the old-style FLV video tag header:
 *   byte 0:   (frame_type << 4) | 12   ← codec ID 12 = Reolink HEVC
 *   byte 1:   packet_type  (0=seq hdr, 1=coded frames, 2=end of seq)
 *   bytes 2–4: composition time (24-bit signed, big-endian)
 *   bytes 5+:  HVCC record (seq hdr) or length-prefixed NAL units (coded frames)
 *
 * Enhanced FLV video tag header (IsExVideoHeader bit set):
 *   byte 0:   0x80 | (frame_type << 4) | enhanced_packet_type
 *   bytes 1–4: FourCC  ('hvc1' = 0x68 0x76 0x63 0x31)
 *   [bytes 5–7: composition time — only for CodedFrames (packet_type=1)]
 *   bytes 5+ (or 8+): payload (unchanged)
 *
 * The data payload does not change; only the 5-byte header prefix is rewritten.
 * CodedFrames tags grow by 3 bytes (old packet_type byte is replaced by 4-byte
 * FourCC, and composition time is preserved in-place); DataSize and the following
 * PreviousTagSize are updated accordingly.
 */
export class ReolinkFLVTransform extends Transform {
  private buf = Buffer.alloc(0);
  private headerDone = false;

  _transform(chunk: Buffer, _enc: string, cb: TransformCallback): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    this._drain();
    cb();
  }

  _flush(cb: TransformCallback): void {
    this._drain();
    cb();
  }

  private _drain(): void {
    // Pass through 9-byte FLV file header + 4-byte PreviousTagSize0 unchanged.
    if (!this.headerDone) {
      if (this.buf.length < 13) return;
      this.push(this.buf.slice(0, 13));
      this.buf = this.buf.slice(13);
      this.headerDone = true;
    }

    // Process complete tags: 11-byte tag header + DataSize bytes + 4-byte PreviousTagSize.
    while (this.buf.length >= 15) {
      const dataSize = (this.buf.readUInt8(1) << 16) | (this.buf.readUInt8(2) << 8) | this.buf.readUInt8(3);
      const totalNeeded = 11 + dataSize + 4;
      if (this.buf.length < totalNeeded) break;

      const tagType = this.buf[0];

      if (tagType === 0x09 && dataSize >= 2) {
        const firstByte = this.buf.readUInt8(11);
        const isAlreadyEnhanced = (firstByte >> 7) & 1;
        const codecId = firstByte & 0xF;

        if (!isAlreadyEnhanced && codecId === 12) {
          const tagData = this.buf.slice(11, 11 + dataSize);
          const transformed = this._convertVideoData(firstByte, tagData);
          const newDataSize = transformed.length;

          // Rewrite DataSize in the tag header.
          const newHeader = Buffer.from(this.buf.slice(0, 11));
          newHeader[1] = (newDataSize >> 16) & 0xFF;
          newHeader[2] = (newDataSize >> 8) & 0xFF;
          newHeader[3] = newDataSize & 0xFF;

          // Write updated PreviousTagSize (= 11 header bytes + new data size).
          const prevSize = Buffer.allocUnsafe(4);
          prevSize.writeUInt32BE(11 + newDataSize, 0);

          this.push(newHeader);
          this.push(transformed);
          this.push(prevSize);
          this.buf = this.buf.slice(totalNeeded);
          continue;
        }
      }

      // Non-video or already-enhanced tag: pass through unchanged.
      this.push(this.buf.slice(0, totalNeeded));
      this.buf = this.buf.slice(totalNeeded);
    }
  }

  private _convertVideoData(firstByte: number, data: Buffer): Buffer {
    const frameType  = (firstByte >> 4) & 0xF;
    const packetType = data[1];        // 0=SeqHdr, 1=CodedFrames, 2=EndOfSeq
    const ct         = data.slice(2, 5); // composition time (3 bytes)
    const payload    = data.slice(5);
    const hvc1       = Buffer.from([0x68, 0x76, 0x63, 0x31]); // 'hvc1'

    switch (packetType) {
      case 0: {
        // SequenceStart (decoder config): same total size.
        // Old: [firstByte 1B][0x00 1B][CT 3B][HVCC N B] = 5+N bytes
        // New: [newByte  1B][hvc1  4B][HVCC N B]         = 5+N bytes
        const newByte = 0x80 | (frameType << 4) | 0;
        return Buffer.concat([Buffer.from([newByte]), hvc1, payload]);
      }
      case 1: {
        // CodedFrames: 3 bytes larger (FourCC replaces 1-byte packet_type; CT stays).
        // Old: [firstByte 1B][0x01 1B][CT 3B][NALUs M B] = 5+M bytes
        // New: [newByte  1B][hvc1  4B][CT 3B][NALUs M B] = 8+M bytes
        const newByte = 0x80 | (frameType << 4) | 1;
        return Buffer.concat([Buffer.from([newByte]), hvc1, ct, payload]);
      }
      case 2: {
        // EndOfSequence: same total size.
        // Old: [firstByte 1B][0x02 1B][CT 3B] = 5 bytes
        // New: [newByte  1B][hvc1  4B]         = 5 bytes
        const newByte = 0x80 | (frameType << 4) | 3; // PacketType 3 = SequenceEnd in enhanced
        return Buffer.concat([Buffer.from([newByte]), hvc1]);
      }
      default:
        return data;
    }
  }
}
