import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['fayda-decoder', 'sharp', 'zxing-wasm'],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "ngrok-skip-browser-warning",
            value: "true",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
