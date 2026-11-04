import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import { parseLifeHoverPause } from './lib/life-hover-config';

// Next loads production env files before this configuration: reject a bad rollback before export.
parseLifeHoverPause(process.env.NEXT_PUBLIC_LIFE_HOVER_PAUSE);

// This checkout's root. Task worktrees nest inside the main checkout (worktrees/<short>), so Next
// would otherwise pick the outer checkout's lockfile as the workspace root.
const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));

const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  outputFileTracingRoot: root,
  turbopack: {
    root,
    rules: {
      '*.ts': {
        // Shaders ship without comments or indentation (lib/strip-glsl-loader.cjs).
        condition: { all: ['production', { content: /[/][*] glsl [*][/]/ }] },
        loaders: ['./lib/strip-glsl-loader.cjs'],
        as: '*.ts',
      },
    },
  },
  transpilePackages: ['@atlas/content', '@atlas/renderer', '@atlas/shared'],
};

export default nextConfig;
