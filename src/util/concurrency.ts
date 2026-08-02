/**
 * Map over items with at most `limit` calls in flight, preserving input order.
 *
 * Bounded rather than a bare Promise.all: fanning out one request per cell of
 * a national region summary would put thousands of fetches on the origin at
 * once, which is how you turn a slow walk into a denial of service against
 * your own tile server.
 *
 * Rejects with the first error, like Promise.all — in-flight work is allowed
 * to settle but no further items are started.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const lanes = Math.max(1, Math.min(Math.floor(limit), items.length));
  let next = 0;
  let failed = false;

  const runLane = async (): Promise<void> => {
    for (;;) {
      if (failed) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };

  await Promise.all(Array.from({ length: lanes }, runLane));
  return results;
}
