// Copies onnxruntime-web JS + WASM files to lib/ so they can be served as
// extension resources without going through esbuild (WASM can't be bundled).
const fs = require('fs');
const path = require('path');

const src  = path.join(__dirname, 'node_modules', 'onnxruntime-web', 'dist');
const dest = path.join(__dirname, 'lib');
const copyAiAssets = process.env.ECO_ENABLE_AI_ASSETS === '1';

fs.mkdirSync(dest, { recursive: true });

let copied = 0;
if (copyAiAssets && fs.existsSync(src)) {
  for (const file of fs.readdirSync(src)) {
    if (file === 'ort.min.js' || file.endsWith('.wasm')) {
      fs.copyFileSync(path.join(src, file), path.join(dest, file));
      copied++;
    }
  }
} else if (!copyAiAssets) {
  console.log('[setup] AI assets disabled; skipping ORT asset copy.');
} else {
  console.log('[setup] ONNX Runtime package not installed; skipping ORT asset copy.');
}
console.log(`[setup] Copied ${copied} ORT files to lib/`);

const modelsDir = path.join(__dirname, 'models');
fs.mkdirSync(modelsDir, { recursive: true });
const modelPath = path.join(modelsDir, 'super-resolution-10.onnx');
if (!fs.existsSync(modelPath)) {
  console.log('[setup] Model not found. Download it with:');
  console.log('  curl -L -o models/super-resolution-10.onnx "https://github.com/onnx/models/raw/main/validated/vision/super_resolution/sub_pixel_cnn_2016/model/super-resolution-10.onnx"');
}
