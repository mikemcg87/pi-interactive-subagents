/**
 * herdr surface layer — a second terminal-multiplexer backend for subagents.
 *
 * Mirrors the exact API of `tmux.ts` so `surface.ts` can pick a backend at
 * runtime: herdr when pi runs inside a herdr pane (`HERDR_ENV=1`), otherwise
 * tmux. Everything the extension does to a pane goes through this file:
 * create/split a pane, type into it, read its screen, close it, poll for exit.
 *
 * Panes are herdr pane ids (e.g. `wK:p2`). Splits always target the parent pi's
 * pane (`$HERDR_PANE_ID`) so they follow the agent rather than the user's focus.
 *
 * herdr's CLI returns JSON envelopes shaped `{ "result": { … }, "id": … }`;
 * reads are requested with `--format text` and come back as raw screen text.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { shellEscape } from "./shell.ts";

const execFileAsync = promisify(execFile);

export { shellEscape };

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside a herdr pane with the herdr binary on PATH.
 * `HERDR_ENV` is set to "1" by herdr in every process it spawns; `HERDR_PANE_ID`
 * identifies the pane to split from.
 */
export function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID && hasCommand("herdr");
}

export function isMuxAvailable(): boolean {
  return isHerdrAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside herdr (`herdr`, or a herdr session) and run it in a pane.";
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error(`herdr is required for subagents. ${muxSetupHint()}`);
  }
}

// ── herdr CLI helpers ──

/**
 * Run a herdr subcommand and return its trimmed stdout.
 * herdr prints one JSON envelope per call; callers that need a field parse it.
 */
function herdr(args: string[]): string {
  return execFileSync("herdr", args, { encoding: "utf8" }).trim();
}

/** Parse the `result` object of a herdr JSON envelope. */
function herdrResult<T = Record<string, unknown>>(stdout: string): T {
  const parsed = JSON.parse(stdout) as { result?: T; error?: { code?: string; message?: string } };
  if (parsed.error) {
    throw new Error(`herdr: ${parsed.error.code ?? "error"}: ${parsed.error.message ?? "unknown"}`);
  }
  if (!parsed.result) {
    throw new Error(`herdr: unexpected response: ${stdout.slice(0, 200)}`);
  }
  return parsed.result;
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent: a right split off the parent pi's pane,
 * so new panes follow the agent rather than the user's focus.
 *
 * Returns the new pane id (e.g. `wK:p2`).
 */
export function createSurface(name: string): string {
  void name; // herdr panes carry their own title; the pi process sets it.
  return createSurfaceSplit(name, "right", process.env.HERDR_PANE_ID);
}

/**
 * Create a new split in the given direction from an optional source pane.
 *
 * herdr only splits `right` and `down` (tmux also offers `left`/`up`), so those
 * directions map down to the nearest supported one.
 *
 * Returns the new pane id (e.g. `wK:p2`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name;
  requireHerdr();

  const herdrDirection = direction === "left" || direction === "up" ? "right" : direction;
  const args = ["pane", "split", "--direction", herdrDirection];
  if (fromSurface) {
    args.push("--pane", fromSurface);
  }

  const result = herdrResult<{ pane?: { pane_id?: string } }>(herdr(args));
  const pane = result.pane?.pane_id;
  if (!pane) {
    throw new Error(`Unexpected herdr pane split output: ${JSON.stringify(result)}`);
  }
  return pane;
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (no key interpretation), then submitted with Enter.
 */
export function sendCommand(surface: string, command: string): void {
  requireHerdr();
  herdr(["pane", "send-text", surface, command]);
  herdr(["pane", "send-keys", surface, "Enter"]);
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireHerdr();
  return execFileSync(
    "herdr",
    ["pane", "read", surface, "--lines", `${Math.max(1, lines)}`, "--format", "text"],
    { encoding: "utf8" },
  );
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireHerdr();
  const { stdout } = await execFileAsync(
    "herdr",
    ["pane", "read", surface, "--lines", `${Math.max(1, lines)}`, "--format", "text"],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireHerdr();
  herdr(["pane", "close", surface]);
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Kept identical to the tmux backend so both decode the
 * payload the same way.
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
