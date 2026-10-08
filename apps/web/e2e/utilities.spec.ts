import { expect, test } from '@playwright/test';
import { classId, MAX_CLASSES } from '../../../packages/renderer/src/classes';
import { cellBits } from '../../../packages/renderer/src/life/config';
import { UtilityPart } from '../../../packages/renderer/src/life/utilities';
import { glyphFragmentFor } from '../../../packages/renderer/src/shaders/glyph';
import { fullscreenVertex } from '../../../packages/renderer/src/shaders/fullscreen';
import { themes } from '../../../packages/renderer/src/theme';
import { mapReady } from './helpers';

test('utility poles and overhead wires', async ({ page }) => {
  // The actual fragment shader proves ink-only composition and the surface/label masks.
  // The real city below proves config -> tile worker -> fixture texture -> HUD integration.
  const checked = await page.evaluate(
    ({ vertex, fragment, classes, bits, colors, max, cable }) => {
      const canvas = document.createElement('canvas');
      canvas.width = 40;
      canvas.height = 8;
      const gl = canvas.getContext('webgl2', { antialias: false })!;
      if (!gl) throw new Error('WebGL2 unavailable');
      const program = gl.createProgram();
      for (const [type, source] of [
        [gl.VERTEX_SHADER, vertex],
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
      gl.useProgram(program);
      gl.bindVertexArray(gl.createVertexArray());
      let unit = 0;
      const texture = (name: string, w: number, h: number, bytes: Uint8Array) => {
        const tex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.uniform1i(gl.getUniformLocation(program, name), unit++);
      };
      // Unused samplers share a transparent texture on unit zero.
      texture('u_light', 5, 1, new Uint8Array(20));
      const crowdMask = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
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
      gl.uniform1i(gl.getUniformLocation(program, 'u_crowdMask'), unit++);
      gl.uniform1i(gl.getUniformLocation(program, 'u_hasCrowdMask'), 0);
      const glyphs = new Uint8Array(20),
        fixtures = new Uint8Array(20),
        labels = new Uint8Array(20),
        attr = new Uint8Array(20);
      classes.forEach((cls, i) => {
        glyphs.set([0, cls, 0, 0], i * 4);
        fixtures.set([1, cable, 0, 255], i * 4);
      });
      attr[4] = 10;
      labels[16] = 1;
      const atlas = new Uint8Array(16 * 8 * 4);
      for (let y = 0; y < 8; y++) for (let x = 8; x < 12; x++) atlas[(y * 16 + x) * 4] = 255;
      texture('u_glyphs', 5, 1, glyphs);
      texture('u_atlas', 16, 8, atlas);
      texture('u_overlay', 5, 1, labels);
      texture('u_attr', 5, 1, attr);
      texture('u_fixtures', 5, 1, fixtures);
      const fixtureUnit = unit - 1;
      gl.uniform2f(gl.getUniformLocation(program, 'u_cell'), 8, 8);
      gl.uniform2f(gl.getUniformLocation(program, 'u_labelCell'), 8, 8);
      gl.uniform1f(gl.getUniformLocation(program, 'u_height'), 8);
      gl.uniform1i(gl.getUniformLocation(program, 'u_columns'), 2);
      gl.uniform1i(gl.getUniformLocation(program, 'u_labelColumns'), 1);
      gl.uniform1iv(gl.getUniformLocation(program, 'u_cellBits'), bits);
      gl.uniform3iv(gl.getUniformLocation(program, 'u_vehicleOccluders'), [classes[2]!, 62, 63]);
      gl.uniform3f(gl.getUniformLocation(program, 'u_background'), 0.07, 0.12, 0.19);
      gl.uniform3fv(gl.getUniformLocation(program, 'u_colors'), new Float32Array(max * 3));
      const read = (on: boolean) => {
        gl.uniform1i(gl.getUniformLocation(program, 'u_fixtures'), on ? fixtureUnit : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const bytes = new Uint8Array(40 * 8 * 4);
        gl.readPixels(0, 0, 40, 8, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        return bytes;
      };
      const result: { theme: string; daylight: number; checks: Record<string, boolean> }[] = [];
      for (const { theme, paints } of colors)
        for (const daylight of [1, 0]) {
          gl.uniform1f(gl.getUniformLocation(program, 'u_daylight'), daylight);
          gl.uniform3fv(gl.getUniformLocation(program, 'u_fixturePaints'), paints);
          const off = read(false),
            on = read(true);
          const changed = (x: number) =>
            [0, 1, 2].some((c) => off[(4 * 40 + x) * 4 + c] !== on[(4 * 40 + x) * 4 + c]);
          result.push({
            theme,
            daylight,
            checks: {
              'cable ink on road': changed(1),
              'transparent cable background': !changed(6),
              'roof mask': !changed(9),
              'canopy mask': !changed(17),
              'water mask': !changed(25),
              'label mask': !changed(33),
            },
          });
        }
      if (gl.getError() !== gl.NO_ERROR) throw new Error('Utility shader WebGL error');
      return result;
    },
    {
      vertex: fullscreenVertex,
      fragment: glyphFragmentFor({ focus: false, effectClocks: false }),
      max: MAX_CLASSES,
      cable: UtilityPart.cable,
      classes: ['road_major', 'building', 'tree_crown', 'water_area', 'road_major'].map(classId),
      bits: Array.from(cellBits()),
      colors: (['light', 'dark'] as const).map((theme) => ({
        theme,
        paints: themes[theme].fixturePaints.flatMap((c) => [
          ((c >> 16) & 255) / 255,
          ((c >> 8) & 255) / 255,
          (c & 255) / 255,
        ]),
      })),
    },
  );
  for (const { theme, daylight, checks } of checked)
    for (const [name, passed] of Object.entries(checks))
      expect(passed, `${theme}, ${daylight ? 'day' : 'night'}: ${name}`).toBe(true);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() =>
    localStorage.setItem('atlas.life', JSON.stringify({ enabled: false, time: 'noon' })),
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/naga?lat=13.6240&lng=123.1851&z=19.5');
  await mapReady(page);
  const legend = page
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: 'Legend' }) });
  if ((await legend.getAttribute('open')) === null) await legend.locator('summary').click();
  await expect(legend.getByText('Utility poles and wires (illustrative)')).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('button', { name: 'Life', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(legend.getByText('Utility poles and wires (illustrative)')).toBeVisible();
  expect(errors).toEqual([]);
});
