import { cropDate } from '@atlas/shared';

/** Capture before URL mirroring removes parameters that aren't view state. */
let requested:
  | {
      enabled: boolean;
      captureMs: number;
      fullUniforms: boolean;
      holdBootShaders: boolean;
      cropDate: string | undefined;
    }
  | undefined;
const debugRequest = () => {
  if (!requested) {
    const query = new URLSearchParams(window.location.search);
    const enabled = query.get('debug') === '1';
    const duration = Number(query.get('captureMs'));
    const crop = query.get('cropDate');
    requested = {
      enabled,
      captureMs: enabled && Number.isFinite(duration) && duration > 0 ? duration : 30_000,
      fullUniforms: query.get('fullUniforms') === '1',
      holdBootShaders: query.get('boot') === '1',
      cropDate: crop !== null && cropDate(crop) ? crop : undefined,
    };
  }
  return requested;
};
export const isDebugRequested = () => debugRequest().enabled;
/** Debug-only: tests shorten captures without putting the duration in view or share URLs. */
export const debugCaptureMs = () => debugRequest().captureMs;
/** For GPU campaigns (`scripts/perf-light.ts`) that override uniform values as they're uploaded. */
export const fullUniformsRequested = () => debugRequest().fullUniforms;
/** For reviewing the boot shaders, which a warm shader cache otherwise never shows. */
export const holdBootShadersRequested = () => debugRequest().holdBootShaders;
/** `MM-DD` for reviewing a crop stage out of season; not view state, so never in share URLs. */
export const cropDateRequested = () => debugRequest().cropDate;
