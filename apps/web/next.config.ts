import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  transpilePackages: ['@naga/renderer', '@naga/shared'],
};

export default nextConfig;
