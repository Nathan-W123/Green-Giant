// Builds lib/ort.min.js from ort.bundle.min.mjs (worker code inlined) as an IIFE,
// then patches all import.meta.url references to location.href so it runs as a
// classic content script. Also copies the WASM binary to lib/ so ORT can fetch
// it via an explicit chrome-extension:// wasmPaths override at runtime.
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
    format:      'iife',
    outfile:     path.join(dest, 'ort.min.js'),
  });

  // Patch import.meta.url → location.href.
  // Chrome extension content scripts are classic scripts (import.meta is invalid).
  // ORT uses this URL only to locate WASM files; we override that via wasmPaths
  // at runtime, so location.href is a safe substitute (avoids SyntaxError, and
  // the actual URL is never used because wasmPaths takes precedence).
  let ortJs = fs.readFileSync(path.join(dest, 'ort.min.js'), 'utf8');
  const count = (ortJs.match(/\bimport\.meta\.url\b/g) || []).length;
  ortJs = ortJs.replace(/\bimport\.meta\.url\b/g, 'location.href');
  fs.writeFileSync(path.join(dest, 'ort.min.js'), ortJs);

  const kb = Math.round(fs.statSync(path.join(dest, 'ort.min.js')).size / 1024);
  console.log(`[setup] Built lib/ort.min.js (${kb} KB, patched ${count} import.meta.url refs)`);
} finally {
  fs.unlinkSync(entry);
}

// Copy the WASM binary that ORT will fetch at inference time via wasmPaths.
const wasmName = 'ort-wasm-simd-threaded.wasm';
const wasmSrc  = path.join(src, wasmName);
const wasmDest = path.join(dest, wasmName);
if (fs.existsSync(wasmSrc)) {
  fs.copyFileSync(wasmSrc, wasmDest);
  const wasmKb = Math.round(fs.statSync(wasmDest).size / 1024);
  console.log(`[setup] Copied ${wasmName} (${wasmKb} KB) to lib/`);
} else {
  console.warn(`[setup] ${wasmName} not found in dist — ORT WASM init will fail`);
}

const modelsDir  = path.join(__dirname, 'models');
fs.mkdirSync(modelsDir, { recursive: true });
const modelPath  = path.join(modelsDir, 'super-resolution-10.onnx');
if (!fs.existsSync(modelPath)) {
  console.log('[setup] Model not found. Download it with:');
  console.log('  curl -L -o models/super-resolution-10.onnx "https://github.com/onnx/models/raw/main/validated/vision/super_resolution/sub_pixel_cnn_2016/model/super-resolution-10.onnx"');
}
