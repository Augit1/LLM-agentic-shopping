import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const path = require('path');
const fs = require('fs');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  distDir: '.next',
  // Ensure Next.js follows symlinks
  webpack: (config, { isServer }) => {
    // Add src directory to module resolution
    const projectRoot = path.resolve(process.cwd());
    config.resolve.modules = [
      ...(config.resolve.modules || []),
      projectRoot,
      path.join(projectRoot, 'src'),
      path.join(projectRoot, 'src', 'frontend'),
    ];
    
    // Add alias for easier imports
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': path.join(projectRoot, 'src', 'frontend'),
    };
    
    // Ensure symlinks are resolved
    config.resolve.symlinks = true;
    
    return config;
  },
};

export default nextConfig;

