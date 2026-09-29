import type { CameraState } from '@atlas/shared';
import { create } from 'zustand';

export type AtlasMode = 'map' | 'orbit' | 'walk';
export type Underlay = { kind: 'imagery' | 'historic-map'; id: string };

export type AtlasState = {
  camera: CameraState;
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
  setCamera: (camera: Partial<CameraState>) => void;
  setYear: (year: number) => void;
};

/** Initial view: Naga City, top-down. URL sync arrives in Phase 2. */
export const initialAtlasState = (): AtlasState => ({
  camera: { lat: 13.6218, lng: 123.1948, zoom: 13, pitch: 0, bearing: 0 },
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
  setCamera: (camera) => set((s) => ({ camera: { ...s.camera, ...camera } })),
  setYear: (year) => set({ year }),
}));
