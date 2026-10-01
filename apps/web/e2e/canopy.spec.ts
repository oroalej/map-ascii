import { expect, test } from '@playwright/test';
import {
  classDepths,
  classId,
  classVisibility,
  crownSurfaces,
  groundClasses,
  groundDepth,
  MAX_CLASSES,
  TIER_STEP,
} from '../../../packages/renderer/src/classes';
import {
  buildGlyphTables,
  canopyCell,
  foliageVariant,
  MAX_VARIANTS,
  roadMask,
  seeThroughMask,
  subcellAreas,
} from '../../../packages/renderer/src/glyphs/select';
import { cellBits, CellBit } from '../../../packages/renderer/src/life/config';
import { VehiclePart } from '../../../packages/renderer/src/life/vehicles';
import { PersonPart, personByte } from '../../../packages/renderer/src/life/people';
import { cellFragment, cellVertex } from '../../../packages/renderer/src/shaders/cell';
import { fullscreenVertex } from '../../../packages/renderer/src/shaders/fullscreen';
import { glyphFragment } from '../../../packages/renderer/src/shaders/glyph';
import { selectFragment } from '../../../packages/renderer/src/shaders/select';
import { mapGlyphs, sextantGlyphs, themes } from '../../../packages/renderer/src/theme';

for (const theme of ['dark', 'light'] as const) {
  test(`tree canopy overlap hides non-bird Life and compares roof heights (${theme})`, async ({
    page,
  }) => {
    // Exercise the real shaders with controlled geometry, rather than city data or timing.
    const glyphs = [' ', ...mapGlyphs(themes[theme]).filter((g) => g !== ' ')];
    const index = (g: string) => glyphs.indexOf(g);
    const tables = buildGlyphTables(themes[theme], index);
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
        const glyph = program(input.fullscreenVertex, input.glyphFragment);
        type UniformValue = number | number[] | WebGLTexture;
        const uniforms = (p: WebGLProgram, values: Record<string, UniformValue>) => {
          gl.useProgram(p);
          let unit = 0;
          for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
            const info = gl.getActiveUniform(p, i)!;
            const loc = gl.getUniformLocation(p, info.name);
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
              else if (info.type === gl.FLOAT_MAT4) gl.uniformMatrix4fv(loc, false, a);
              else if (info.type === gl.INT_VEC2) gl.uniform2iv(loc, a);
              else if (info.type === gl.INT_VEC3) gl.uniform3iv(loc, a);
              else if (info.type === gl.UNSIGNED_INT) gl.uniform1uiv(loc, a);
              else gl.uniform1iv(loc, a);
            }
          }
        };
        const raster = (w: number, h: number) => {
          const textures = [texture(w, h), texture(w, h), texture(w, h)];
          const fbo = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
          textures.forEach((tex, i) =>
            gl.framebufferTexture2D(
              gl.FRAMEBUFFER,
              gl.COLOR_ATTACHMENT0 + i,
              gl.TEXTURE_2D,
              tex,
              0,
            ),
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
        const selectFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, selectFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, selected, 0);
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
          u_groundMask: input.grounds,
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
          gl.blitFramebuffer(
            0,
            0,
            from.w,
            from.h,
            0,
            0,
            to.w,
            to.h,
            gl.DEPTH_BUFFER_BIT,
            gl.NEAREST,
          );
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
        const tableTex = texture(
          input.maxVariants,
          input.maxClasses,
          new Uint8Array(input.table),
          2,
        );
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
        const render = (zoom = 20, shadows = 0) => {
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
            u_shadows: shadows,
            u_sun: [1, 0, 0.1],
            u_crownSun: [0, 0, 1],
            u_crownNight: 0,
            u_canopyOrigin: [0, 0],
            u_canopyPhase: [0, 0],
            u_canopyStep: [0.25, 0.5],
          });
          gl.bindVertexArray(emptyVao);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, canvas.width, canvas.height);
          uniforms(glyph, {
            u_glyphs: selected,
            u_atlas: atlasTex,
            u_cell: [cw, ch],
            u_height: canvas.height,
            u_columns: input.glyphs.length,
            u_colors: colors,
            u_fillColors: colors,
            u_daylight: 1,
            u_labelCell: [cw, ch],
            u_crownClass: input.crown,
            u_crownSun: [0, 0, 1],
            u_crownNight: 0,
            u_life: lifeTex,
            u_subClass: sub.textures[0]!,
            u_subAttr: sub.textures[1]!,
            u_id: live.textures[2]!,
            u_subId: sub.textures[2]!,
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
              [input.carGlyph & 255, cls | ((input.carGlyph >> 8) << 6), bit, byte],
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
            setAgent(agent.cls, agent.bit, agent.byte);
            const pixels = render();
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
            });
          }
        }
        if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL error');
        // Quantized crown attributes match the CPU twin through the real select program.
        // All cells share an identity, as the crowns along a tree row do.
        setAgent(0, 0, 0);
        const crownGlyphs = [];
        for (const seed of [42, 73]) {
          for (const target of [live, sub]) {
            const classes = new Uint8Array(target.w * target.h * 4);
            const attrs = new Uint8Array(classes.length),
              ids = new Uint8Array(classes.length);
            for (let y = 0; y < target.h; y++)
              for (let x = 0; x < target.w; x++) {
                const at = (y * target.w + x) * 4,
                  cx = target === sub ? Math.floor(x / 2) : x,
                  cy = target === sub ? Math.floor(y / 3) : y;
                classes[at] = input.crown;
                attrs.set([10, Math.round((cx / 11) * 255), Math.round((cy / 7) * 255), 0], at);
                ids[at] = seed;
              }
            upload(target.textures[0]!, target.w, target.h, classes);
            upload(target.textures[1]!, target.w, target.h, attrs);
            upload(target.textures[2]!, target.w, target.h, ids);
          }
          render(20, 1);
          gl.bindFramebuffer(gl.FRAMEBUFFER, selectFbo);
          const bytes = new Uint8Array(cols * rows * 4);
          gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
          if (bytes.some((b, i) => i % 4 === 2 && (b & 8) !== 0))
            throw new Error('A row shadows its own crown identity');
          crownGlyphs.push(
            Array.from(
              { length: cols * rows },
              (_, i) => input.glyphs[bytes[i * 4]! + ((bytes[i * 4 + 1]! >> 6) << 8)],
            ),
          );
        }
        const samplers = Array.from(
          { length: gl.getProgramParameter(glyph, gl.ACTIVE_UNIFORMS) as number },
          (_, i) => gl.getActiveUniform(glyph, i)!,
        ).filter((u) => u.type === gl.SAMPLER_2D).length;
        for (const target of [live, sub]) {
          const classes = new Uint8Array(target.w * target.h * 4);
          for (let i = 0; i < classes.length; i += 4) classes[i] = input.woods;
          upload(target.textures[0]!, target.w, target.h, classes);
          upload(target.textures[1]!, target.w, target.h, new Uint8Array(classes.length));
        }
        render();
        gl.bindFramebuffer(gl.FRAMEBUFFER, selectFbo);
        const woodsBytes = new Uint8Array(cols * rows * 4);
        gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, woodsBytes);
        const woodsGlyphs = Array.from(
          { length: cols * rows },
          (_, i) => input.glyphs[woodsBytes[i * 4]! + ((woodsBytes[i * 4 + 1]! >> 6) << 8)],
        );
        if (gl.getError() !== gl.NO_ERROR) throw new Error('Foliage parity WebGL error');
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
          crownGlyphs,
          woodsGlyphs,
          samplers,
          samplerLimit: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number,
        };
      },
      {
        cellVertex,
        cellFragment,
        fullscreenVertex,
        selectFragment,
        glyphFragment,
        glyphs,
        sextants: [...sextantGlyphs],
        depths: Array.from(classDepths()),
        visibility: Array.from(classVisibility(20)),
        grounds: groundClasses.reduce((m, c) => m | (1 << classId(c)), 0),
        groundDepth: groundDepth(),
        surfaces: Array.from(crownSurfaces()),
        overDepth: classDepths()[classId('road_major')]! - TIER_STEP * 0.05,
        road: classId('road_mid'),
        roof: classId('building'),
        crown: classId('tree_crown'),
        woods: classId('trees'),
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
    expect(result.samplers).toBeLessThanOrEqual(result.samplerLimit);
    expect(result.woodsGlyphs).toEqual(
      Array.from(
        { length: 96 },
        (_, i) =>
          themes[theme].styles.trees!.glyphs[
            canopyCell(i % 12, Math.floor(i / 12), 0, 0, 0, undefined, undefined, {
              sun: [0, 0, 1],
            }).variant
          ],
      ),
    );
    for (const [i, seed] of [42, 73].entries()) {
      expect(result.crownGlyphs[i]).toEqual(
        Array.from({ length: 96 }, (_, at) => {
          const x = at % 12,
            y = Math.floor(at / 12);
          const local = [
            (Math.round((x / 11) * 255) / 255) * 2 - 1,
            (Math.round((y / 7) * 255) / 255) * 2 - 1,
          ] as const;
          return themes[theme].styles.tree_crown!.glyphs[
            foliageVariant(x, y, 0, 0, false, { id: seed, local, sun: [0, 0, 1] })
          ];
        }),
      );
    }
    for (const sample of result.occlusion) {
      for (const p of [
        sample.clear,
        ...(sample.bird ? [sample.edgeCovered, sample.covered] : []),
      ]) {
        expect(p[0], `${sample.name}: visible against surface ${sample.occluder}`).toBeGreaterThan(
          100,
        );
        expect(p[1]).toBeLessThan(10);
      }
      if (!sample.bird) {
        expect(
          sample.edgeCovered,
          `${sample.name}: hidden at surface ${sample.occluder} edge`,
        ).toEqual(sample.edgeWithoutLife);
        expect(sample.covered, `${sample.name}: hidden by surface ${sample.occluder}`).toEqual(
          sample.coveredWithoutLife,
        );
      }
      if (sample.occluder !== classId('tree') || sample.bird) {
        expect(sample.edgeClear[0], `${sample.name}: visible outside canopy edge`).toBeGreaterThan(
          100,
        );
        expect(sample.edgeClear[1]).toBeLessThan(10);
      }
    }
  });
}
