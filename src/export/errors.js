/**
 * One error type for the whole export path, carrying a machine-readable code.
 *
 * Export has several distinguishable failure modes -- a changed source file, a
 * truncated spill, a vanished text layer, a cancellation -- and the UI needs to
 * tell them apart to say something useful. A bare Error with a prose message
 * forces the caller to match on strings.
 */
export class ExportError extends Error {
  /**
   * @param {string} message  Shown to the user. Name the layer or the file.
   * @param {string} code     One of: CANCELLED, SOURCE_CHANGED, SOURCE_MISMATCH,
   *   NO_IDENTITY, TEXT_MISSING, SPILL_CORRUPT, SPILL_TRUNCATED, SPILL_MISSING,
   *   INCOMPLETE.
   */
  constructor(message, code) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}
