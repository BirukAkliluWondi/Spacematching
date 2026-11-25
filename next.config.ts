import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['fayda-decoder', 'sharp', 'zxing-wasm', 'tesseract.js'],
  outputFileTracingIncludes: {
    '/api/**/*': [
      './node_modules/zxing-wasm/dist/reader/zxing_reader.wasm',
      './node_modules/zxing-wasm/dist/writer/zxing_writer.wasm',
      './node_modules/tesseract.js/src/worker-script/node/**/*',
      './node_modules/tesseract.js/dist/**/*',
      './node_modules/tesseract.js-core/**/*',
      './src/assets/fonts/**/*',
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
