/**
 * Shell quoting shared by the multiplexer surfaces.
 *
 * Keeping it here (rather than in one backend) lets every surface quote
 * commands identically without importing another backend.
 */

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
