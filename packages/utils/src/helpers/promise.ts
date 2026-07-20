/**
 * Resolves all promises, returning only the fulfilled values.
 * Optionally calls `onRejected` for each rejected promise with the reason and index.
 */
export async function allFulfilled<T>(
  promises: Promise<T>[],
  onRejected?: (reason: unknown, index: number) => void
): Promise<T[]> {
  const results = await Promise.allSettled(promises);

  const fulfilled: T[] = [];
  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      fulfilled.push(result.value);
    } else if (onRejected) {
      onRejected(result.reason, i);
    }
  }
  return fulfilled;
}
