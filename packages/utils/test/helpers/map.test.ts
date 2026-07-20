import { describe, expect, it } from 'bun:test';

import { filterNull, mapObjValues } from '../../src/helpers/map';

describe('mapObjValues', () => {
  it('should transform values while preserving keys', () => {
    const input = { a: 1, b: 2, c: 3 };
    const result = mapObjValues(input, v => v * 2);

    expect(result).toEqual({ a: 2, b: 4, c: 6 });
  });

  it('should pass both value and key to the mapper function', () => {
    const input = { x: 10, y: 20 };
    const result = mapObjValues(input, (v, k) => `${k}:${v}`);

    expect(result).toEqual({ x: 'x:10', y: 'y:20' });
  });

  it('should handle empty objects', () => {
    const result = mapObjValues({}, v => v);

    expect(result).toEqual({});
  });

  it('should transform values to different types', () => {
    const input = { a: 1, b: 2, c: 3 };
    const result = mapObjValues(input, v => String(v));

    expect(result).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('should handle objects with various value types', () => {
    const input = { str: 'hello', num: 42, bool: true };
    const result = mapObjValues(input, v => typeof v);

    expect(result).toEqual({ str: 'string', num: 'number', bool: 'boolean' });
  });

  it('should handle null and undefined values', () => {
    const input = { a: null, b: undefined, c: 0 };
    const result = mapObjValues(input, v => v ?? 'default');

    expect(result).toEqual({ a: 'default', b: 'default', c: 0 });
  });

  it('should handle nested objects as values', () => {
    const input = { a: { x: 1 }, b: { y: 2 } };
    const result = mapObjValues(input, v => ('x' in v ? v.x : v.y));

    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('should handle symbol keys', () => {
    const sym = Symbol('test');
    const input = { [sym]: 10, normal: 20 };
    const result = mapObjValues(input, v => v * 2);

    expect(result[sym]).toBe(20);
    expect(result.normal).toBe(40);
  });

  it('should preserve key order', () => {
    const input = { z: 3, a: 1, m: 2 };
    const result = mapObjValues(input, v => v);

    expect(Object.keys(result)).toEqual(['z', 'a', 'm']);
  });
});

describe('filterNull', () => {
  it('should filter out null values', () => {
    const input = [1, null, 2, null, 3];
    const result = filterNull(input);

    expect(result).toEqual([1, 2, 3]);
  });

  it('should preserve non-null values including falsy ones', () => {
    const input = [0, null, '', null, false, undefined];
    const result = filterNull(input);

    expect(result).toEqual([0, '', false, undefined]);
  });

  it('should handle empty arrays', () => {
    const result = filterNull([]);

    expect(result).toEqual([]);
  });

  it('should handle arrays with no null values', () => {
    const input = [1, 2, 3, 4, 5];
    const result = filterNull(input);

    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  it('should handle arrays with only null values', () => {
    const input = [null, null, null];
    const result = filterNull(input);

    expect(result).toEqual([]);
  });

  it('should handle arrays with objects', () => {
    const obj1 = { id: 1 };
    const obj2 = { id: 2 };
    const input = [obj1, null, obj2, null];
    const result = filterNull(input);

    expect(result).toEqual([obj1, obj2]);
  });

  it('should handle arrays with mixed types', () => {
    const input = ['string', null, 42, null, true, null, { key: 'value' }];
    const result = filterNull(input);

    expect(result).toEqual(['string', 42, true, { key: 'value' }]);
  });

  it('should maintain array type safety', () => {
    const input: (string | null)[] = ['a', null, 'b', null, 'c'];
    const result: string[] = filterNull(input);

    expect(result).toEqual(['a', 'b', 'c']);
  });
});
