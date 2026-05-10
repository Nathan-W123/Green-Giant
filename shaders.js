// WebGL GLSL fallback shaders — used when WebGPU/Anime4K is unavailable.
// Exported as ES module constants; bundled into content.bundle.js by esbuild.

export const VERT_SHADER_SRC = `
  attribute vec2 a_position;
  varying vec2 v_texCoord;

  void main() {
    // Map clip-space [-1,1] to UV [0,1].
    // Y is flipped because WebGL texture origin is bottom-left; video frames are top-left.
    v_texCoord = vec2(
      (a_position.x + 1.0) * 0.5,
      (1.0 - a_position.y) * 0.5
    );
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

// 4-tap diagonal unsharp mask. Diagonal taps avoid cross-shaped ringing artifacts.
export const FRAG_UNSHARP_SRC = `
  precision mediump float;

  uniform sampler2D u_texture;
  uniform vec2 u_texelSize;
  uniform float u_strength;
  uniform float u_radius;

  varying vec2 v_texCoord;

  void main() {
    vec2 uv = v_texCoord;
    vec4 center = texture2D(u_texture, uv);

    vec2 off = u_texelSize * u_radius;
    vec4 blur = (
      texture2D(u_texture, uv + vec2(-off.x, -off.y)) +
      texture2D(u_texture, uv + vec2( off.x, -off.y)) +
      texture2D(u_texture, uv + vec2(-off.x,  off.y)) +
      texture2D(u_texture, uv + vec2( off.x,  off.y))
    ) * 0.25;

    vec4 sharpened = center + (center - blur) * u_strength;
    gl_FragColor = clamp(sharpened, 0.0, 1.0);
  }
`;

// Smooth mode: bilinear filtering only. The upscale quality comes from GL_LINEAR
// on the texture sampler, not from any per-fragment math.
export const FRAG_SMOOTH_SRC = `
  precision mediump float;

  uniform sampler2D u_texture;
  varying vec2 v_texCoord;

  void main() {
    gl_FragColor = texture2D(u_texture, v_texCoord);
  }
`;

// Passthrough: identity output. Used when mode is "off" so the WebGL program
// stays compiled and avoids a recompile cost when the user re-enables the extension.
export const FRAG_PASSTHROUGH_SRC = `
  precision mediump float;

  uniform sampler2D u_texture;
  varying vec2 v_texCoord;

  void main() {
    gl_FragColor = texture2D(u_texture, v_texCoord);
  }
`;
