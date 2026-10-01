/** Real-archive regression, run by the browser smoke after its normal tile fetch. */
import type { CameraState, City, DialogueCatalog } from '@atlas/shared';
import { dialogueChoices } from '@atlas/shared';
import { openArchive, decodeLifeTiles } from './archive';
import { viewportFor } from '../src/camera';
import { viewTiles } from '../src/tiles';
import { metersPerCssPx, placeGrid } from '../src/grid';
import { cellStep, DEFAULT_CELLS, stepCell } from '../src/density';
import { LifeWorld } from '../src/life/simulate';
import { runLifeFrame } from '../src/life/worker-api';
import { activityLevels } from '../src/life/config';
import { packLife } from '../src/life/draw';
import { mapGlyphs, themes } from '../src/theme';

export async function naturalSpeech(
  city: City,
  catalog: DialogueCatalog,
  camera: CameraState,
  size: { width: number; height: number },
) {
  const archive = await openArchive(city.slug);
  try {
    const h = archive.header;
    const tiles = await decodeLifeTiles(
      archive.archive,
      viewTiles(camera, size, {
        minZoom: h.minZoom,
        maxZoom: h.maxZoom,
        bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat],
      }),
    );
    const world = new LifeWorld(city.traffic, undefined, { dialogue: dialogueChoices(catalog) });
    world.sync(tiles);
    const scheduled = stepCell(DEFAULT_CELLS, cellStep(DEFAULT_CELLS, camera.zoom));
    const w = size.width <= 640 ? Math.max(6, scheduled.width) : scheduled.width;
    const cell = { w, h: Math.round(w * DEFAULT_CELLS.aspect) };
    const cols = Math.ceil(size.width / cell.w) + 2,
      rows = Math.ceil(size.height / cell.h) + 2;
    const { toCell } = placeGrid({ camera, dpr: 1, ...size }, cell, cols, rows);
    const [[west, south], [east, north]] = viewportFor(camera, size).getBounds() as [
      [number, number],
      [number, number],
    ];
    const bounds: [number, number, number, number] = [west, south, east, north];
    const levels = activityLevels(1, { minutes: 720, weekday: 4, life: city.life });
    const owners = new Uint32Array(cols * rows),
      out = new Uint8Array(owners.length * 4);
    const glyphs = ['', ...mapGlyphs(themes.dark)];
    const index = (glyph: string) => glyphs.indexOf(glyph);
    for (let frame = 0; frame < 600; frame++) {
      const { agents } = runLifeFrame(world, {
        gust: { camera, size, cssCell: cell, time: frame / 10, wind: { dir: [1, 0], strength: 0 } },
        step: {
          dt: 0.1,
          zoom: camera.zoom,
          bounds,
          wind: undefined,
          cellMeters: cell.w * metersPerCssPx(camera),
          weather: { rain: 0, minutes: 720, cityLife: city.life },
        },
        visible: [
          camera.zoom,
          levels,
          [camera.lng, camera.lat],
          { rain: 0, sunAltitude: 60 },
          bounds,
        ],
      });
      if (!agents.some((a) => a.speech)) continue;
      packLife(
        out,
        {
          cols,
          rows,
          cellWidth: cell.w,
          cellHeight: cell.h,
          toCell,
          owners,
          allowsGroundCell: world.groundCellGuard(toCell),
        },
        agents,
        themes.dark,
        index,
      );
      for (const owner of owners) {
        const speech = owner ? agents[owner - 1]?.speech : undefined;
        if (speech) return { seconds: (frame + 1) / 10, speech };
      }
    }
    throw new Error('No naturally generated speech retained packed ownership within 60 seconds');
  } finally {
    await archive.close();
  }
}
