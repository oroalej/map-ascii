import { expect, test } from '@playwright/test';
import { LIFE_FOCUS_BIT } from '../../../packages/renderer/src/focus';
import { classId, MAX_CLASSES } from '../../../packages/renderer/src/classes';
import { cellBits, CellBit } from '../../../packages/renderer/src/life/config';
import {
  TURN_SIGNAL_BIT,
  TURN_SIGNAL_COLOR,
} from '../../../packages/renderer/src/life/turn-signals';
import { VehiclePart } from '../../../packages/renderer/src/life/vehicles';
import { BRAKE_COLOR, BRAKE_LAMP, BRAKE_GLOW } from '../../../packages/renderer/src/life/lamps';
import { LampState, lightByte } from '../../../packages/renderer/src/life/lights';
import { PersonPart } from '../../../packages/renderer/src/life/people';
import { fullscreenVertex } from '../../../packages/renderer/src/shaders/fullscreen';
import { glyphFragmentFor } from '../../../packages/renderer/src/shaders/glyph';
import { mapGlyphs, themes } from '../../../packages/renderer/src/theme';
import { themeUniforms } from '../../../packages/renderer/src/theme-uniforms';
import { cellHash } from '../../../packages/renderer/src/glyphs/select';

test('vehicle lamps and exhaust render by day and night with terrain, canopy and label masks', async ({
  page,
}) => {
  for (const name of ['dark', 'light'] as const) {
    const theme = themes[name];
    const glyphs = [' ', ...mapGlyphs(theme).filter((g) => g !== ' ')];
    const block = glyphs.indexOf('█');
    const cw = 6,
      ch = 9;
    // Guarantee a moon glint in the water receiver: red spill must preserve it.
    let glintOrigin = 0;
    while ((cellHash(glintOrigin + 23, 0) & 1023) >= 40) glintOrigin++;
    const result = await page.evaluate(
      (input) => {
        const canvas = document.createElement('canvas');
        document.body.replaceChildren(canvas);
        document.body.style.margin = '0';
        const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true })!;
        if (!gl) throw new Error('WebGL2 unavailable');
        const buildProgram = (fragment: string) => {
          const program = gl.createProgram();
          for (const [type, source] of [
            [gl.VERTEX_SHADER, input.vertex],
            [gl.FRAGMENT_SHADER, fragment],
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
          return program;
        };
        const variants = new Map<number, WebGLProgram>();
        let program = buildProgram(input.fragments[0]!);
        variants.set(0, program);
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
          const key = values.u_focus ? 1 : 0;
          if (!variants.has(key)) variants.set(key, buildProgram(input.fragments[key]!));
          program = variants.get(key)!;
          gl.useProgram(program);
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
              else if (info.type === gl.UNSIGNED_INT_VEC2) gl.uniform2uiv(loc, a);
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
          u_accent: [0.2, 0.8, 1],
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
          u_lampShow: 1,
          u_origin: [input.glintOrigin, 0],
          u_moon: 1,
          u_shimmer: 0,
        };
        const n = 31;
        let activeLight: WebGLTexture | null = null;
        canvas.width = n * input.cw;
        canvas.height = input.ch;
        const selected = new Uint8Array(n * 4),
          life = new Uint8Array(n * 4);
        const sub = new Uint8Array(n * 2 * 3 * 4),
          overlay = new Uint8Array(n * 4);
        for (let x = 0; x < n; x++) {
          const cls =
            x === 3 || x === 19 || x === 22
              ? input.roof
              : x === 23
                ? input.water
                : x === 4 || x === 9
                  ? input.grounds
                  : x === 5 || x === 6 || x === 18 || x === 24 || x === 29
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
          if (x >= 21) {
            selected[x * 4] = 0;
            selected[x * 4 + 1] = cls;
            // Real filled roads reconstruct their background after foreground lighting.
            selected[x * 4 + 3] = cls;
            life.fill(0, x * 4, x * 4 + 4);
            if (x >= 26 && x <= 28) {
              const lamp = x === 26 ? input.head : x === 27 ? input.tail : input.body;
              life.set(
                [
                  input.block & 255,
                  input.vehicle | ((input.block >> 8) << 6),
                  input.vehicleBit | (x === 28 ? input.indicator : 0),
                  (lamp << 4) | (x === 27 ? input.brake : 0),
                ],
                x * 4,
              );
            }
            for (let y = 0; y < 3; y++)
              for (let sx = 0; sx < 2; sx++)
                sub[(y * n * 2 + x * 2 + sx) * 4] =
                  x === 30 ? input.roof : x === 29 && sx === 0 ? input.road : cls;
          }
        }
        overlay.set([(input.block + 1) & 255, (input.block + 1) >> 8, 0, 0], 7 * 4);
        overlay.set([(input.block + 1) & 255, (input.block + 1) >> 8, 0, 0], 20 * 4);
        overlay.set([(input.block + 1) & 255, (input.block + 1) >> 8, 0, 0], 25 * 4);
        const selectedTex = texture(n, 1, selected),
          lifeTex = texture(n, 1, life);
        const subTex = texture(n * 2, 3, sub),
          overlayTex = texture(n, 1, overlay);
        const render = (daylight: number, focused = false, mapFocus = false) => {
          gl.viewport(0, 0, canvas.width, canvas.height);
          uniforms({
            ...common,
            u_height: canvas.height,
            u_glyphs: selectedTex,
            u_life: lifeTex,
            u_subClass: subTex,
            u_overlay: overlayTex,
            u_daylight: daylight,
            u_light: activeLight ?? blank,
            u_focus: focused ? 1 : 0,
            u_focusLife: focused && !mapFocus ? 1 : 0,
            u_focusClasses: mapFocus ? [(1 << input.roof) >>> 0, 0] : [0, 0],
          });
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          const pixels = new Uint8Array(canvas.width * canvas.height * 4);
          gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const pixel = (x: number, offset = 1) =>
            Array.from(pixels.slice((x * input.cw + offset) * 4, (x * input.cw + offset) * 4 + 3));
          return {
            cells: Array.from({ length: n }, (_, x) => pixel(x)),
            crownEdge: pixel(6, input.cw - 1),
            brakeEdge: [pixel(29), pixel(29, input.cw - 1)],
          };
        };
        const day = render(1),
          night = render(0);
        // Focus metadata must never become a surface permission or recolour amber indicators.
        for (let x = 0; x < n; x++) life[x * 4 + 2]! |= input.focusBit;
        gl.bindTexture(gl.TEXTURE_2D, lifeTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n, 1, gl.RGBA, gl.UNSIGNED_BYTE, life);
        const focusedDay = render(1, true),
          focusedNight = render(0, true);
        const mapFocused = render(1, true, true);
        // Strip focus metadata, keeping ordinary agent permissions and indicator flags.
        for (let x = 0; x < n; x++) life[x * 4 + 2]! &= ~input.focusBit;
        life[2] = input.vehicleBit;
        gl.bindTexture(gl.TEXTURE_2D, lifeTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n, 1, gl.RGBA, gl.UNSIGNED_BYTE, life);
        const off = render(1).cells[0];
        const light = new Uint8Array(n * 4);
        for (let x = 21; x < n; x++) light.set([77, input.brakeGlow, 0, 255], x * 4);
        activeLight = texture(n, 1, light);
        const brakeNight = render(0),
          brakeDay = render(1);
        if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL error');
        return { day, night, off, brakeNight, brakeDay, focusedDay, focusedNight, mapFocused };
      },
      {
        vertex: fullscreenVertex,
        fragments: [false, true].map((focus) => glyphFragmentFor({ focus, effectClocks: false })),
        maxClasses: MAX_CLASSES,
        glyphs,
        block,
        cw,
        ch,
        glintOrigin,
        paints: themeUniforms(theme).paints,
        background: theme.background.slice(0, 3),
        bits: Array.from(cellBits()),
        road: classId('road_major'),
        roof: classId('building'),
        water: classId('water_river'),
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
        focusBit: LIFE_FOCUS_BIT,
        body: VehiclePart.body,
        head: VehiclePart.headlight,
        tail: VehiclePart.taillight,
        puff: PersonPart.puff,
        brake: BRAKE_LAMP,
        brakeGlow: lightByte(LampState.beam, BRAKE_GLOW.seed),
      },
    );
    const amber = TURN_SIGNAL_COLOR.map((c) => Math.round(c * 255));
    for (const frame of [result.day, result.night, result.focusedDay, result.focusedNight]) {
      for (const x of [0, 2, 6])
        frame.cells[x]!.forEach((c, i) => expect(Math.abs(c - amber[i]!)).toBeLessThanOrEqual(1));
      for (const x of [1, 3, 4, 5, 7, 8, 9, 10, 11]) expect(frame.cells[x]).not.toEqual(amber);
      expect(frame.crownEdge).not.toEqual(amber);
      expect(frame.cells[7]).toEqual([0, 0, 255]);
      expect(frame.cells[20]).toEqual([0, 0, 255]);
    }
    for (const frame of [result.day, result.night]) {
      expect(frame.cells[13]![1]).toBeGreaterThan(frame.cells[12]![1]!);
      expect(frame.cells[13]).not.toEqual(frame.cells[14]);
      expect(frame.cells[16]).toEqual(theme.background.slice(0, 3).map((c) => Math.round(c * 255)));
      expect(frame.cells[17]![2]).toBeGreaterThan(frame.cells[15]![2]!);
      expect(frame.cells[18]).not.toEqual(frame.cells[15]);
      expect(frame.cells[19]).not.toEqual(frame.cells[15]);
    }
    result.night.cells[13]!.forEach((c, i) =>
      expect(
        Math.abs(c - Math.round(Math.min(1, BRAKE_COLOR.night[i]! * BRAKE_COLOR.glow) * 255)),
      ).toBeLessThanOrEqual(1),
    );
    expect(result.off).toEqual(result.day.cells[1]);
    const redness = (pixel: number[]) => pixel[0]! - (pixel[1]! + pixel[2]!) / 2;
    expect(redness(result.brakeNight.cells[21]!)).toBeGreaterThan(
      redness(result.night.cells[21]!) + 10,
    );
    for (const x of [22, 23, 24, 25, 26, 27, 28, 30])
      expect(result.brakeNight.cells[x]).toEqual(result.night.cells[x]);
    if (name === 'dark') expect(result.night.cells[23]).not.toEqual(result.day.cells[23]);
    for (let x = 21; x < 31; x++) expect(result.brakeDay.cells[x]).toEqual(result.day.cells[x]);
    expect(redness(result.brakeNight.brakeEdge[0]!)).toBeGreaterThan(
      redness(result.night.brakeEdge[0]!) + 10,
    );
    expect(result.brakeNight.brakeEdge[1]).toEqual(result.night.brakeEdge[1]);
    expect(result.focusedDay.cells[1]).toEqual([51, 204, 255]);
    expect(result.focusedDay.cells[3]).toEqual(result.day.cells[3]!.map((c) => Math.round(c / 2)));
    expect(result.mapFocused.cells[3]).toEqual([51, 204, 255]);
  }
});
