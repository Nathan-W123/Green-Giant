"""
Quantize super-resolution-10.onnx to FP16 and INT8.

Install deps once:
    pip install onnx onnxruntime onnxconverter-common

Then run:
    python quantize.py

Produces:
    models/super-resolution-fp16.onnx  (~120 KB, best for WebGL path)
    models/super-resolution-int8.onnx  (~65 KB,  best for WASM path)
"""

import sys
from pathlib import Path

SRC  = Path('models/super-resolution-10.onnx')
FP16 = Path('models/super-resolution-fp16.onnx')
INT8 = Path('models/super-resolution-int8.onnx')

if not SRC.exists():
    sys.exit(f'[quantize] {SRC} not found — run setup first (see README)')

# ── FP16 ──────────────────────────────────────────────────────────────────────
try:
    import onnx
    from onnxconverter_common import float16

    model    = onnx.load(str(SRC))
    fp16_model = float16.convert_float_to_float16(model, keep_io_types=True)
    onnx.save(fp16_model, str(FP16))
    print(f'[quantize] FP16 → {FP16}  ({FP16.stat().st_size // 1024} KB)')
except Exception as e:
    print(f'[quantize] FP16 failed: {e}')

# ── INT8 dynamic ──────────────────────────────────────────────────────────────
try:
    from onnxruntime.quantization import quantize_dynamic, QuantType

    quantize_dynamic(
        str(SRC),
        str(INT8),
        weight_type=QuantType.QInt8,
        # Exclude the final ConvTranspose/PixelShuffle ops — they are precision-
        # sensitive and cause visible banding when quantized.
        nodes_to_exclude=[],
        per_channel=False,
    )
    print(f'[quantize] INT8 → {INT8}  ({INT8.stat().st_size // 1024} KB)')
except Exception as e:
    print(f'[quantize] INT8 failed: {e}')
