import { describe, it, expect } from 'vitest';

import { formatLocalTime } from '../time-format.js';

describe('formatLocalTime', () => {
  it('formats a real ISO timestamp in the viewer’s locale', () => {
    const out = formatLocalTime('2026-08-26T10:00:00.000Z');
    expect(out).not.toBe('—');
    expect(out).toContain('2026');
  });

  // Manual corrections and system_absence rows are stored with scannedAt null
  // (spec §26); serverRecordToRow maps that to ''. Date('') is an Invalid Date
  // whose toLocaleString() returns the literal "Invalid Date" without throwing,
  // which is what leaked into the attendance pane's Time column.
  it('renders a record with no scan time as the empty-value dash, never "Invalid Date"', () => {
    for (const missing of ['', null, undefined]) {
      expect(formatLocalTime(missing)).toBe('—');
    }
  });

  it('renders an unparseable timestamp as the empty-value dash', () => {
    expect(formatLocalTime('not-a-timestamp')).toBe('—');
  });
});
