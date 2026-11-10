import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['fayda-decoder', 'sharp', 'zxing-wasm'],
  outputFileTracingIncludes: {
    '/api/**/*': [
      './node_modules/zxing-wasm/dist/reader/zxing_reader.wasm',
      './node_modules/zxing-wasm/dist/writer/zxing_writer.wasm',
    ],
  },
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
