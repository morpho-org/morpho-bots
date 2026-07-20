import { describe, expect, it } from 'bun:test';

import { deepFreeze } from '../../src/helpers/deepFreeze';

describe('deepFreeze', () => {
  it('should freeze simple objects and prevent mutations', () => {
    const obj = { a: 1, b: 2, c: 3 };
    const frozen = deepFreeze(obj);

    expect(frozen).toBe(obj);
    expect(Object.isFrozen(frozen)).toBe(true);

    // Should prevent mutations
    expect(() => {
      (frozen as any).a = 12;
    }).toThrow();

    expect(frozen.a).toBe(1);
  });

  it('should deeply freeze nested objects, arrays, and preserve functions', () => {
    const obj = {
      nested: { value: 'test' },
      arr: [1, { inner: 'value' }],
      callback: () => 'hello',
      requests: [
        { label: 'Sign', sign: () => Promise.resolve('0x123') },
        { label: 'Call', getCall: () => ({ to: '0xabc', data: '0x456' }) }
      ]
    };

    const frozen = deepFreeze(obj);

    // All levels should be frozen
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.nested)).toBe(true);
    expect(Object.isFrozen(frozen.arr)).toBe(true);
    expect(Object.isFrozen(frozen.arr[1])).toBe(true);
    expect(Object.isFrozen(frozen.requests)).toBe(true);
    expect(Object.isFrozen(frozen.requests[0])).toBe(true);

    // Functions should still work
    expect(frozen.callback()).toBe('hello');
    expect(typeof frozen.requests[0]!.sign).toBe('function');
    expect(frozen.requests[1]!.getCall!()).toEqual({ to: '0xabc', data: '0x456' });

    // Mutations should be prevented
    expect(() => {
      (frozen.nested as any).value = 'changed';
    }).toThrow();

    expect(() => {
      frozen.arr.push(4);
    }).toThrow();

    expect(() => {
      (frozen.arr[1] as any).inner = 'changed';
    }).toThrow();

    expect(() => {
      frozen.requests.push({ label: 'New', sign: () => Promise.resolve('0x789') });
    }).toThrow();

    expect(() => {
      frozen.requests[1]!.getCall = () => ({ to: '0x00', data: '0x00' });
    }).toThrow();
  });

  it('should handle circular references without infinite recursion', () => {
    const obj: any = { a: 1, b: 'test' };
    obj.self = obj;
    obj.nested = { parent: obj };

    const frozen = deepFreeze(obj);

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.nested)).toBe(true);
    expect(frozen.self).toBe(frozen);
    expect(frozen.nested.parent).toBe(frozen);

    // Should still prevent mutations
    expect(() => {
      frozen.a = 999;
    }).toThrow();
  });
});
