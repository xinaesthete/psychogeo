import { create, globals } from 'webgpu';
import tgpu, { type TgpuRoot } from 'typegpu';

let rootPromise: Promise<TgpuRoot> | undefined;

function ensureNodeWebGpu(): void {
  if (globalThis.navigator?.gpu) return;
  Object.assign(globalThis, globals);
  Object.defineProperty(globalThis, 'navigator', {
    value: { gpu: create([]) },
    configurable: true,
    writable: true,
  });
}

export async function getGpuRoot(): Promise<TgpuRoot> {
  if (!rootPromise) {
    rootPromise = (async () => {
      ensureNodeWebGpu();
      return tgpu.init();
    })();
  }
  return rootPromise;
}
