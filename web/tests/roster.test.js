import { describe, it, expect } from 'vitest';
import {
  parseCsv,
  loadRosterCsv,
  normalizeId,
  buildRosterIndex,
  isExpected,
  getRosterRow,
} from '../roster.js';

describe('parseCsv', () => {
  it('parses a simple CSV into headers and row objects', () => {
    const text = 'id,name\n001,Jane Smith\n002,Alex Lee\n';

    const { headers, rows } = parseCsv(text);

    expect(headers).toEqual(['id', 'name']);
    expect(rows).toEqual([
      { id: '001', name: 'Jane Smith' },
      { id: '002', name: 'Alex Lee' },
    ]);
  });

  it('handles quoted fields containing commas and escaped quotes', () => {
    const text = 'id,name\n001,"Smith, Jane ""J."""\n';

    const { rows } = parseCsv(text);

    expect(rows[0].name).toBe('Smith, Jane "J."');
  });

  it('handles CRLF and bare LF line endings in the same file', () => {
    const text = 'id,name\r\n001,Jane\n002,Alex\r\n';

    const { rows } = parseCsv(text);

    expect(rows).toEqual([
      { id: '001', name: 'Jane' },
      { id: '002', name: 'Alex' },
    ]);
  });

  it('skips blank lines', () => {
    const text = 'id,name\n001,Jane\n\n002,Alex\n';

    const { rows } = parseCsv(text);

    expect(rows).toHaveLength(2);
  });

  it('strips a leading UTF-8 BOM', () => {
    const text = '﻿id,name\n001,Jane\n';

    const { headers } = parseCsv(text);

    expect(headers).toEqual(['id', 'name']);
  });

  it('preserves leading-zero IDs as strings, not numbers', () => {
    const text = 'id,name\n000123,Jane\n';

    const { rows } = parseCsv(text);

    expect(rows[0].id).toBe('000123');
  });

  it('returns empty headers/rows for empty input', () => {
    const { headers, rows } = parseCsv('');

    expect(headers).toEqual([]);
    expect(rows).toEqual([]);
  });
});

describe('loadRosterCsv', () => {
  it('returns a well-formed result for valid CSV text', () => {
    const result = loadRosterCsv('id,name\n001,Jane\n', 'roster.csv');

    expect(result.error).toBeNull();
    expect(result.headers).toEqual(['id', 'name']);
    expect(result.rows).toEqual([{ id: '001', name: 'Jane' }]);
  });

  it('reports an error (without throwing) when the CSV has no header row', () => {
    const result = loadRosterCsv('', 'empty.csv');

    expect(result.error).toMatch(/empty|header/i);
    expect(result.headers).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it('handles a header-variation file (different header casing/naming) as plain columns', () => {
    const result = loadRosterCsv('Student ID,Full Name\n001,Jane\n', 'roster.csv');

    expect(result.error).toBeNull();
    expect(result.headers).toEqual(['Student ID', 'Full Name']);
    expect(result.rows).toEqual([{ 'Student ID': '001', 'Full Name': 'Jane' }]);
  });
});

describe('normalizeId', () => {
  it('preserves leading zeros as a trimmed string', () => {
    expect(normalizeId('000123')).toBe('000123');
    expect(normalizeId('  000123  ')).toBe('000123');
  });

  it('returns an empty string for null/undefined', () => {
    expect(normalizeId(null)).toBe('');
    expect(normalizeId(undefined)).toBe('');
  });
});

describe('buildRosterIndex / isExpected / getRosterRow', () => {
  it('indexes rows by normalized ID and supports duplicate IDs (last wins)', () => {
    const rows = [
      { id: '001', name: 'Jane' },
      { id: '002', name: 'Alex' },
      { id: '001', name: 'Jane Duplicate' },
    ];

    const index = buildRosterIndex(rows, 'id');

    expect(index.size).toBe(2);
    expect(getRosterRow(index, '001')).toEqual({ id: '001', name: 'Jane Duplicate' });
  });

  it('matches on normalized (trimmed, leading-zero-preserving) IDs', () => {
    const rows = [{ id: '000123', name: 'Jane' }];
    const index = buildRosterIndex(rows, 'id');

    expect(isExpected(index, '000123')).toBe(true);
    expect(isExpected(index, ' 000123 ')).toBe(true);
    expect(isExpected(index, '123')).toBe(false);
  });

  it('skips rows with an empty ID', () => {
    const rows = [{ id: '', name: 'No ID' }, { id: '001', name: 'Jane' }];
    const index = buildRosterIndex(rows, 'id');

    expect(index.size).toBe(1);
  });

  it('getRosterRow returns null for an unknown ID', () => {
    const index = buildRosterIndex([{ id: '001', name: 'Jane' }], 'id');

    expect(getRosterRow(index, '999')).toBeNull();
  });
});
