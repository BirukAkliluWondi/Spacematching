import type { NextConfig } from "next";

const WEBHOOK_TRACE_FILES = [
  './eng.traineddata',
  './public/images/fayda_sample_back.png',
  './node_modules/zxing-wasm/dist/reader/zxing_reader.wasm',
  './node_modules/tesseract.js/src/**/*',
  './node_modules/tesseract.js-core/tesseract-core-simd.wasm.js',
  './node_modules/tesseract.js-core/tesseract-core-simd.wasm',
  './node_modules/tesseract.js-core/tesseract-core.wasm.js',
  './node_modules/tesseract.js-core/tesseract-core.wasm',
  './node_modules/wasm-feature-detect/**/*',
  './node_modules/bmp-js/**/*',
  './src/assets/fonts/**/*',
];

const nextConfig: NextConfig = {
  serverExternalPackages: ['fayda-decoder', 'sharp', 'zxing-wasm', 'tesseract.js'],
  outputFileTracingIncludes: {
    '/api/telegram/webhook': WEBHOOK_TRACE_FILES,
    '/api/webhooks/telegram': WEBHOOK_TRACE_FILES,
    '/api/card/start': ['./src/assets/fonts/**/*'],
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
