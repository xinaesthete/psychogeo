import { monitor, useControls } from 'leva';
import {
  formatCompressionLoadStatus,
  getCompressionLoadStatus,
  syncCompressionExperiment,
} from './compressionExperiment';

/**
 * Leva Compression folder: enable experiment (shows HTML analysis panel) + recode progress.
 * Uses `onEnabledChange` because Leva return values alone do not re-render the app tree.
 */
export function useCompressionLevaControls(onEnabledChange: (enabled: boolean) => void): void {
  useControls(
    'Compression',
    {
      enabled: {
        value: false,
        label: 'experiment (shader)',
        onChange: (v: boolean) => {
          onEnabledChange(v);
          syncCompressionExperiment(v);
        },
      },
      'lossy recode': monitor(
        () => formatCompressionLoadStatus(getCompressionLoadStatus()),
        { graph: false, interval: 200 },
      ),
    },
    { collapsed: false },
  );
}
