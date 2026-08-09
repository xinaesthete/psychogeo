import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { runCodecTask, type CodecResult, type CodecTask } from './codecWorker.ts';

/**
 * A pool of `worker_threads` running the codec.
 *
 * The passes call this the same way whatever size it is, including size 0,
 * which runs the task inline on the calling thread. That matters more than it
 * sounds: it means the pool is not a second code path to keep in step, tests do
 * not need to spawn threads, and a build that cannot find its worker file
 * degrades to exactly the behaviour that has already been verified rather than
 * failing.
 */

export interface CodecRunner {
  /** Bring a stored codestream onto a new scale, and re-encode it. */
  run(task: CodecTask): Promise<Uint8Array>;
  close(): Promise<void>;
  /** 0 when running inline. */
  readonly size: number;
}

/**
 * Leave a couple of cores for the main thread, which is doing the reads, and
 * cap the pool because each worker carries its own WASM heap.
 */
export function defaultPoolSize(): number {
  const cores = availableParallelism?.() ?? 4;
  return Math.max(0, Math.min(12, cores - 2));
}

class InlineRunner implements CodecRunner {
  readonly size = 0;
  async run(task: CodecTask): Promise<Uint8Array> {
    return runCodecTask(task);
  }
  async close(): Promise<void> {}
}

type Pending = {
  resolve: (bytes: Uint8Array) => void;
  reject: (error: Error) => void;
};

class WorkerPoolRunner implements CodecRunner {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Array<{ task: CodecTask; pending: Pending }> = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly workerUrl: URL, readonly size: number) {}

  private spawn(): Worker {
    const worker = new Worker(this.workerUrl);
    worker.on('message', (result: CodecResult) => {
      const pending = this.pending.get(result.id);
      this.pending.delete(result.id);
      if (pending) {
        if ('error' in result) pending.reject(new Error(result.error));
        else pending.resolve(result.bytes);
      }
      this.release(worker);
    });
    // A worker that dies takes its in-flight task with it. Fail that task
    // rather than hanging on a reply that will never come; the caller already
    // treats a chunk failure as a hole rather than an abort.
    worker.on('error', (error: unknown) =>
      this.fail(worker, error instanceof Error ? error : new Error(String(error))),
    );
    worker.on('exit', (code) => {
      if (!this.closed && code !== 0) this.fail(worker, new Error(`codec worker exited ${code}`));
    });
    this.workers.push(worker);
    return worker;
  }

  private fail(worker: Worker, error: Error): void {
    for (const [id, pending] of this.pending) {
      if ((worker as unknown as { __taskId?: number }).__taskId === id) {
        this.pending.delete(id);
        pending.reject(error);
      }
    }
    const at = this.workers.indexOf(worker);
    if (at >= 0) this.workers.splice(at, 1);
    const idleAt = this.idle.indexOf(worker);
    if (idleAt >= 0) this.idle.splice(idleAt, 1);
  }

  private release(worker: Worker): void {
    const next = this.queue.shift();
    if (next) {
      this.dispatch(worker, next.task, next.pending);
      return;
    }
    this.idle.push(worker);
  }

  private dispatch(worker: Worker, task: CodecTask, pending: Pending): void {
    this.pending.set(task.id, pending);
    (worker as unknown as { __taskId?: number }).__taskId = task.id;
    const transfer: ArrayBuffer[] =
      task.kind === 'requantise' ? [task.codestream.buffer as ArrayBuffer] : [task.values.buffer as ArrayBuffer];
    worker.postMessage(task, transfer);
  }

  run(task: CodecTask): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new Error('codec pool is closed'));
    const withId = { ...task, id: this.nextId++ } as CodecTask;
    return new Promise<Uint8Array>((resolve, reject) => {
      const pending = { resolve, reject };
      const worker = this.idle.pop() ?? (this.workers.length < this.size ? this.spawn() : undefined);
      if (worker) this.dispatch(worker, withId, pending);
      else this.queue.push({ task: withId, pending });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.workers.map((worker) => worker.terminate()));
    this.workers.length = 0;
    this.idle.length = 0;
  }
}

export type CodecRunnerOptions = {
  /** 0 runs inline. Defaults to `defaultPoolSize()`. */
  readonly size?: number;
  /** The built worker module. Omit to run inline. */
  readonly workerUrl?: URL;
};

export function createCodecRunner(options: CodecRunnerOptions = {}): CodecRunner {
  const size = options.size ?? defaultPoolSize();
  if (size <= 0 || !options.workerUrl) return new InlineRunner();
  try {
    return new WorkerPoolRunner(options.workerUrl, size);
  } catch {
    // No worker file next to a bundled CLI, no threads in this runtime — the
    // pass still runs, just serially.
    return new InlineRunner();
  }
}

/**
 * Run tasks with at most `limit` outstanding, preserving the order of results.
 *
 * Chunks are collected into a shard before it is written, and `writeShard`
 * sorts by slot, so completion order cannot change the bytes on disk. What it
 * would change is memory: without a bound, a whole level's worth of encoded
 * chunks could be in flight at once.
 */
export async function mapWithRunner<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<Uint8Array | undefined>,
): Promise<Array<Uint8Array | undefined>> {
  const out: Array<Uint8Array | undefined> = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        out[index] = await task(items[index], index);
      }
    }),
  );
  return out;
}
