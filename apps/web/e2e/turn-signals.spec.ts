import { expect, test } from '@playwright/test';
import { classId, MAX_CLASSES } from '../../../packages/renderer/src/classes';
import { cellBits, CellBit } from '../../../packages/renderer/src/life/config';
import { packLife } from '../../../packages/renderer/src/life/draw';
import {
  SIGNAL_VEHICLES,
  TURN_SIGNAL_BIT,
  TURN_SIGNAL_COLOR,
} from '../../../packages/renderer/src/life/turn-signals';
import { Paint, VehiclePart } from '../../../packages/renderer/src/life/vehicles';
import { BRAKE_COLOR, BRAKE_LAMP } from '../../../packages/renderer/src/life/lamps';
import { PersonPart } from '../../../packages/renderer/src/life/people';
import { fullscreenVertex } from '../../../packages/renderer/src/shaders/fullscreen';
import { glyphFragment } from '../../../packages/renderer/src/shaders/glyph';
import { mapGlyphs, themes } from '../../../packages/renderer/src/theme';
import { themeUniforms } from '../../../packages/renderer/src/theme-uniforms';

test('vehicle turn signals render amber by day and night and retain terrain, canopy and label masks', async ({
  page,
}, testInfo) => {
  for (const name of ['dark', 'light'] as const) {
    const theme = themes[name];
    const glyphs = [' ', ...mapGlyphs(theme).filter((g) => g !== ' ')];
    const block = glyphs.indexOf('█');
    // A controlled detailed fleet for visual QA, independent of live city traffic and timing.
    const cols = 384,
      rows = 90,
      cw = 6,
      ch = 9;
    const fleet = new Uint8Array(cols * rows * 4);
    const fleetAgents = SIGNAL_VEHICLES.flatMap((vehicle, i) =>
      [0, 1, 2, 3].map((row) => {
        const x = 32 + i * 64,
          y = 12 + row * 22,
          dx = row === 0 ? 1 : -1;
        return {
          kind: 'vehicle' as const,
          vehicle,
          paint: Paint.silver,
          lng: x,
          lat: y,
          ahead: [x + dx * 5.5, y] as [number, number],
          side: [x, y + (dx * 33) / ch] as [number, number],
          flap: 0,
          turnSignal:
            row < 2
              ? { side: row === 0 ? ('left' as const) : ('right' as const), on: true }
              : undefined,
          lamps:
            row === 2
              ? { kind: 'hazard' as const, on: true }
              : row === 3
                ? { kind: 'brake' as const }
                : undefined,
        };
      }),
    );
    packLife(
      fleet,
      {
        cols,
        rows,
        cellWidth: cw,
        cellHeight: ch,
        toCell: (x, y) => [x, y],
      },
      fleetAgents,
      theme,
      (glyph) => glyphs.indexOf(glyph),
    );
    const fleetOff = new Uint8Array(fleet.length);
    packLife(
      fleetOff,
      { cols, rows, cellWidth: cw, cellHeight: ch, toCell: (x, y) => [x, y] },
      fleetAgents.map((a) =>
        a.lamps?.kind === 'hazard' ? { ...a, lamps: { kind: 'hazard', on: false } } : a,
      ),
      theme,
      (glyph) => glyphs.indexOf(glyph),
    );
    const hazardCells = SIGNAL_VEHICLES.map((_, i) => {
      const cells: { col: number; row: number; front: boolean; left: boolean }[] = [];
      for (let row = 45; row < 67; row++)
        for (let col = i * 64; col < (i + 1) * 64; col++) {
          const at = (row * cols + col) * 4;
          if (fleet[at + 2]! & TURN_SIGNAL_BIT) {
            cells.push({ col, row, front: col < 32 + i * 64, left: row >= 56 });
            expect(fleetOff[at + 2]! & TURN_SIGNAL_BIT).toBe(0);
            // Corner selection can reuse a body cell. Off restores its original vehicle part.
            expect((fleetOff[at + 3]! >> 4) & 7).toBeLessThan(VehiclePart.mini);
          }
        }
      expect(cells).toHaveLength(4);
      expect(new Set(cells.map((c) => `${c.front}/${c.left}`)).size).toBe(4);
      return cells;
    });
    const result = await page.evaluate(
      (input) => {
        const canvas = document.createElement('canvas');
        document.body.replaceChildren(canvas);
        document.body.style.margin = '0';
        const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true })!;
        if (!gl) throw new Error('WebGL2 unavailable');
        const program = gl.createProgram();
        for (const [type, source] of [
          [gl.VERTEX_SHADER, input.vertex],
          [gl.FRAGMENT_SHADER, input.fragment],
        ] as const) {
          const shader = gl.createShader(type)!;
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
            throw new Error(gl.getShaderInfoLog(shader)!);
          gl.attachShader(program, shader);
        }
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS))
          throw new Error(gl.getProgramInfoLog(program)!);
        gl.useProgram(program);
        gl.bindVertexArray(gl.createVertexArray());
        const texture = (w: number, h: number, data: Uint8Array, channels = 4) => {
          const tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            channels === 1 ? gl.R8 : gl.RGBA8,
            w,
            h,
            0,
            channels === 1 ? gl.RED : gl.RGBA,
            gl.UNSIGNED_BYTE,
            data,
          );
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          return tex;
        };
        const blank = texture(1, 1, new Uint8Array(4));
        type Value = number | readonly number[] | WebGLTexture;
        const uniforms = (values: Record<string, Value>) => {
          let unit = 0;
          for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++) {
            const info = gl.getActiveUniform(program, i)!;
            const loc = gl.getUniformLocation(program, info.name);
            const value = values[info.name.replace(/\[0\]$/, '')];
            if (info.type === gl.SAMPLER_2D) {
              gl.activeTexture(gl.TEXTURE0 + unit);
              gl.bindTexture(gl.TEXTURE_2D, value instanceof WebGLTexture ? value : blank);
              gl.uniform1i(loc, unit++);
            } else if (value !== undefined) {
              const a = typeof value === 'number' ? [value] : (value as number[]);
              if (info.type === gl.FLOAT) gl.uniform1fv(loc, a);
              else if (info.type === gl.FLOAT_VEC2) gl.uniform2fv(loc, a);
              else if (info.type === gl.FLOAT_VEC3) gl.uniform3fv(loc, a);
              else if (info.type === gl.INT_VEC2) gl.uniform2iv(loc, a);
              else if (info.type === gl.INT_VEC3) gl.uniform3iv(loc, a);
              else gl.uniform1iv(loc, a);
            }
          }
        };
        // Deterministic ordinary glyph ink isolates shader behavior from font antialiasing.
        const ink = new Uint8Array(input.glyphs.length * input.cw * input.ch);
        input.glyphs.forEach((glyph, slot) => {
          for (let y = 0; y < input.ch; y++)
            for (let x = 0; x < input.cw; x++)
              ink[y * input.glyphs.length * input.cw + slot * input.cw + x] =
                glyph === ' ' ? 0 : glyph === '▓' ? 210 : glyph === '▒' ? 160 : 255;
        });
        const atlas = texture(input.glyphs.length * input.cw, input.ch, ink, 1);
        const colors = new Array<number>(input.maxClasses * 3).fill(0);
        colors[input.crown * 3 + 1] = 0.8;
        colors[input.roof * 3 + 2] = 0.8;
        colors[input.grounds * 3 + 2] = 0.8;
        const common = {
          u_atlas: atlas,
          u_cell: [input.cw, input.ch],
          u_columns: input.glyphs.length,
          u_labelCell: [input.cw, input.ch],
          u_labelColumns: input.glyphs.length,
          u_labelAtlas: atlas,
          u_labelColor: [0, 0, 1],
          u_background: input.background,
          u_colors: colors,
          u_fillColors: colors,
          u_cellBits: input.bits,
          u_paints: input.paints,
          u_crownClass: input.crown,
          u_crownSun: [0, 0, 1],
          u_vehicle: input.vehicle,
          u_vehicleOccluders: input.occluders,
          u_boat: input.boat,
          u_train: input.train,
          u_person: input.person,
          u_bird: input.bird,
        };
        const n = 21;
        canvas.width = n * input.cw;
        canvas.height = input.ch;
        const selected = new Uint8Array(n * 4),
          life = new Uint8Array(n * 4);
        const sub = new Uint8Array(n * 2 * 3 * 4),
          overlay = new Uint8Array(n * 4);
        for (let x = 0; x < n; x++) {
          const cls =
            x === 3 || x === 19
              ? input.roof
              : x === 4 || x === 9
                ? input.grounds
                : x === 5 || x === 6 || x === 18
                  ? input.crown
                  : input.road;
          selected.set([input.block & 255, cls | ((input.block >> 8) << 6), 0, 0], x * 4);
          const part =
            x >= 15
              ? input.puff
              : x === 10
                ? input.head
                : x === 11 || x >= 12
                  ? input.tail
                  : input.body;
          life.set(
            [
              input.block & 255,
              (x >= 15 ? input.person : input.vehicle) | ((input.block >> 8) << 6),
              x === 9
                ? input.indicator
                : input.vehicleBit | (x === 1 || x >= 10 ? 0 : input.indicator),
              (part << 4) |
                (x === 8 || x === 14 ? 128 : 0) |
                (x === 13 || x === 14
                  ? input.brake
                  : x === 12
                    ? 2
                    : x === 16
                      ? 7
                      : x === 17
                        ? 8
                        : 0),
            ],
            x * 4,
          );
          for (let y = 0; y < 3; y++)
            for (let sx = 0; sx < 2; sx++)
              sub[(y * n * 2 + x * 2 + sx) * 4] = x === 6 && sx === 0 ? input.road : cls;
        }
        overlay.set([(input.block + 1) & 255, (input.block + 1) >> 8, 0, 0], 7 * 4);
        overlay.set([(input.block + 1) & 255, (input.block + 1) >> 8, 0, 0], 20 * 4);
        const selectedTex = texture(n, 1, selected),
          lifeTex = texture(n, 1, life);
        const subTex = texture(n * 2, 3, sub),
          overlayTex = texture(n, 1, overlay);
        const render = (daylight: number) => {
          gl.viewport(0, 0, canvas.width, canvas.height);
          uniforms({
            ...common,
            u_height: canvas.height,
            u_glyphs: selectedTex,
            u_life: lifeTex,
            u_subClass: subTex,
            u_overlay: overlayTex,
            u_daylight: daylight,
          });
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          const pixels = new Uint8Array(canvas.width * canvas.height * 4);
          gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const pixel = (x: number, offset = 1) =>
            Array.from(pixels.slice((x * input.cw + offset) * 4, (x * input.cw + offset) * 4 + 3));
          return {
            cells: Array.from({ length: n }, (_, x) => pixel(x)),
            crownEdge: pixel(6, input.cw - 1),
          };
        };
        const day = render(1),
          night = render(0);
        life[2] = input.vehicleBit;
        gl.bindTexture(gl.TEXTURE_2D, lifeTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n, 1, gl.RGBA, gl.UNSIGNED_BYTE, life);
        const off = render(1).cells[0];
        // Finish on the fleet so screenshots inspect real packLife output in both themes.
        canvas.width = input.cols * input.cw;
        canvas.height = input.rows * input.ch;
        canvas.style.width = `${canvas.width / 2}px`;
        canvas.style.height = `${canvas.height / 2}px`;
        const fleetGround = new Uint8Array(input.cols * input.rows * 4);
        for (let i = 0; i < fleetGround.length; i += 4) fleetGround[i + 1] = input.road;
        const fleetSelected = texture(input.cols, input.rows, fleetGround);
        const fleetLife = texture(input.cols, input.rows, new Uint8Array(input.fleet));
        gl.viewport(0, 0, canvas.width, canvas.height);
        uniforms({
          ...common,
          u_height: canvas.height,
          u_glyphs: fleetSelected,
          u_life: fleetLife,
          u_daylight: 1,
          u_overlay: blank,
        });
        const fleetHazards = (daylight: number, offPhase = false) => {
          if (offPhase) {
            gl.bindTexture(gl.TEXTURE_2D, fleetLife);
            gl.texSubImage2D(
              gl.TEXTURE_2D,
              0,
              0,
              0,
              input.cols,
              input.rows,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              new Uint8Array(input.fleetOff),
            );
          }
          uniforms({
            ...common,
            u_height: canvas.height,
            u_glyphs: fleetSelected,
            u_life: fleetLife,
            u_daylight: daylight,
            u_overlay: blank,
          });
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          return input.hazardCells.map((cells) =>
            cells.map(({ col, row }) => {
              const pixels = new Uint8Array(input.cw * input.ch * 4);
              gl.readPixels(
                col * input.cw,
                canvas.height - (row + 1) * input.ch,
                input.cw,
                input.ch,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                pixels,
              );
              for (let at = 0; at < pixels.length; at += 4)
                if (input.amber.every((c, i) => Math.abs(pixels[at + i]! - c) <= 1)) return true;
              return false;
            }),
          );
        };
        const hazardDay = fleetHazards(1),
          hazardNight = fleetHazards(0),
          hazardOff = fleetHazards(1, true);
        gl.bindTexture(gl.TEXTURE_2D, fleetLife);
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          input.cols,
          input.rows,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          new Uint8Array(input.fleet),
        );
        fleetHazards(1);
        if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL error');
        return { day, night, off, hazardDay, hazardNight, hazardOff };
      },
      {
        vertex: fullscreenVertex,
        fragment: glyphFragment,
        maxClasses: MAX_CLASSES,
        glyphs,
        block,
        cw,
        ch,
        cols,
        rows,
        fleet: Array.from(fleet),
        fleetOff: Array.from(fleetOff),
        hazardCells,
        amber: TURN_SIGNAL_COLOR.map((c) => Math.round(c * 255)),
        paints: themeUniforms(theme).paints,
        background: theme.background.slice(0, 3),
        bits: Array.from(cellBits()),
        road: classId('road_major'),
        roof: classId('building'),
        grounds: classId('building_religious'),
        crown: classId('tree_crown'),
        vehicle: classId('life_vehicle'),
        boat: classId('life_boat'),
        train: classId('life_train'),
        person: classId('life_person'),
        bird: classId('life_bird'),
        occluders: [classId('tree'), classId('tree_crown'), classId('trees')],
        vehicleBit: CellBit.vehicle | CellBit.person,
        indicator: TURN_SIGNAL_BIT,
        body: VehiclePart.body,
        head: VehiclePart.headlight,
        tail: VehiclePart.taillight,
        puff: PersonPart.puff,
        brake: BRAKE_LAMP,
      },
    );
    const amber = TURN_SIGNAL_COLOR.map((c) => Math.round(c * 255));
    for (const cells of [...result.hazardDay, ...result.hazardNight])
      expect(cells).toEqual([true, true, true, true]);
    for (const cells of result.hazardOff) expect(cells).toEqual([false, false, false, false]);
    for (const frame of [result.day, result.night]) {
      for (const x of [0, 2, 6])
        frame.cells[x]!.forEach((c, i) => expect(Math.abs(c - amber[i]!)).toBeLessThanOrEqual(1));
      for (const x of [1, 3, 4, 5, 7, 8, 9, 10, 11]) expect(frame.cells[x]).not.toEqual(amber);
      expect(frame.crownEdge).not.toEqual(amber);
      expect(frame.cells[7]).toEqual([0, 0, 255]);
      expect(frame.cells[13]![1]).toBeGreaterThan(frame.cells[12]![1]!);
      expect(frame.cells[13]).not.toEqual(frame.cells[14]);
      expect(frame.cells[16]).toEqual(theme.background.slice(0, 3).map((c) => Math.round(c * 255)));
      expect(frame.cells[17]![2]).toBeGreaterThan(frame.cells[15]![2]!);
      expect(frame.cells[18]).not.toEqual(frame.cells[15]);
      expect(frame.cells[19]).not.toEqual(frame.cells[15]);
      expect(frame.cells[20]).toEqual([0, 0, 255]);
    }
    result.night.cells[13]!.forEach((c, i) =>
      expect(
        Math.abs(c - Math.round(Math.min(1, BRAKE_COLOR.night[i]! * BRAKE_COLOR.glow) * 255)),
      ).toBeLessThanOrEqual(1),
    );
    expect(result.off).toEqual(result.day.cells[1]);
    await page
      .locator('canvas')
      .screenshot({ path: testInfo.outputPath(`turn-signals-${name}.png`) });
  }
});
