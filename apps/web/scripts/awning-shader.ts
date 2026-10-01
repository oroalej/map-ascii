import type { Page } from '@playwright/test';
import { classId, MAX_CLASSES, renderClasses } from '../../../packages/renderer/src/classes';
import { fullscreenVertex } from '../../../packages/renderer/src/shaders/fullscreen';
import { glyphFragment } from '../../../packages/renderer/src/shaders/glyph';
import { themes } from '../../../packages/renderer/src/theme';
import { themeUniforms } from '../../../packages/renderer/src/theme-uniforms';

/** Controlled shader coverage complements the city capture, which may have no station shop. */
export async function verifyAwningColors(page: Page) {
  // tsx preserves names using this helper when serializing nested browser functions.
  await page.evaluate('globalThis.__name = (value) => value');
  const results = [];
  for (const name of ['dark', 'light'] as const) {
    const theme = themes[name],
      uniforms = themeUniforms(theme);
    const classes = renderClasses
      .filter((c) => c.startsWith('building') || c === 'furniture')
      .map(classId);
    const cells = classes.flatMap((cls) =>
      Array.from({ length: 8 }, (_, i) => ({ cls, code: i + 1 })),
    );
    cells.push({ cls: classId('coastline'), code: 0 }, { cls: classId('grass'), code: 0 });
    const pixels = await page.evaluate(
      (input) => {
        const canvas = document.createElement('canvas');
        canvas.width = input.cells.length * 4;
        canvas.height = 4;
        document.body.replaceChildren(canvas);
        const gl = canvas.getContext('webgl2', { antialias: false })!;
        if (!gl) throw new Error('WebGL2 unavailable for awning fixtures');
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
          gl.deleteShader(shader);
        }
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS))
          throw new Error(gl.getProgramInfoLog(program)!);
        gl.useProgram(program);
        gl.bindVertexArray(gl.createVertexArray());
        const texture = (w: number, h: number, data: Uint8Array, single = false) => {
          const tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            single ? gl.R8 : gl.RGBA8,
            w,
            h,
            0,
            single ? gl.RED : gl.RGBA,
            gl.UNSIGNED_BYTE,
            data,
          );
          for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
            gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
          for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
            gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
          return tex;
        };
        // Index 290 exercises the high glyph bits sharing the class byte.
        const selected = new Uint8Array(input.cells.length * 4);
        input.cells.forEach(({ cls, code }, i) =>
          selected.set([290 & 255, cls | (1 << 6), code << 4, 0], i * 4),
        );
        const atlas = texture(300 * 4, 4, new Uint8Array(300 * 4 * 4).fill(255), true);
        const glyphs = texture(input.cells.length, 1, selected),
          blank = texture(1, 1, new Uint8Array(4));
        const colors = Array.from({ length: input.maxClasses * 3 }, (_, i) =>
          i % 3 === 2 ? 1 : 0,
        );
        const values: Record<string, number | number[] | WebGLTexture> = {
          u_atlas: atlas,
          u_glyphs: glyphs,
          u_cell: [4, 4],
          u_labelCell: [4, 4],
          u_columns: 300,
          u_labelColumns: 300,
          u_height: 4,
          u_daylight: 1,
          u_colors: colors,
          u_fillColors: colors,
          u_frontageClasses: input.frontageClasses,
          u_awningPaints: input.paints,
        };
        let unit = 0;
        for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++) {
          const info = gl.getActiveUniform(program, i)!,
            at = gl.getUniformLocation(program, info.name);
          const value = values[info.name.replace(/\[0\]$/, '')];
          if (info.type === gl.SAMPLER_2D) {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, value instanceof WebGLTexture ? value : blank);
            gl.uniform1i(at, unit++);
          } else if (value !== undefined) {
            const a = typeof value === 'number' ? [value] : (value as number[]);
            if (info.type === gl.FLOAT) gl.uniform1fv(at, a);
            else if (info.type === gl.FLOAT_VEC2) gl.uniform2fv(at, a);
            else if (info.type === gl.FLOAT_VEC3) gl.uniform3fv(at, a);
            else if (info.type === gl.INT_VEC2) gl.uniform2iv(at, a);
            else if (info.type === gl.INT_VEC3) gl.uniform3iv(at, a);
            else gl.uniform1iv(at, a);
          }
        }
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const bytes = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        if (gl.getError() !== gl.NO_ERROR) throw new Error('Awning fixture WebGL error');
        const result = input.cells.map((_, i) =>
          Array.from(bytes.slice((i * 4 + 1) * 4, (i * 4 + 1) * 4 + 3)),
        );
        for (const tex of [atlas, glyphs, blank]) gl.deleteTexture(tex);
        gl.deleteProgram(program);
        return result;
      },
      {
        cells,
        vertex: fullscreenVertex,
        fragment: glyphFragment,
        maxClasses: MAX_CLASSES,
        frontageClasses: Array.from(uniforms.frontageClasses),
        paints: uniforms.awnings,
      },
    );
    pixels.forEach((rgb, i) => {
      const code = cells[i]!.code;
      const expected = code
        ? uniforms.awnings.slice((code - 1) * 3, code * 3).map((c) => Math.round(c * 255))
        : [0, 0, 255];
      if (rgb.some((c, j) => Math.abs(c - expected[j]!) > 1))
        throw new Error(
          `${name} awning class ${cells[i]!.cls}, code ${code}: ${rgb.join(',')} != ${expected.join(',')}`,
        );
    });
    results.push({ theme: name, cells: cells.length, status: 'pass' });
  }
  return results;
}
