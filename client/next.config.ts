import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  output: 'export',
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    // ESTA ES LA SOLUCIÓN CLAVE PARA EL EXPORT ESTÁTICO EN IIS
    unoptimized: true, 
    
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'placehold.co',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'picsum.photos',
        port: '',
        pathname: '/**',
      },
    ],
  },
  staticPageGenerationTimeout: 1000,
  // This is needed to make sure Next.js picks up files in the public directory.
  devIndicators: {
    buildActivity: true,
    buildActivityPosition: 'bottom-right',
  },
  reactStrictMode: false, // Recommended to disable for localStorage/useEffect heavy apps
};

export default nextConfig;