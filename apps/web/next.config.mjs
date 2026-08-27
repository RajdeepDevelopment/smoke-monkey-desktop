/** @type {import('next').NextConfig} */
const isDesktopExport = process.env.BUILD_FOR_DESKTOP === '1';

const nextConfig = {
  // Cloud/web keeps the standalone server; the desktop shell wants a fully
  // static `out/` directory that the Tauri webview can serve.
  output: isDesktopExport ? 'export' : 'standalone',
  images: { unoptimized: isDesktopExport },
  transpilePackages: ['@rag/contracts'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
