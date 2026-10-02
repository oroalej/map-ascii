import type { NextConfig } from 'next';
import { parseLifeHoverPause } from './lib/life-hover-config';

// Next loads production env files before this configuration: reject a bad rollback before export.
parseLifeHoverPause(process.env.NEXT_PUBLIC_LIFE_HOVER_PAUSE);

const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  transpilePackages: ['@atlas/content', '@atlas/renderer', '@atlas/shared'],
};

export default nextConfig;
