import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  transpilePackages: ['@atlas/content', '@atlas/renderer', '@atlas/shared'],
};

export default nextConfig;
