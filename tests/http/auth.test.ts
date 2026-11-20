import { describe, expect, it } from 'vitest';
import { parseBearerToken, safeEqual } from '../../src/lib/auth.js';

describe('parseBearerToken', () => {
  it.each([
    ['Bearer abc', 'abc'],
    ['bearer abc', 'abc'], // scheme is case-insensitive (RFC 7235)
    ['Bearer   abc  ', 'abc'],
    [undefined, undefined],
    ['', undefined],
    ['Basic abc', undefined],
    ['Bearer', undefined],
    ['Bearer a b', undefined],
    ['abc', undefined],
  ])('%j → %j', (header, expected) => {
    expect(parseBearerToken(header)).toBe(expected);
  });
});

describe('safeEqual', () => {
  it('compares strings of any length without throwing', () => {
    expect(safeEqual('same-key', 'same-key')).toBe(true);
    expect(safeEqual('same-key', 'other')).toBe(false);
    expect(safeEqual('', 'x'.repeat(1000))).toBe(false);
  });
});
