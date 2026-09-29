import type { CameraState } from '@atlas/shared';
import { create } from 'zustand';

export type AtlasMode = 'map' | 'orbit' | 'walk';
export type Underlay = { kind: 'imagery' | 'historic-map'; id: string };

export type AtlasState = {
  /** Null until the city's meta (or, from Phase 2, the URL) provides a camera. */
  camera: CameraState | null;
  mode: AtlasMode;
  year: number;
  timelineOpen: boolean;
  playing: boolean;
  selectedId: string | null;
  hoverId: string | null;
  tour: { id: string; step: number; paused: boolean } | null;
  underlay: Underlay | null;
  theme: 'dark' | 'light';
  cellSize: number;
};

export type AtlasActions = {
  /** Set the full camera, e.g. the city's default view. */
  initCamera: (camera: CameraState) => void;
  /** Merge a partial camera update. Ignored until a camera has been set. */
  setCamera: (camera: Partial<CameraState>) => void;
  setYear: (year: number) => void;
};

export const initialAtlasState = (): AtlasState => ({
  camera: null,
  mode: 'map',
  year: new Date().getFullYear(),
  timelineOpen: false,
  playing: false,
  selectedId: null,
  hoverId: null,
  tour: null,
  underlay: null,
  theme: 'dark',
  cellSize: 10,
});

export const useAtlasStore = create<AtlasState & AtlasActions>()((set) => ({
  ...initialAtlasState(),
  initCamera: (camera) => set({ camera }),
  setCamera: (camera) => set((s) => (s.camera ? { camera: { ...s.camera, ...camera } } : {})),
  setYear: (year) => set({ year }),
}));
