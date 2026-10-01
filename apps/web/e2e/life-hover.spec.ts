import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// Use the existing tsx bundler to load production renderer/tooltip code into a controlled
// browser fixture. No test hooks or synthetic geography are shipped with the application.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx'))('esbuild') as {
  build(this: void, options: object): Promise<{ outputFiles: { path: string; text: string }[] }>;
};
const root = fileURLToPath(new URL('../../../', import.meta.url)).replaceAll('\\', '/');
const renderer = `${root}packages/renderer/src`;
const sources: Record<string, string> = {
  state:
    'export const state = { agents: [], point: [0, 0], time: 0, lifeTime: 0, hover: null, owners: 0 };',
  './tile-cache': `export class TileCache {
    source = { indexOf: () => 0, feature: () => undefined, featureById: () => undefined,
      pendingCount: 0, decodeMsAverage: 0 };
    size = 0;
    tilesToDraw() { return []; } regionTilesFor() { return []; } get() {}
    suspend() {} resume() {} destroy() {}
  }`,
  './life/host': `
    const createHost = () => {
      let clock = 0, view;
      return {
        sync() {}, clearTiles() {},
        request(input) {
          clock += Math.min(0.1, Math.max(0, input.step.dt));
          view = { signalClock: clock, cellGuard: () => undefined, procession: undefined,
            agents: [{ kind: 'vehicle', vehicle: 'car', lng: clock * 0.00001,
              lat: 0, ahead: [clock * 0.00001 + 0.00001, 0], flap: 0 }] };
          return true;
        },
        latest: () => view, setLive() {}, play: () => false, stop() {}, dispose() {}
      };
    };
    export const createInlineHost = createHost, createWorkerHost = createHost;
  `,
  './passes': `
    export * from ${JSON.stringify(`${renderer}/passes.ts`)};
    import { selectPass as select, lifePass as life, glyphPass as glyph, lifeRaster }
      from ${JSON.stringify(`${renderer}/passes.ts`)};
    import { classId } from ${JSON.stringify(`${renderer}/classes.ts`)};
    import { state } from 'state';
    export function selectPass(...args) {
      select(...args);
      const [gl, , targets] = args;
      // Every pointed surface is a road. All actual Life packing, glyph rendering,
      // GPU readback, hover validation and camera input still run unmodified.
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets.glyphFbo);
      gl.clearBufferfv(gl.COLOR, 0, new Float32Array([0, classId('road_mid') / 255, 0, 0]));
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets.sub.fbo);
      gl.clearBufferfv(gl.COLOR, 0, new Float32Array([classId('road_mid') / 255, 0, 0, 0]));
      gl.clearBufferfv(gl.COLOR, 1, new Float32Array(4));
    }
    export function lifePass(...args) {
      const count = life(...args), view = args[4], agents = args[6];
      state.agents = agents.map(({lng, lat, flap}) => ({lng, lat, flap}));
      const raster = lifeRaster(args[1]), owner = raster.owners.findIndex(value => value > 0);
      state.owners = raster.owners.filter(value => value > 0).length;
      if (owner >= 0) {
        const { shiftX, shiftY } = args[5].grid;
        state.point = [
          ((owner % args[1].cols + 0.5) * view.cellDev.w - shiftX) / view.dpr,
          ((Math.floor(owner / args[1].cols) + 0.5) * view.cellDev.h - shiftY) / view.dpr,
        ];
      }
      return count;
    }
    export function glyphPass(...args) {
      state.time = args[8]; state.lifeTime = args[16] ?? args[8];
      return glyph(...args);
    }
  `,
};

test('Life hover holds the character and tooltip, resumes smoothly, and clears on navigation', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const bundle = await build({
    stdin: {
      resolveDir: `${root}apps/web`,
      contents: `
        import { createElement } from 'react';
        import { createRoot } from 'react-dom/client';
        import { createAtlas } from ${JSON.stringify(`${renderer}/index.ts`)};
        import { HoverTooltip } from ${JSON.stringify(`${root}apps/web/components/HoverTooltip.tsx`)};
        import { useUiStore } from ${JSON.stringify(`${root}apps/web/state/ui.ts`)};
        import { state } from 'state';
        const canvas = document.querySelector('canvas');
        const atlas = createAtlas(canvas, { tilesUrl: '/fixture.pmtiles', bounds: [-1,-1,1,1],
          initialCamera: {lat: 0, lng: 0, zoom: 19}, year: 2026, quality: 'high',
          lifeWorker: false, life: {time: 720, wind: 'calm'} });
        atlas.on('lifehover', hover => {
          state.hover = hover;
          useUiStore.setState({lifeHover: hover.label ? hover : null});
        });
        createRoot(document.querySelector('#ui')).render(createElement(HoverTooltip));
        window.fixture = { sample: () => ({...state, camera: atlas.getCamera()}), atlas };
      `,
    },
    bundle: true,
    write: false,
    outfile: 'fixture.js',
    format: 'esm',
    platform: 'browser',
    tsconfig: `${root}apps/web/tsconfig.json`,
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'controlled-life',
        setup(plugin: {
          onResolve(
            options: { filter: RegExp },
            callback: (args: { path: string; importer: string }) => object | undefined,
          ): void;
          onLoad(
            options: { filter: RegExp; namespace: string },
            callback: (args: { path: string }) => object,
          ): void;
        }) {
          plugin.onResolve(
            { filter: /^(state|\.\/tile-cache|\.\/life\/host|\.\/passes)$/ },
            (args) =>
              args.path === 'state' || args.importer.replaceAll('\\', '/').endsWith('/index.ts')
                ? { path: args.path, namespace: 'life-fixture' }
                : undefined,
          );
          plugin.onLoad({ filter: /.*/, namespace: 'life-fixture' }, ({ path }) => ({
            contents: sources[path],
            loader: 'js',
            resolveDir: `${root}apps/web`,
          }));
        },
      },
    ],
  });
  const js = bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
  const css = bundle.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/life-hover-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<style>body{margin:0}canvas{width:96px;height:72px;display:block}${css}</style>
        <canvas tabindex="0" aria-label="Fixture map"></canvas><div id="ui"></div>
        <script type="module" src="/life-hover-fixture.js"></script>`,
    }),
  );
  await page.route('**/life-hover-fixture.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: js }),
  );
  await page.goto('/life-hover-fixture');
  type Sample = {
    agents: { lng: number; lat: number; flap: number }[];
    point: [number, number];
    time: number;
    lifeTime: number;
    camera: { lng: number; lat: number; zoom: number };
  };
  const sample = () =>
    page.evaluate(() => (window as unknown as { fixture: { sample(): Sample } }).fixture.sample());
  await expect.poll(async () => (await sample()).agents.length).toBe(1);
  const { point } = await sample();
  await page.mouse.move(point[0], point[1]);
  const tooltip = page.getByText('Car (simulated)', { exact: true });
  await expect(tooltip, JSON.stringify({ sample: await sample(), errors })).toBeVisible();
  const held = await sample();
  // Poll through multiple visibility renewals rather than using a fixed wall-clock sleep.
  await expect.poll(async () => (await sample()).time - held.time).toBeGreaterThan(1);
  await expect(tooltip).toBeVisible();
  const after = await sample();
  expect(after.agents).toEqual(held.agents);
  expect(after.lifeTime).toBe(held.lifeTime);
  await page.mouse.move(450, 350);
  await expect(tooltip).toHaveCount(0);
  await expect
    .poll(async () => (await sample()).agents[0]!.lng)
    .toBeGreaterThan(held.agents[0]!.lng);
  const resumed = await sample();
  expect(resumed.lifeTime - held.lifeTime).toBeLessThanOrEqual(resumed.time - after.time + 0.1);
  await expect(async () => {
    const moving = await sample();
    await page.mouse.move(moving.point[0], moving.point[1]);
    await expect(tooltip).toBeVisible({ timeout: 750 });
  }).toPass({ timeout: 5000 });
  const next = await sample();
  await page.mouse.wheel(0, -100);
  await expect(tooltip).toHaveCount(0);
  await expect.poll(async () => (await sample()).camera.zoom).toBeGreaterThan(next.camera.zoom);
  expect(errors).toEqual([]);
});
