// Builds lib/ort.min.js by bundling ort.bundle.min.mjs (WASM baked-in as base64)
// into a plain IIFE that sets globalThis.ort. No external WASM fetch needed,
// which is required for Chrome extension content script contexts where
// dynamic import() of chrome-extension:// URLs is blocked.
const fs      = require('fs');
const path    = require('path');
const esbuild = require('esbuild');

const src  = path.join(__dirname, 'node_modules', 'onnxruntime-web', 'dist');
const dest = path.join(__dirname, 'lib');
fs.mkdirSync(dest, { recursive: true });

const bundleSrc = path.join(src, 'ort.bundle.min.mjs');
if (!fs.existsSync(bundleSrc)) {
  console.error('[setup] ort.bundle.min.mjs not found — run: npm install');
  process.exit(1);
}

// Write a tiny entry that imports the ORT bundle and exposes it globally.
const entry = path.join(__dirname, '_ort_entry_tmp.mjs');
fs.writeFileSync(entry, `import * as ort from ${JSON.stringify(bundleSrc)};\nglobalThis.ort = ort;\n`);

try {
  esbuild.buildSync({
    entryPoints: [entry],
    bundle:      true,
    format:      'esm',
    outfile:     path.join(dest, 'ort.min.js'),
  });
  const kb = Math.round(fs.statSync(path.join(dest, 'ort.min.js')).size / 1024);
  console.log(`[setup] Built lib/ort.min.js (${kb} KB, WASM embedded — no external fetch)`);
} finally {
  fs.unlinkSync(entry);
}

const modelsDir  = path.join(__dirname, 'models');
fs.mkdirSync(modelsDir, { recursive: true });
const modelPath  = path.join(modelsDir, 'super-resolution-10.onnx');
if (!fs.existsSync(modelPath)) {
  console.log('[setup] Model not found. Download it with:');
  console.log('  curl -L -o models/super-resolution-10.onnx "https://github.com/onnx/models/raw/main/validated/vision/super_resolution/sub_pixel_cnn_2016/model/super-resolution-10.onnx"');
}
