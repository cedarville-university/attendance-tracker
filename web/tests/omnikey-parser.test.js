import { describe, it, expect } from 'vitest';
import { parseOmnikeyReport, PAYLOAD_START_OFFSET, MAX_REASONABLE_PAYLOAD } from '../omnikey-parser.js';

/**
 * Builds a DataView shaped like a real OMNIKEY 5427 G2 Custom Report:
 *   byte 0 = version, byte 1 = declared length, byte 2 = unused tag byte,
 *   bytes 3.. = payload, padded with zeros to totalLength.
 */
function buildReport({ version = 6, declaredLength, payload = '', totalLength = 40 }) {
  const bytes = new Uint8Array(totalLength);
  bytes[0] = version;
  bytes[1] = declaredLength;
  bytes[2] = 0;
  for (let i = 0; i < payload.length; i++) {
    bytes[PAYLOAD_START_OFFSET + i] = payload.charCodeAt(i);
  }
  return new DataView(bytes.buffer);
}

describe('parseOmnikeyReport', () => {
  it('parses a valid Custom Report packet into a card code (real-firmware byte offsets)', () => {
    const cardCode = '1234567890';
    const dataView = buildReport({ declaredLength: cardCode.length, payload: cardCode });

    const result = parseOmnikeyReport(1, dataView);

    expect(result.valid).toBe(true);
    expect(result.hasPayload).toBe(true);
    expect(result.trimmedCardCode).toBe(cardCode);
    expect(result.lengthWasImplausible).toBe(false);
    expect(result.declaredLength).toBe(cardCode.length);
    expect(result.version).toBe(6);
  });

  it('marks a report shorter than the length/version header as invalid', () => {
    const dataView = new DataView(new Uint8Array([0x06]).buffer); // only 1 byte

    const result = parseOmnikeyReport(1, dataView);

    expect(result.valid).toBe(false);
    expect(result.hasPayload).toBe(false);
    expect(result.trimmedCardCode).toBe('');
    expect(result.note).toMatch(/too short/i);
  });

  it('treats an empty-length report as structurally valid but data-less (Card In/Out/prestroke)', () => {
    const dataView = buildReport({ declaredLength: 0, payload: '' });

    const result = parseOmnikeyReport(1, dataView);

    expect(result.valid).toBe(true);
    expect(result.hasPayload).toBe(false);
    expect(result.trimmedCardCode).toBe('');
    expect(result.note).toMatch(/card in.*card out/i);
  });

  it('falls back to trailing-zero-trim when the declared length is implausible', () => {
    // Declare a length far larger than what the reader could plausibly send,
    // and larger than the bytes actually available -- must not throw and
    // must recover the real payload via trailing-zero trimming instead.
    const cardCode = 'ABC123';
    const dataView = buildReport({ declaredLength: 255, payload: cardCode, totalLength: 40 });

    const result = parseOmnikeyReport(1, dataView);

    expect(result.valid).toBe(true);
    expect(result.lengthWasImplausible).toBe(true);
    expect(result.trimmedCardCode).toBe(cardCode);
    expect(result.note).toMatch(/implausible|exceeded/i);
  });

  it('never returns a payload longer than MAX_REASONABLE_PAYLOAD even when implausible', () => {
    const dataView = buildReport({ declaredLength: 250, payload: 'X', totalLength: 40 });

    const result = parseOmnikeyReport(1, dataView);

    expect(result.rawPayloadBytes.length).toBeLessThanOrEqual(MAX_REASONABLE_PAYLOAD);
  });

  it('preserves a legitimate embedded zero byte when the declared length is trusted', () => {
    // Build payload bytes manually so a zero byte sits in the middle of a
    // trusted-length span; trailing-zero-trim must NOT run in this branch.
    const totalLength = 40;
    const bytes = new Uint8Array(totalLength);
    bytes[0] = 6;
    bytes[1] = 5; // declared length: trustworthy (fits within available bytes)
    bytes[2] = 0;
    bytes[PAYLOAD_START_OFFSET + 0] = 0x41; // 'A'
    bytes[PAYLOAD_START_OFFSET + 1] = 0x00; // embedded zero -- must be preserved
    bytes[PAYLOAD_START_OFFSET + 2] = 0x42; // 'B'
    bytes[PAYLOAD_START_OFFSET + 3] = 0x43; // 'C'
    bytes[PAYLOAD_START_OFFSET + 4] = 0x44; // 'D'
    const dataView = new DataView(bytes.buffer);

    const result = parseOmnikeyReport(1, dataView);

    expect(result.lengthWasImplausible).toBe(false);
    expect(result.rawPayloadBytes.length).toBe(5);
  });
});
