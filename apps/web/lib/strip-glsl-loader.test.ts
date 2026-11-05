import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { stripGlsl } = createRequire(import.meta.url)('./strip-glsl-loader.cjs') as {
  stripGlsl: (source: string) => string;
};

const shaders = import.meta.glob(
  ['../../../packages/renderer/src/**/*.ts', '!../../../packages/renderer/src/**/*.test.ts'],
  { query: '?raw', import: 'default', eager: true },
) as unknown as Record<string, string>;
const tag = '/* glsl */';
const shader = (body: string) => `export const s = ${tag} \`${body}\`;`;

describe('stripGlsl', () => {
  it('removes comments, indentation and blank lines', () => {
    expect(
      stripGlsl(shader('#version 300 es\n  // why\n\n  float a = 1.0; // why\n  float b;\n')),
    ).toBe(shader('#version 300 es\nfloat a = 1.0;\nfloat b;\n'));
  });

  it('keeps interpolations, and drops the ones inside a comment', () => {
    expect(stripGlsl(shader('  float a = ${x};\n  // see ${y} too\n  ${z}\n'))).toBe(
      shader('float a = ${x};\n${z}\n'),
    );
    expect(stripGlsl(shader('  if (a == ${x} && b) c(${y}); // d\n'))).toBe(
      shader('if (a == ${x} && b) c(${y});\n'),
    );
  });

  it('rewrites a tagged template nested in an interpolation', () => {
    const nested = `\${on ? ${tag} \`  a; // b\n\` : ''}`;
    expect(stripGlsl(shader(`  ${nested}\n`))).toBe(shader(`\${on ? ${tag} \`a;\n\` : ''}\n`));
  });

  it('leaves other templates, and files with no shaders, alone', () => {
    const plain = 'const a = `  b // c\n`; // d\n';
    expect(stripGlsl(plain)).toBe(plain);
    const mixed = `${plain}${shader('  e;\n')}`;
    expect(stripGlsl(mixed)).toBe(`${plain}${shader('e;\n')}`);
  });

  it('changes no code token in any shipped shader', () => {
    // Deliberately cruder than the loader, so the two can't share a mistake.
    const tokens = (source: string) => source.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');
    const files = Object.entries(shaders).filter(([, source]) => source.includes(tag));
    expect(files.length).toBeGreaterThan(10);
    for (const [path, source] of files) {
      const stripped = stripGlsl(source);
      expect(tokens(stripped), path).toBe(tokens(source));
      expect(stripped.length, path).toBeLessThan(source.length);
    }
  });
});
