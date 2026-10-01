import type { Page } from '@playwright/test';
import { ROOF_BUILDING_CLASSES } from '../../../packages/shared/src/roof-plan';
import { classId, Flags, type RenderClass } from '../../../packages/renderer/src/classes';
import {
  buildGlyphTables,
  seeThrough,
  seeThroughMask,
  wallMask,
  wallStyle,
} from '../../../packages/renderer/src/glyphs/select';
import {
  partySeam,
  partyWallMask,
  type WallCell,
} from '../../../packages/renderer/src/glyphs/party-walls';
import { fullscreenVertex } from '../../../packages/renderer/src/shaders/fullscreen';
import { selectFragment } from '../../../packages/renderer/src/shaders/select';
import { themes } from '../../../packages/renderer/src/theme';

/** Run the production helpers on controlled textures and compare their joins with the CPU twin. */
export async function verifyPartyWalls(page: Page) {
  await page.evaluate('globalThis.__name = (value) => value');
  const fragment =
    selectFragment.slice(0, selectFragment.lastIndexOf('void main()')) +
    `
void main(){ivec2 p=ivec2(gl_FragCoord.xy); int cls=groundClassAt(p); vec4 a=groundAttrAt(p);
int mask=wallMask(p,OUTLINE); bool seam=partySeam(p,cls,a);
o_glyph=vec4(float(mask+2)/255.0,seam?1.0:0.0,0.0,1.0);}`;
  const width = 12,
    height = 10;
  type Cell = { cls: RenderClass; id: number; height: number; landmark: boolean; crown?: boolean };
  const results = [];
  for (const name of ['dark', 'light'] as const)
    for (const zoom of [16.9, 17, 18])
      for (const variant of ['contacts', 'mixed', 'reversed', 'crowns'] as const) {
        const cells: Cell[] = Array.from({ length: width * height }, () => ({
          cls: 'grass',
          id: 0,
          height: 0,
          landmark: false,
        }));
        for (let y = 2; y < 8; y++)
          for (let x = 2; x < 10; x++) {
            const right = x >= 6,
              bottom = y >= 5;
            const id = right ? 2 : bottom ? 3 : 1;
            cells[y * width + x] = {
              cls: right ? 'building_station' : 'building',
              id: variant === 'reversed' ? 4 - id : id,
              height: 10,
              landmark: variant === 'mixed' ? right : false,
              crown: variant === 'crowns' && (x + y) % 3 === 0,
            };
          }
        if (variant === 'mixed') {
          cells[4 * width + 6]!.height = 15;
          cells[3 * width + 4] = { cls: 'path', id: 9, height: 0, landmark: false };
          cells[5 * width + 5] = { cls: 'building_woodwork', id: 7, height: 10, landmark: false };
          cells[6 * width + 8]!.height = 0;
        }
        const sample = (x: number, y: number): WallCell => {
          const c =
            cells[
              Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))
            ]!;
          const style = wallStyle(
            themes[name].styles[c.cls]?.kind ?? 'single',
            c.landmark,
            c.height,
            zoom,
          );
          return {
            id: c.id,
            eligible: (ROOF_BUILDING_CLASSES as readonly string[]).includes(c.cls),
            height: c.height,
            style: style === 'single' ? 1 : style === 'double' ? 2 : 0,
            landmark: c.landmark,
            seeThrough: seeThrough.includes(c.cls),
          };
        };
        const expected = cells.map((c, i) => {
          const x = i % width,
            y = Math.floor(i / width),
            center = sample(x, y);
          const party = partyWallMask((dx, dy) => sample(x + dx, y + dy));
          const mask =
            party === undefined
              ? wallMask((dx, dy) => {
                  const q = sample(x + dx, y + dy);
                  return q.id !== center.id && !q.seeThrough;
                })
              : party;
          return [
            (mask ?? -1) + 2,
            partySeam(center, sample(x + 1, y), sample(x, y + 1)) ? 255 : 0,
          ];
        });
        const buffers = Array.from({ length: 6 }, () => Array<number>(width * height * 4).fill(0));
        cells.forEach((c, i) => {
          const cls = classId(c.cls),
            flags = c.landmark ? Flags.landmark : 0;
          const id = [c.id & 255, (c.id >>> 8) & 255, (c.id >>> 16) & 255, (c.id >>> 24) & 255];
          buffers[0]![i * 4] = c.crown ? classId('tree_crown') : cls;
          buffers[1]!.splice(i * 4, 4, ...(c.crown ? [20, 0, 0, 0] : [c.height, flags, 0, 0]));
          buffers[2]!.splice(i * 4, 4, ...(c.crown ? [99, 0, 0, 0] : id));
          buffers[3]![i * 4] = cls;
          buffers[4]!.splice(i * 4, 4, c.height, flags, 0, 0);
          buffers[5]!.splice(i * 4, 4, ...id);
        });
        const actual = await page.evaluate(
          (input) => {
            const canvas = document.createElement('canvas');
            canvas.width = input.width;
            canvas.height = input.height;
            document.body.replaceChildren(canvas);
            const gl = canvas.getContext('webgl2', { antialias: false })!;
            if (!gl) throw new Error('WebGL2 unavailable for wall fixtures');
            const program = gl.createProgram();
            for (const [type, source] of [
              [gl.VERTEX_SHADER, input.vertex],
              [gl.FRAGMENT_SHADER, input.fragment],
            ] as const) {
              const s = gl.createShader(type)!;
              gl.shaderSource(s, source);
              gl.compileShader(s);
              if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
                throw new Error(gl.getShaderInfoLog(s)!);
              gl.attachShader(program, s);
              gl.deleteShader(s);
            }
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS))
              throw new Error(gl.getProgramInfoLog(program)!);
            gl.useProgram(program);
            gl.bindVertexArray(gl.createVertexArray());
            const textures = input.buffers.map((bytes, unit) => {
              const t = gl.createTexture();
              gl.activeTexture(gl.TEXTURE0 + unit);
              gl.bindTexture(gl.TEXTURE_2D, t);
              gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                gl.RGBA8,
                input.width,
                input.height,
                0,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                new Uint8Array(bytes),
              );
              for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
                gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
              for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
                gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
              return t;
            });
            ['u_class', 'u_attr', 'u_id', 'u_baseClass', 'u_baseAttr', 'u_baseId'].forEach((n, i) =>
              gl.uniform1i(gl.getUniformLocation(program, n), i),
            );
            gl.uniform1iv(gl.getUniformLocation(program, 'u_kind'), input.kinds);
            gl.uniform1i(gl.getUniformLocation(program, 'u_seeThrough'), input.seeThrough);
            gl.uniform1f(gl.getUniformLocation(program, 'u_zoom'), input.zoom);
            gl.viewport(0, 0, input.width, input.height);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            const bytes = new Uint8Array(input.width * input.height * 4);
            gl.readPixels(0, 0, input.width, input.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
            if (gl.getError() !== gl.NO_ERROR) throw new Error('Wall fixture WebGL error');
            const result = Array.from({ length: input.width * input.height }, (_, i) => [
              bytes[i * 4],
              bytes[i * 4 + 1],
            ]);
            for (const t of textures) gl.deleteTexture(t);
            gl.deleteProgram(program);
            gl.getExtension('WEBGL_lose_context')?.loseContext();
            return result;
          },
          {
            width,
            height,
            buffers,
            vertex: fullscreenVertex,
            fragment,
            kinds: Array.from(buildGlyphTables(themes[name], () => 0).kinds),
            seeThrough: seeThroughMask(),
            zoom,
          },
        );
        actual.forEach((a, i) => {
          if (a.some((v, j) => v !== expected[i]![j]))
            throw new Error(
              `${name}/${zoom}/${variant} cell ${i}: ${a.join(',')} != ${expected[i]!.join(',')}`,
            );
        });
        results.push({ theme: name, zoom, variant, cells: cells.length, status: 'pass' });
      }
  return results;
}
