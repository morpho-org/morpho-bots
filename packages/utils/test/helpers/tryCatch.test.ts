import { describe, expect, it } from 'bun:test';

import { tryCatch } from '../../src/helpers/tryCatch';

describe('tryCatch', () => {
  describe('synchronous function form', () => {
    it('should return success result with data when function returns', () => {
      const result = tryCatch(() => 42);

      expect(result).toEqual({ data: 42, error: null });
    });

    it('should return failure result with error when function throws', () => {
      const error = new Error('test error');
      const result = tryCatch(() => {
        throw error;
      });

      expect(result.data).toBeNull();
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toBe('test error');
    });

    it('should handle non-Error throws and convert to Error', () => {
      const result = tryCatch(() => {
        throw 'string error';
      });

      expect(result.data).toBeNull();
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toContain('This value was thrown as is');
    });

    it('should handle object throws', () => {
      const result = tryCatch(() => {
        throw { code: 500, message: 'Server error' };
      });

      expect(result.data).toBeNull();
      expect(result.error).toBeInstanceOf(Error);
    });

    it('should handle null and undefined throws', () => {
      const nullResult = tryCatch(() => {
        throw null;
      });
      const undefinedResult = tryCatch(() => {
        throw undefined;
      });

      expect(nullResult.data).toBeNull();
      expect(nullResult.error).toBeInstanceOf(Error);
      expect(undefinedResult.data).toBeNull();
      expect(undefinedResult.error).toBeInstanceOf(Error);
    });

    it('should preserve error properties', () => {
      const error = new Error('test');
      error.cause = 'root cause';
      const result = tryCatch(() => {
        throw error;
      });

      expect(result.error?.cause).toBe('root cause');
    });

    it('should work with different return types', () => {
      const stringResult = tryCatch(() => 'hello');
      const arrayResult = tryCatch(() => [1, 2, 3]);
      const objectResult = tryCatch(() => ({ key: 'value' }));
      const nullResult = tryCatch(() => null);

      expect(stringResult.data).toBe('hello');
      expect(arrayResult.data).toEqual([1, 2, 3]);
      expect(objectResult.data).toEqual({ key: 'value' });
      expect(nullResult.data).toBeNull();
    });
  });

  describe('promise form', () => {
    it('should return success result with data when promise resolves', async () => {
      const result = await tryCatch(Promise.resolve(42));

      expect(result).toEqual({ data: 42, error: null });
    });

    it('should return failure result with error when promise rejects', async () => {
      const error = new Error('test error');
      const result = await tryCatch(Promise.reject(error));

      expect(result.data).toBeNull();
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toBe('test error');
    });

    it('should handle non-Error rejections and convert to Error', async () => {
      const result = await tryCatch(Promise.reject('string error'));

      expect(result.data).toBeNull();
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toContain('This value was thrown as is');
    });

    it('should handle object rejections', async () => {
      const result = await tryCatch(Promise.reject({ code: 500, message: 'Server error' }));

      expect(result.data).toBeNull();
      expect(result.error).toBeInstanceOf(Error);
    });

    it('should handle null and undefined rejections', async () => {
      const nullResult = await tryCatch(Promise.reject(null));
      const undefinedResult = await tryCatch(Promise.reject(undefined));

      expect(nullResult.data).toBeNull();
      expect(nullResult.error).toBeInstanceOf(Error);
      expect(undefinedResult.data).toBeNull();
      expect(undefinedResult.error).toBeInstanceOf(Error);
    });

    it('should preserve error properties', async () => {
      const error = new Error('test');
      error.cause = 'root cause';
      const result = await tryCatch(Promise.reject(error));

      expect(result.error?.cause).toBe('root cause');
    });

    it('should work with different data types', async () => {
      const stringResult = await tryCatch(Promise.resolve('hello'));
      const arrayResult = await tryCatch(Promise.resolve([1, 2, 3]));
      const objectResult = await tryCatch(Promise.resolve({ key: 'value' }));
      const nullResult = await tryCatch(Promise.resolve(null));

      expect(stringResult.data).toBe('hello');
      expect(arrayResult.data).toEqual([1, 2, 3]);
      expect(objectResult.data).toEqual({ key: 'value' });
      expect(nullResult.data).toBeNull();
    });
  });

  describe('custom error types', () => {
    class CustomError extends Error {
      code: number;
      constructor(message: string, code: number) {
        super(message);
        this.code = code;
      }
    }

    it('should preserve custom error type in sync form', () => {
      const result = tryCatch<never, CustomError>(() => {
        throw new CustomError('custom', 42);
      });

      expect(result.error).toBeInstanceOf(CustomError);
      expect((result.error as CustomError).code).toBe(42);
    });

    it('should preserve custom error type in async form', async () => {
      const result = await tryCatch<never, CustomError>(
        Promise.reject(new CustomError('async', 99))
      );

      expect(result.error).toBeInstanceOf(CustomError);
      expect((result.error as CustomError).code).toBe(99);
    });
  });

  describe('tryCatchCapture pattern (sync → Result wrapping)', () => {
    it('should return data from sync callback via Result', () => {
      const result = tryCatch(() => {
        const a = 1;
        const b = 2;
        return a + b;
      });

      expect(result.data).toBe(3);
      expect(result.error).toBeNull();
    });

    it('should capture error from sync callback and allow post-check', () => {
      const result = tryCatch(() => {
        throw new Error('sync failure');
      });

      // This is the pattern tryCatchCapture uses: check error, then act
      if (result.error) {
        expect(result.error.message).toBe('sync failure');
        expect(result.data).toBeNull();
      }
    });

    it('should capture error from async promise and allow post-check', async () => {
      const result = await tryCatch(Promise.reject(new Error('async failure')));

      if (result.error) {
        expect(result.error.message).toBe('async failure');
        expect(result.data).toBeNull();
      }
    });

    it('should return void result from sync side-effect callback', () => {
      let sideEffect = false;
      const result = tryCatch(() => {
        sideEffect = true;
      });

      expect(sideEffect).toBe(true);
      expect(result.error).toBeNull();
    });
  });
});
