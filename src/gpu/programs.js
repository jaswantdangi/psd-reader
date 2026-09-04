/**
 * Compiled GLSL, cached by program name.
 *
 * THE CACHE IS THE POINT, not a convenience. `programNameFor` collapses 26
 * blend modes onto at most 26 programs, and a typical document uses one to
 * three of them -- but a naive renderer compiles per DRAW, which on the mid
 * Adreno and Mali parts this app targets costs tens of milliseconds each and
 * turns a 2 ms frame into a 400 ms one. Keying the cache by the same function
 * the plan keys its `program` field by means the renderer cannot compile two
 * programs for one mode, or one program twice, by construction.
 *
 * COMPILING IS LAZY. A document that uses `normal` and `multiply` compiles two
 * shaders and never parses the other 24, which matters most on exactly the
 * devices where compiling is slowest.
 *
 * NOTHING HERE THROWS. A driver that fails to compile or link is a normal
 * outcome on mobile, not an exception: the caller has a correct JS tier to fall
 * back to, and an exception escaping into a render loop would take the frame
 * with it. Failure is reported as `{program: null, reason}` and the reason
 * carries the driver's own info log, because "shader compile failed" without
 * the log is a bug report nobody can act on.
 */
import { VERTEX_SHADER, fragmentShaderFor, CLIP_ALPHA_FRAGMENT_SHADER, PRESENT_FRAGMENT_SHADER } from './glsl.js';
import { programNameFor } from './modes.js';

/**
 * Texture units, fixed for the life of a program.
 *
 * Assigned ONCE at link time rather than per draw. Sampler uniforms are the one
 * kind of uniform whose value is a unit index and not data, they never change
 * for a given program, and re-uploading them every draw is pure overhead on the
 * hot path.
 *
 * uMask, uClip and uLut always have a real texture bound even when the draw
 * does not use them -- see the 1x1 stand-ins in textures.js. A sampler that is
 * live in the shader (all three are, behind branches) but points at an
 * incomplete unit samples undefined data on some drivers, and the branch that
 * was supposed to protect it is not guaranteed to be evaluated first.
 */
export const UNIT = Object.freeze({ backdrop: 0, source: 1, mask: 2, clip: 3, lut: 4 });

/** Uniforms every blend program carries, looked up once and reused per draw. */
const BLEND_UNIFORMS = [
  'uBackdrop', 'uSource', 'uMask', 'uClip',
  'uRect', 'uCanvas', 'uOpacity', 'uUseMask', 'uUseClip',
  'uLut', 'uAdjustFlags', 'uHslCentres', 'uHslBands', 'uHslSaturation',
];

const CLIP_UNIFORMS = ['uSource', 'uMask', 'uRect', 'uCanvas', 'uOpacity', 'uUseMask'];
const PRESENT_UNIFORMS = ['uSource', 'uCanvas'];

/**
 * Uniform locations, by name.
 *
 * An array uniform is queried by its bare name AND by `name[0]`: GLSL ES 3.00
 * says both name the first element, but drivers have historically disagreed
 * about which one `getUniformLocation` answers to. Missing either would leave
 * `uHslBands` null and silently render every HSL layer unadjusted -- a wrong
 * frame, not a crash.
 *
 * A location may legitimately be null when the compiler proved the uniform
 * unused. `gl.uniform*` accepts null and is a no-op, so callers never branch.
 */
function locationsOf(gl, program, names) {
  const at = Object.create(null);
  for (const name of names)
    at[name] = gl.getUniformLocation(program, name) ?? gl.getUniformLocation(program, `${name}[0]`);
  return at;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  // getShaderParameter is the ONLY reliable signal. Some drivers return a
  // non-empty info log on success (warnings), and some return an empty one on
  // failure, so neither the log's presence nor its emptiness decides anything.
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return { shader, reason: null };
  const reason = gl.getShaderInfoLog(shader) || 'compile failed with no info log';
  gl.deleteShader(shader);
  return { shader: null, reason };
}

function link(gl, vertexSource, fragmentSource) {
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSource);
  if (!vs.shader) return { program: null, reason: `vertex shader: ${vs.reason}` };

  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!fs.shader) { gl.deleteShader(vs.shader); return { program: null, reason: `fragment shader: ${fs.reason}` }; }

  const program = gl.createProgram();
  gl.attachShader(program, vs.shader);
  gl.attachShader(program, fs.shader);
  gl.linkProgram(program);
  // Detached and deleted whatever happened: the program holds its own reference
  // until it is deleted, and leaving shader objects attached leaks them for the
  // life of the context. This is the leak that is invisible until the fourth
  // document, because it is bounded by the program count and not by the frames.
  gl.detachShader(program, vs.shader);
  gl.detachShader(program, fs.shader);
  gl.deleteShader(vs.shader);
  gl.deleteShader(fs.shader);

  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return { program, reason: null };
  const reason = gl.getProgramInfoLog(program) || 'link failed with no info log';
  gl.deleteProgram(program);
  return { program: null, reason };
}

/**
 * @param {WebGL2RenderingContext} gl
 * @returns {{blend(mode: string): object|null, clipAlpha(): object|null,
 *            present(): object|null, reason: string|null, compiled: number,
 *            dispose(): void}}
 *   Each getter returns `{name, program, at}` -- `at` being the uniform
 *   locations -- or null, having set `reason`. ONE failure poisons the cache:
 *   after it, every getter returns null without asking the driver again. A
 *   device whose compiler is broken is broken for the whole frame, and retrying
 *   26 times to collect 26 copies of the same info log is how a fallback that
 *   should take a millisecond takes a second.
 */
export function createProgramCache(gl) {
  const cache = new Map();
  let reason = null;
  let compiled = 0;

  const build = (key, fragmentSource) => {
    if (reason) return null;
    const found = cache.get(key);
    if (found) return found;

    const built = link(gl, VERTEX_SHADER, fragmentSource);
    if (!built.program) { reason = `${key}: ${built.reason}`; return null; }
    compiled++;

    const names = key === 'clip-alpha' ? CLIP_UNIFORMS : key === 'present' ? PRESENT_UNIFORMS : BLEND_UNIFORMS;
    const entry = { name: key, program: built.program, at: locationsOf(gl, built.program, names) };

    // Sampler units, once. See UNIT above for why they never move.
    gl.useProgram(entry.program);
    if (entry.at.uBackdrop) gl.uniform1i(entry.at.uBackdrop, UNIT.backdrop);
    if (entry.at.uSource) gl.uniform1i(entry.at.uSource, UNIT.source);
    if (entry.at.uMask) gl.uniform1i(entry.at.uMask, UNIT.mask);
    if (entry.at.uClip) gl.uniform1i(entry.at.uClip, UNIT.clip);
    if (entry.at.uLut) gl.uniform1i(entry.at.uLut, UNIT.lut);

    cache.set(key, entry);
    return entry;
  };

  return {
    // Keyed by programNameFor, the SAME function plan.js keys its step by, so a
    // mode and its program cannot drift apart.
    blend: (mode) => build(programNameFor(mode), fragmentShaderFor(mode)),
    clipAlpha: () => build('clip-alpha', CLIP_ALPHA_FRAGMENT_SHADER),
    present: () => build('present', PRESENT_FRAGMENT_SHADER),
    get reason() { return reason; },
    get compiled() { return compiled; },
    dispose() {
      for (const entry of cache.values()) gl.deleteProgram(entry.program);
      cache.clear();
    },
  };
}
