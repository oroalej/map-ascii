import type { CameraState } from '@atlas/shared';
import { themes, type ThemeName } from './theme';

export type { ThemeName } from './theme';

export type AtlasOptions = {
  tilesUrl: string;
  theme?: ThemeName;
  cell?: { width: number; height: number };
  initialCamera: CameraState;
  year: number;
};

export type AtlasEventMap = {
  camerachange: CameraState;
  hover: { featureId: string | null };
  click: { featureId: string | null };
  flyend: CameraState;
};

export type AtlasEventName = keyof AtlasEventMap;

export type Atlas = {
  setCamera(partial: Partial<CameraState>, opts?: { animate?: boolean }): void;
  setYear(year: number, opts?: { animate?: boolean }): void;
  setTheme(theme: ThemeName): void;
  on<K extends AtlasEventName>(event: K, handler: (payload: AtlasEventMap[K]) => void): () => void;
  destroy(): void;
};

/**
 * Create the ASCII atlas on a canvas. Phase 0 stub: sets up WebGL2 and clears to the
 * theme background. Tiles, cell pass, and glyph pass arrive in Phase 1.
 */
export function createAtlas(canvas: HTMLCanvasElement, options: AtlasOptions): Atlas {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
  if (!gl) {
    throw new Error('ASCII Atlas requires WebGL2, which this browser does not support.');
  }

  let camera: CameraState = { ...options.initialCamera };
  let theme = themes[options.theme ?? 'dark'];
  let destroyed = false;
  const listeners = new Map<AtlasEventName, Set<(payload: never) => void>>();

  const draw = () => {
    if (destroyed) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(...theme.background);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    draw();
  };

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  const emit = <K extends AtlasEventName>(event: K, payload: AtlasEventMap[K]) => {
    for (const handler of listeners.get(event) ?? []) {
      (handler as (p: AtlasEventMap[K]) => void)(payload);
    }
  };

  return {
    setCamera(partial) {
      camera = { ...camera, ...partial };
      emit('camerachange', camera);
      draw();
    },
    setYear() {
      // Phase 4: time filtering.
    },
    setTheme(name) {
      theme = themes[name];
      draw();
    },
    on(event, handler) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => {
        set.delete(handler);
      };
    },
    destroy() {
      destroyed = true;
      observer.disconnect();
      listeners.clear();
    },
  };
}
