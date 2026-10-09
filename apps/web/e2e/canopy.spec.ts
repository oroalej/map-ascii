import { expect, test } from '@playwright/test';
import { LIFE_FOCUS_BIT } from '../../../packages/renderer/src/focus';
import {
  classDepths,
  classId,
  classVisibility,
  crownSurfaces,
  groundFlags,
  groundDepth,
  MAX_CLASSES,
  TIER_STEP,
} from '../../../packages/renderer/src/classes';
import {
  buildGlyphTables,
  MAX_VARIANTS,
  roadMask,
  seeThroughMask,
  subcellAreas,
} from '../../../packages/renderer/src/glyphs/select';
import { cellBits, CellBit } from '../../../packages/renderer/src/life/config';
import { ORDINARY_CLOCK, heldClock } from '../../../packages/renderer/src/life/effect-clocks';
import { VehiclePart } from '../../../packages/renderer/src/life/vehicles';
import { PersonPart, personByte } from '../../../packages/renderer/src/life/people';
import { cellFragment, cellVertex } from '../../../packages/renderer/src/shaders/cell';
import { fullscreenVertex } from '../../../packages/renderer/src/shaders/fullscreen';
import { glyphFragmentFor } from '../../../packages/renderer/src/shaders/glyph';
import { selectFragment } from '../../../packages/renderer/src/shaders/select';
import { mapGlyphs, sextantGlyphs, themes } from '../../../packages/renderer/src/theme';

test('tree canopy overlap hides non-bird Life and compares roof heights', async ({ page }) => {
  // Exercise the real shaders with controlled geometry, rather than city data or timing.
  const glyphs = [' ', ...mapGlyphs(themes.dark).filter((g) => g !== ' ')];
  const index = (g: string) => glyphs.indexOf(g);
  const tables = buildGlyphTables(themes.dark, index);
  const result = await page.evaluate(
    (input) => {
      const cols = 12,
        rows = 8,
        cw = 6,
        ch = 9;
      const canvas = document.createElement('canvas');
      canvas.width = cols * cw;
      canvas.height = rows * ch;
      const gl = canvas.getContext('webgl2', { antialias: false })!;
      if (!gl) throw new Error('WebGL2 unavailable');

      const texture = (w: number, h: number, data: Uint8Array | null = null, channels = 4) => {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          channels === 1 ? gl.R8 : channels === 2 ? gl.RG8 : gl.RGBA8,
          w,
          h,
          0,
          channels === 1 ? gl.RED : channels === 2 ? gl.RG : gl.RGBA,
          gl.UNSIGNED_BYTE,
          data,
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
      };
      const blank = texture(cols, rows, new Uint8Array(cols * rows * 4));
      const crowdMask = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, crowdMask);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32UI,
        1,
        1,
        0,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_INT,
        new Uint32Array(4),
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const program = (vertex: string, fragment: string) => {
        const p = gl.createProgram();
        for (const [type, source] of [
          [gl.VERTEX_SHADER, vertex],
          [gl.FRAGMENT_SHADER, fragment],
        ] as const) {
          const shader = gl.createShader(type)!;
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
            throw new Error(gl.getShaderInfoLog(shader)!);
          gl.attachShader(p, shader);
        }
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)!);
        return p;
      };
      const cell = program(input.cellVertex, input.cellFragment);
      const select = program(input.fullscreenVertex, input.selectFragment);
      const glyphPrograms = new Map<number, WebGLProgram>();
      const glyphFor = (key: number) => {
        let glyph = glyphPrograms.get(key);
        if (!glyph) {
          glyph = program(input.fullscreenVertex, input.glyphFragments[key]!);
          glyphPrograms.set(key, glyph);
        }
        return glyph;
      };
      type UniformValue = number | number[] | WebGLTexture;
      const uniforms = (p: WebGLProgram, values: Record<string, UniformValue>) => {
        gl.useProgram(p);
        let unit = 0;
        for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
          const info = gl.getActiveUniform(p, i)!;
          const loc = gl.getUniformLocation(p, info.name);
          const value = values[info.name.replace(/\[0\]$/, '')];
          if (info.type === gl.SAMPLER_2D || info.type === gl.UNSIGNED_INT_SAMPLER_2D) {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(
              gl.TEXTURE_2D,
              value instanceof WebGLTexture
                ? value
                : info.type === gl.UNSIGNED_INT_SAMPLER_2D
                  ? crowdMask
                  : blank,
            );
            gl.uniform1i(loc, unit++);
          } else if (value !== undefined) {
            const a = typeof value === 'number' ? [value] : (value as number[]);
            if (info.type === gl.FLOAT) gl.uniform1fv(loc, a);
            else if (info.type === gl.FLOAT_VEC2) gl.uniform2fv(loc, a);
            else if (info.type === gl.FLOAT_VEC3) gl.uniform3fv(loc, a);
            else if (info.type === gl.FLOAT_MAT4) gl.uniformMatrix4fv(loc, false, a);
            else if (info.type === gl.INT_VEC2) gl.uniform2iv(loc, a);
            else if (info.type === gl.INT_VEC3) gl.uniform3iv(loc, a);
            else if (info.type === gl.UNSIGNED_INT) gl.uniform1uiv(loc, a);
            else if (info.type === gl.UNSIGNED_INT_VEC2) gl.uniform2uiv(loc, a);
            else gl.uniform1iv(loc, a);
          }
        }
        gl.uniform1i(gl.getUniformLocation(p, 'u_hasCrowdMask'), 0);
      };
      const raster = (w: number, h: number) => {
        const textures = [texture(w, h), texture(w, h), texture(w, h)];
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        textures.forEach((tex, i) =>
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0),
        );
        const depth = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
          throw new Error('Incomplete framebuffer');
        return { w, h, textures, fbo };
      };
      const base = raster(cols, rows),
        subBase = raster(cols * 2, rows * 3);
      const live = raster(cols, rows),
        sub = raster(cols * 2, rows * 3);
      const selected = texture(cols, rows);
      // The select pass also writes each cell's light (gpu.ts shadeTex), as in the renderer.
      const shade = texture(cols, rows, null, 1);
      const selectFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, selectFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, selected, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, shade, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      const emptyVao = gl.createVertexArray();
      const meshVao = gl.createVertexArray();
      gl.bindVertexArray(meshVao);
      const positions = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positions);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      const common = {
        u_matrix: [2 / cols, 0, 0, 0, 0, 2 / rows, 0, 0, 0, 0, 1, 0, -1, -1, 0, 1],
        u_depth: input.depths,
        u_vis: input.visibility,
        u_zoom: 20,
        u_roadMask: input.roads,
        u_ground: input.grounds,
        u_groundDepth: input.groundDepth,
        u_crownClass: input.crown,
        u_crownSurfaces: input.surfaces,
        u_crownOverDepth: input.overDepth,
        u_origin: [0, 0],
        u_grid: [cols, rows],
        u_windDir: [1, 0],
      };
      const quad = (
        cls: number,
        height: number,
        id: number,
        x0: number,
        y0: number,
        x1: number,
        y1: number,
        flags = 0,
      ) => {
        gl.bindVertexArray(meshVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, positions);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          new Float32Array([x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1]),
          gl.STATIC_DRAW,
        );
        gl.vertexAttrib4f(1, cls, height, flags, 0);
        gl.vertexAttribI4ui(2, id, 0, 0, 0);
        gl.vertexAttrib1f(3, 4);
        gl.vertexAttrib2f(4, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      };
      for (const target of [base, subBase]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.viewport(0, 0, target.w, target.h);
        gl.clearColor(0, 0, 0, 0);
        gl.clearDepth(1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
        uniforms(cell, { ...common, u_sub: target === base ? [1, 1] : [2, 3], u_wind: 0 });
        quad(input.road, 0, 1, 0, 0, 7, rows, 2);
        quad(input.roof, 6, 2, 7, 0, 9, rows);
        quad(input.roof, 10, 3, 9, 0, 10, rows);
        quad(input.roof, 15, 4, 10, 0, cols, rows);
        quad(input.marker, 0, 5, 6, 4, 7, 5);
      }
      const copy = (from: typeof base, to: typeof base) => {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from.fbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to.fbo);
        const attachments = [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2];
        for (const a of attachments) {
          gl.readBuffer(a);
          gl.drawBuffers(attachments.map((b) => (b === a ? b : gl.NONE)));
          gl.blitFramebuffer(
            0,
            0,
            from.w,
            from.h,
            0,
            0,
            to.w,
            to.h,
            gl.COLOR_BUFFER_BIT,
            gl.NEAREST,
          );
        }
        gl.blitFramebuffer(0, 0, from.w, from.h, 0, 0, to.w, to.h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
        gl.drawBuffers(attachments);
      };
      const crowns = (time = 0, wind = 0, reverse = false) => {
        for (const [under, target] of [
          [base, live],
          [subBase, sub],
        ]) {
          copy(under!, target!);
          gl.bindFramebuffer(gl.FRAMEBUFFER, target!.fbo);
          gl.viewport(0, 0, target!.w, target!.h);
          gl.enable(gl.DEPTH_TEST);
          uniforms(cell, {
            ...common,
            u_sub: target === live ? [1, 1] : [2, 3],
            u_time: time,
            u_wind: wind,
            u_crownBaseClass: under!.textures[0]!,
            u_crownBaseAttr: under!.textures[1]!,
          });
          const low = () => quad(input.crown, 10, 20, 1.4, 1.8, 11.2, 6.8);
          const high = () => quad(input.crown, 12, 21, 3.2, 3.2, 5.8, 5.8);
          if (reverse) {
            high();
            low();
          } else {
            low();
            high();
          }
        }
        gl.disable(gl.DEPTH_TEST);
      };
      const read = (target: typeof base, attachment = 0) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment);
        const bytes = new Uint8Array(target.w * target.h * 4);
        gl.readPixels(0, 0, target.w, target.h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        return bytes;
      };
      // Solid ordinary glyphs and exact sextants isolate compositing from font antialiasing.
      const atlas = new Uint8Array(input.glyphs.length * cw * ch);
      input.glyphs.forEach((g, i) => {
        const mask = input.sextants.indexOf(g);
        for (let y = 0; y < ch; y++)
          for (let x = 0; x < cw; x++)
            atlas[y * (input.glyphs.length * cw) + i * cw + x] =
              g === ' '
                ? 0
                : mask < 0 || mask & (1 << (Math.floor(y / 3) * 2 + Math.floor(x / 3)))
                  ? 255
                  : 0;
      });
      const atlasTex = texture(input.glyphs.length * cw, ch, atlas, 1);
      const tableTex = texture(input.maxVariants, input.maxClasses, new Uint8Array(input.table), 2);
      const life = new Uint8Array(cols * rows * 4);
      for (let x = 0; x < 6; x++)
        life.set(
          [
            input.carGlyph & 255,
            input.vehicle | ((input.carGlyph >> 8) << 6),
            input.vehicleBit,
            input.carPart << 4,
          ],
          (2 * cols + x) * 4,
        );
      const lifeTex = texture(cols, rows, life);
      const colors = new Array(input.maxClasses * 3).fill(0);
      for (const cls of input.occluders) colors[cls * 3 + 1] = 1;
      colors[input.roof * 3 + 2] = 1;
      colors[input.person * 3] = 1;
      colors[input.bird * 3] = 1;
      const render = (
        zoom = 20,
        focused = false,
        lifeTime = 0,
        clocks?: WebGLTexture,
        daylight = 1,
      ) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, selectFbo);
        gl.viewport(0, 0, cols, rows);
        uniforms(select, {
          u_class: live.textures[0]!,
          u_attr: live.textures[1]!,
          u_id: live.textures[2]!,
          u_baseClass: base.textures[0]!,
          u_baseAttr: base.textures[1]!,
          u_baseId: base.textures[2]!,
          u_subClass: sub.textures[0]!,
          u_subAttr: sub.textures[1]!,
          u_subId: sub.textures[2]!,
          u_table: tableTex,
          u_kind: input.kinds,
          u_count: input.counts,
          u_connect: input.connects,
          u_area: input.areas,
          u_roadMask: input.roads,
          u_seeThrough: input.seeThrough,
          u_zoom: zoom,
          u_cellAspect: ch / cw,
          u_cellMeters: [1, 1],
        });
        gl.bindVertexArray(emptyVao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        uniforms(glyphFor(Number(focused) | (Number(!!clocks) << 1)), {
          u_glyphs: selected,
          u_shade: shade,
          u_atlas: atlasTex,
          u_cell: [cw, ch],
          u_height: canvas.height,
          u_columns: input.glyphs.length,
          u_colors: colors,
          u_fillColors: colors,
          u_daylight: daylight,
          u_focus: focused ? 1 : 0,
          u_focusLife: focused ? 1 : 0,
          u_lifeTime: lifeTime,
          u_shimmer: clocks ? 1 : 0,
          u_effectClocks: clocks ?? blank,
          u_hasEffectClocks: clocks ? 1 : 0,
          u_light: blank,
          u_focusClasses: [0, 0],
          u_accent: [0, 0.5, 1],
          u_labelCell: [cw, ch],
          u_crownClass: input.crown,
          u_crownSun: [0, 0, 1],
          u_life: lifeTex,
          u_subClass: sub.textures[0]!,
          u_subAttr: sub.textures[1]!,
          u_cellBits: input.bits,
          u_vehicle: input.vehicle,
          u_person: input.person,
          u_bird: input.bird,
          u_boat: input.boat,
          u_train: input.train,
          u_vehicleOccluders: input.occluders,
          u_paints: [1, 0, 0, ...new Array<number>(45).fill(0)],
        });
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return pixels;
      };
      const pixel = (pixels: Uint8Array, x: number, y: number) =>
        Array.from(
          pixels.slice(
            ((canvas.height - 1 - y) * canvas.width + x) * 4,
            ((canvas.height - 1 - y) * canvas.width + x) * 4 + 3,
          ),
        );
      crowns();
      const classes = read(live),
        ids = read(live, 2);
      const subStill = read(sub),
        still = render();
      const selectedBytes = new Uint8Array(cols * rows * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, selectFbo);
      gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, selectedBytes);
      render(16);
      gl.bindFramebuffer(gl.FRAMEBUFFER, selectFbo);
      const joined = new Uint8Array(cols * rows * 4);
      gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, joined);
      const joinAt = (7 * cols + 2) * 4;
      const roadJoinGlyph = joined[joinAt]! + ((joined[joinAt + 1]! >> 6) << 8);
      const saved = {
        clearCar: pixel(still, 2, 2 * ch + 4),
        edgeClear: pixel(still, cw + 1, 2 * ch + 4),
        edgeCovered: pixel(still, cw + 4, 2 * ch + 4),
        coveredCar: pixel(still, 2 * cw + 2, 2 * ch + 4),
      };
      const upload = (tex: WebGLTexture, width: number, height: number, bytes: Uint8Array) => {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      };
      const setAgent = (cls: number, bit: number, byte: number) => {
        life.fill(0);
        for (let x = 0; x < 6; x++)
          life.set(
            [input.carGlyph & 255, cls | ((input.carGlyph >> 8) << 6), bit | input.focusBit, byte],
            (2 * cols + x) * 4,
          );
        upload(lifeTex, cols, rows, life);
      };
      crowns(0, 0, true);
      const readIds = read(live, 2);
      const orderIndependent = ids.every((b, i) => b === readIds[i]);
      let revealedRoad = false,
        revealedCar = false,
        revealedPerson = false;
      for (const time of [0, 5, 10, 15, 20, 30, 45, 60]) {
        crowns(time, 1);
        const moved = read(sub),
          pixels = render();
        setAgent(input.person, input.personBit, 0);
        const people = render();
        setAgent(input.vehicle, input.vehicleBit, input.carPart << 4);
        for (let y = 0; y < sub.h; y++)
          for (let x = 0; x < sub.w; x++) {
            const at = (y * sub.w + x) * 4;
            if (subStill[at] === input.crown && moved[at] === input.road) {
              revealedRoad = true;
              if (Math.floor(y / 3) === 2 && Math.floor(x / 2) < 6) {
                const p = pixel(pixels, x * 3 + 1, y * 3 + 1);
                if (p[0]! > 100 && p[1]! < 10) revealedCar = true;
                const person = pixel(people, x * 3 + 1, y * 3 + 1);
                if (person[0]! > 100 && person[1]! < 10) revealedPerson = true;
              }
            }
          }
      }
      // Feed exact visible surfaces to the real select/glyph passes. This isolates Life
      // compositing for every encoded agent class, including a boat beside a wooded bank.
      const occlusion = [];
      for (const occluder of input.occluders) {
        for (const agent of input.agents) {
          for (const [target, partial] of [
            [live, false],
            [sub, true],
          ] as const) {
            const surfaces = new Uint8Array(target.w * target.h * 4);
            for (let y = 0; y < target.h; y++)
              for (let x = 0; x < target.w; x++) {
                const col = partial ? x / 2 : x;
                surfaces[(y * target.w + x) * 4] =
                  col >= (partial ? 1.5 : 1) && col < 6 ? occluder : agent.surface;
              }
            upload(target.textures[0]!, target.w, target.h, surfaces);
            upload(target.textures[1]!, target.w, target.h, new Uint8Array(surfaces.length));
          }
          setAgent(0, 0, 0);
          const withoutLife = render();
          // One ground-agent focus case per occluder, plus the bird exception.
          const checkFocus =
            agent.name === 'vehicle' || (agent.name === 'bird' && occluder === input.crown);
          const focusedWithoutLife = checkFocus ? render(20, true) : undefined;
          setAgent(agent.cls, agent.bit, agent.byte);
          const pixels = render();
          const focusedPixels = checkFocus ? render(20, true) : undefined;
          occlusion.push({
            name: agent.name,
            bird: agent.cls === input.bird,
            occluder,
            clear: pixel(pixels, 2, 2 * ch + 4),
            edgeClear: pixel(pixels, cw + 1, 2 * ch + 4),
            edgeCovered: pixel(pixels, cw + 4, 2 * ch + 4),
            covered: pixel(pixels, 2 * cw + 2, 2 * ch + 4),
            edgeWithoutLife: pixel(withoutLife, cw + 4, 2 * ch + 4),
            coveredWithoutLife: pixel(withoutLife, 2 * cw + 2, 2 * ch + 4),
            focusedCovered: focusedPixels && pixel(focusedPixels, 2 * cw + 2, 2 * ch + 4),
            focusedWithoutLife:
              focusedWithoutLife && pixel(focusedWithoutLife, 2 * cw + 2, 2 * ch + 4),
            focusedClear: focusedPixels && pixel(focusedPixels, 2, 2 * ch + 4),
          });
        }
      }
      // One real shader check: a held candle's clock stays fixed while another advances.
      for (const target of [live, sub]) {
        const surfaces = new Uint8Array(target.w * target.h * 4);
        for (let cell = 0; cell < surfaces.length; cell += 4) surfaces[cell] = input.road;
        upload(target.textures[0]!, target.w, target.h, surfaces);
        upload(target.textures[1]!, target.w, target.h, new Uint8Array(surfaces.length));
      }
      setAgent(input.person, input.personBit, input.candleByte);
      const clockTokens = new Float32Array(cols * rows * 2).fill(input.ordinaryClock);
      for (let row = 0; row < rows; row++)
        for (let col = 0; col < 2; col++)
          clockTokens[(row * cols + col) * 2] = col === 0 ? input.heldFraction : input.heldZero;
      const clocks = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, clocks);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, cols, rows, 0, gl.RG, gl.FLOAT, clockTokens);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const early = render(20, false, 0, clocks, 0);
      const late = render(20, false, 0.2, clocks, 0);
      const focusedEarly = render(20, true, 0, clocks, 0);
      const focusedLate = render(20, true, 0.2, clocks, 0);
      const candleClocks = {
        heldEarly: pixel(early, 2, 2 * ch + 4),
        heldLate: pixel(late, 2, 2 * ch + 4),
        zeroEarly: pixel(early, cw + 2, 2 * ch + 4),
        zeroLate: pixel(late, cw + 2, 2 * ch + 4),
        focusedEarly: pixel(focusedEarly, 2, 2 * ch + 4),
        focusedLate: pixel(focusedLate, 2, 2 * ch + 4),
        otherEarly: pixel(early, 3 * cw + 2, 2 * ch + 4),
        otherLate: pixel(late, 3 * cw + 2, 2 * ch + 4),
      };
      const releasePixels = (token: number, time: number) => {
        for (let row = 0; row < rows; row++) clockTokens[row * cols * 2] = token;
        gl.bindTexture(gl.TEXTURE_2D, clocks);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RG, gl.FLOAT, clockTokens);
        return pixel(render(20, false, time, clocks, 0), 2, 2 * ch + 4);
      };
      const released = releasePixels(0.125, 0.375);
      const heldReference = releasePixels(input.heldReference, 1);
      gl.deleteTexture(clocks);
      if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL error');
      return {
        classes: [
          classes[(2 * cols + 2) * 4],
          classes[(2 * cols + 8) * 4],
          classes[(2 * cols + 9) * 4],
          classes[(2 * cols + 10) * 4],
          classes[(4 * cols + 6) * 4],
        ],
        higherCrown: ids[(4 * cols + 4) * 4],
        orderIndependent,
        ...saved,
        falseCurbGlyph: selectedBytes[(7 * cols + 2) * 4],
        lowerRoofEdgeClass: selectedBytes[(1 * cols + 8) * 4 + 1]! & 63,
        roadJoinGlyph,
        revealedRoad,
        revealedCar,
        revealedPerson,
        occlusion,
        candleClocks,
        released,
        heldReference,
      };
    },
    {
      cellVertex,
      cellFragment,
      fullscreenVertex,
      selectFragment,
      glyphFragments: [0, 1, 2, 3].map((key) =>
        glyphFragmentFor({ focus: !!(key & 1), effectClocks: !!(key & 2) }),
      ),
      ordinaryClock: ORDINARY_CLOCK,
      heldFraction: heldClock(0.4),
      heldZero: heldClock(0),
      heldReference: heldClock(0.25),
      glyphs,
      sextants: [...sextantGlyphs],
      depths: Array.from(classDepths()),
      visibility: Array.from(classVisibility(20)),
      grounds: Array.from(groundFlags()),
      groundDepth: groundDepth(),
      surfaces: Array.from(crownSurfaces()),
      overDepth: classDepths()[classId('road_major')]! - TIER_STEP * 0.05,
      road: classId('road_mid'),
      roof: classId('building'),
      crown: classId('tree_crown'),
      marker: classId('marker_landmark'),
      roads: roadMask(),
      seeThrough: seeThroughMask(),
      areas: Array.from(subcellAreas()),
      bits: Array.from(cellBits()),
      maxVariants: MAX_VARIANTS,
      maxClasses: MAX_CLASSES,
      table: Array.from(tables.table),
      kinds: Array.from(tables.kinds),
      counts: Array.from(tables.counts),
      connects: Array.from(tables.connects),
      vehicle: classId('life_vehicle'),
      person: classId('life_person'),
      bird: classId('life_bird'),
      boat: classId('life_boat'),
      train: classId('life_train'),
      personBit: CellBit.person,
      candleByte: personByte(0, PersonPart.canopy, true),
      focusBit: LIFE_FOCUS_BIT,
      agents: [
        ...['walker', 'seated person', 'vendor attendant', 'cat', 'dog'].map((name) => ({
          name,
          cls: classId('life_person'),
          bit: CellBit.person,
          byte: personByte(0, PersonPart.canopy),
          surface: classId('paving'),
        })),
        ...['vehicle', 'vendor cart'].map((name) => ({
          name,
          cls: classId('life_vehicle'),
          bit: CellBit.vehicle,
          byte: VehiclePart.body << 4,
          surface: classId('road_mid'),
        })),
        {
          name: 'train',
          cls: classId('life_train'),
          bit: CellBit.train,
          byte: VehiclePart.body << 4,
          surface: classId('rail'),
        },
        {
          name: 'boat',
          cls: classId('life_boat'),
          bit: CellBit.boat,
          byte: VehiclePart.body << 4,
          surface: classId('water_river'),
        },
        {
          name: 'bird',
          cls: classId('life_bird'),
          bit: CellBit.bird,
          byte: 255,
          surface: classId('paving'),
        },
      ],
      vehicleBit: CellBit.vehicle,
      carPart: VehiclePart.body,
      carGlyph: index('█'),
      occluders: [classId('tree'), classId('tree_crown'), classId('trees')],
    },
  );
  expect(result.classes).toEqual([
    classId('tree_crown'),
    classId('tree_crown'),
    classId('building'),
    classId('building'),
    classId('marker_landmark'),
  ]);
  expect(result.higherCrown).toBe(21);
  expect(result.orderIndependent).toBe(true);
  expect(result.candleClocks.heldLate).toEqual(result.candleClocks.heldEarly);
  expect(result.candleClocks.zeroLate).toEqual(result.candleClocks.zeroEarly);
  expect(result.candleClocks.focusedLate).toEqual(result.candleClocks.focusedEarly);
  expect(result.released).toEqual(result.heldReference);
  expect(result.candleClocks.otherLate).not.toEqual(result.candleClocks.otherEarly);
  for (const p of [result.clearCar, result.edgeClear]) {
    expect(p[0]).toBeGreaterThan(100);
    expect(p[1]).toBeLessThan(10);
  }
  for (const p of [result.edgeCovered, result.coveredCar]) {
    expect(p[1]).toBeGreaterThan(100);
    expect(p[0]).toBeLessThan(10);
  }
  expect(result.falseCurbGlyph).toBe(0);
  expect(result.lowerRoofEdgeClass).toBe(classId('tree_crown'));
  expect(result.roadJoinGlyph).toBe(index('┼'));
  expect(result.revealedRoad).toBe(true);
  expect(result.revealedCar).toBe(true);
  expect(result.revealedPerson).toBe(true);
  for (const sample of result.occlusion) {
    for (const p of [sample.clear, ...(sample.bird ? [sample.edgeCovered, sample.covered] : [])]) {
      expect(p[0], `${sample.name}: visible against surface ${sample.occluder}`).toBeGreaterThan(
        100,
      );
      expect(p[1]).toBeLessThan(10);
    }
    if (!sample.bird) {
      if (sample.focusedCovered)
        expect(
          sample.focusedCovered,
          `${sample.name}: focus must not leak through foliage`,
        ).toEqual(sample.focusedWithoutLife);
      expect(
        sample.edgeCovered,
        `${sample.name}: hidden at surface ${sample.occluder} edge`,
      ).toEqual(sample.edgeWithoutLife);
      expect(sample.covered, `${sample.name}: hidden by surface ${sample.occluder}`).toEqual(
        sample.coveredWithoutLife,
      );
    }
    if (sample.focusedClear) expect(sample.focusedClear).toEqual([0, 128, 255]);
    if (sample.occluder !== classId('tree') || sample.bird) {
      expect(sample.edgeClear[0], `${sample.name}: visible outside canopy edge`).toBeGreaterThan(
        100,
      );
      expect(sample.edgeClear[1]).toBeLessThan(10);
    }
  }
});
