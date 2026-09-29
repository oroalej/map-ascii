import type { Atlas } from '@atlas/renderer';
import type { CameraState } from '@atlas/shared';
import { create } from 'zustand';

export type AtlasMode = 'map' | 'orbit' | 'walk';
export type Underlay = { kind: 'imagery' | 'historic-map'; id: string };

export type AtlasState = {
  /** The city's slug, from the route. */
  city: string | null;
  /** Null until the URL or the city's meta provides a camera. */
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
  setCity: (city: string) => void;
  /** Set the full camera, e.g. the city's default view. */
  initCamera: (camera: CameraState) => void;
  /** Merge a partial camera update. Ignored until a camera has been set. */
  setCamera: (camera: Partial<CameraState>) => void;
  setYear: (year: number) => void;
  setSelected: (id: string | null) => void;
  setHover: (id: string | null) => void;
};

export const initialAtlasState = (): AtlasState => ({
  city: null,
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
  setCity: (city) => set({ city }),
  initCamera: (camera) => set({ camera }),
  setCamera: (camera) => set((s) => (s.camera ? { camera: { ...s.camera, ...camera } } : {})),
  setYear: (year) => set({ year }),
  setSelected: (selectedId) => set({ selectedId }),
  setHover: (hoverId) => set({ hoverId }),
}));

/**
 * The live renderer, for components that drive it (search, the info panel, the HUD). It is kept
 * apart from `AtlasState`, which holds only plain data that can be mirrored in the URL.
 */
export const useAtlasInstance = create<{ atlas: Atlas | null }>()(() => ({ atlas: null }));
