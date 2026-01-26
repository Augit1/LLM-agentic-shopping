import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Point to the new app directory location
  distDir: '.next',
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
    
    return config;
  },
};

export default nextConfig;

