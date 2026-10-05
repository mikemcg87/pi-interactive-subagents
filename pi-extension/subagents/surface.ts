/**
 * Multiplexer dispatch — the one surface `index.ts` talks to.
 *
 * Picks a backend from the environment at call time: herdr when pi runs inside
 * a herdr pane (`HERDR_ENV=1`), otherwise tmux. Both backends expose the same
 * functions, so the choice is invisible to callers.
 */
import * as tmux from "./tmux.ts";
import * as herdr from "./herdr.ts";

export { shellEscape } from "./shell.ts";

export type SurfaceDirection = "left" | "right" | "up" | "down";

export interface PollOptions {
  interval: number;
  sessionFile?: string;
  sentinelFile?: string;
  onTick?: (elapsed: number) => void;
}

function useHerdr(): boolean {
  return herdr.isHerdrAvailable();
}

/**
 * True when any supported multiplexer is available in this process.
 */
export function isMuxAvailable(): boolean {
  return herdr.isHerdrAvailable() || tmux.isTmuxAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside a supported terminal multiplexer: herdr (run pi in a herdr pane) or tmux (`tmux new -A -s pi 'pi'`).";
}

export function createSurface(name: string): string {
  return useHerdr() ? herdr.createSurface(name) : tmux.createSurface(name);
}

export function createSurfaceSplit(
  name: string,
  direction: SurfaceDirection,
  fromSurface?: string,
): string {
  return useHerdr()
    ? herdr.createSurfaceSplit(name, direction, fromSurface)
    : tmux.createSurfaceSplit(name, direction, fromSurface);
}

export function sendCommand(surface: string, command: string): void {
  (useHerdr() ? herdr : tmux).sendCommand(surface, command);
}

export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  return useHerdr()
    ? herdr.sendLongCommand(surface, command, options)
    : tmux.sendLongCommand(surface, command, options);
}

export function readScreen(surface: string, lines = 50): string {
  return useHerdr() ? herdr.readScreen(surface, lines) : tmux.readScreen(surface, lines);
}

export function readScreenAsync(surface: string, lines = 50): Promise<string> {
  return useHerdr() ? herdr.readScreenAsync(surface, lines) : tmux.readScreenAsync(surface, lines);
}

export function closeSurface(surface: string): void {
  (useHerdr() ? herdr : tmux).closeSurface(surface);
}

export function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: PollOptions,
): Promise<tmux.PollResult> {
  return useHerdr()
    ? herdr.pollForExit(surface, signal, options)
    : tmux.pollForExit(surface, signal, options);
}
