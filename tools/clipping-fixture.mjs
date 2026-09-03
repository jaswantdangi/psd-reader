/**
 * Builds a PSD that actually uses clipping masks, in memory.
 *
 * WHY THIS EXISTS. Not one file in `fixtures/` carries a clipped layer: ag-psd
 * reports `clipping` on all 80 nodes of all 21 documents and it is `false` on
 * every one. So every clipping assertion was written against hand-built
 * `project.layers` objects, which never touch reader.js at all. Nothing proved
 * the flag survives a real PSD.
 *
 * WHY IT RETURNS BYTES INSTEAD OF WRITING A FILE. `fixtures/` is gitignored --
 * the corpus is local-only -- so a committed binary would be invisible to the
 * repo and a written one would make the test depend on a build step someone
 * has to remember. Generating it in memory keeps test/clip.mjs hermetic.
 *
 * WHY writePsd IS ALLOWED HERE AND NOWHERE IN src/. The ban is a RUNTIME
 * decision: ag-psd's writer peaks at 3.5-4.2x the decoded pixels and silently
 * drops `Patt`, which corrupts pattern fills. This is a 128px document with no
 * patterns, built only for a test. Nothing in src/ imports this file and
 * nothing ships it, so the decision it was banned under is untouched.
 *
 * WHAT THIS CAN AND CANNOT PROVE. It proves the binary path: that `clipping`
 * survives reader.js into `project.layers`, and that runs form from a parsed
 * file the way they form in memory. It CANNOT prove Photoshop parity -- the
 * composite embedded in it is written by our own compositor, so scoring our
 * render against it compares us with ourselves. That is also why it must never
 * be dropped into `fixtures/`: test/run.mjs and test/composite.mjs glob
 * `fixtures/*.src.psd`, and a self-generated file would enter the 12/5/4
 * accuracy table as a free pass. Parity for clipping needs a genuine
 * Photoshop-saved document and is still open.
 */
import { writePsdBuffer } from 'ag-psd';

const W = 128, H = 128;

/** RGBA of exactly W x H, filled by a per-pixel writer. */
const raster = (paint) => {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) paint(data, (y * W + x) * 4, x, y);
  return { width: W, height: H, data };
};

const solid = (r, g, b) =>
  raster((d, i) => { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; });

/**
 * The base of the run: a disc with a soft edge.
 *
 * Deliberately not a hard-edged rectangle. A clip multiplies the clipped
 * layer's alpha by the base's, so a 0-or-255 base would still look right under
 * an implementation that treated the clip as a boolean stencil. The ramp is
 * what makes a wrong one visible.
 */
const disc = raster((d, i, x, y) => {
  const r = Math.hypot(x - W / 2, y - H / 2);
  d[i] = 240; d[i + 1] = 200; d[i + 2] = 60;
  d[i + 3] = Math.max(0, Math.min(255, Math.round((44 - r) * 12)));
});

/**
 * One unclipped backdrop, then a run of three: a base and two layers clipped
 * to it, the upper one on `multiply` so the test can show that blend mode and
 * clipping are carried independently.
 */
export const clippingFixtureBytes = () => new Uint8Array(writePsdBuffer({
  width: W, height: H,
  children: [
    { name: 'backdrop', imageData: solid(30, 40, 90) },
    { name: 'clip base', imageData: disc },
    { name: 'clipped normal', imageData: solid(220, 60, 60), clipping: true },
    { name: 'clipped multiply', imageData: solid(60, 200, 120), clipping: true, blendMode: 'multiply' },
  ],
}));
