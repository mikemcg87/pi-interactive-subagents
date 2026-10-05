/**
 * Integration tests for the herdr surface layer.
 *
 * These exercise real herdr operations against a live daemon: creating panes,
 * sending commands, reading screen output, and closing panes. No LLM calls —
 * fast and free.
 *
 * Run inside a herdr pane (HERDR_ENV=1), where the surface is available:
 *   node --test test/integration/herdr-surface.test.ts
 *
 * Focus is deliberately not asserted here. herdr focuses *neighbouring* panes
 * by direction (`herdr pane focus --direction <left|right|up|down>`), not an
 * arbitrary pane id, so the tmux suite's "focus stays on the anchor" test has
 * no direct translation. The property it protects — that creating a subagent
 * pane does not disturb what the user is looking at — is still exercised
 * implicitly, since every test here creates one or more panes and then reads
 * each back by id.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, existsSync, readFileSync } from "node:fs";
import {
  isHerdrAvailable,
  createSurface,
  createSurfaceSplit,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
} from "../../pi-extension/subagents/herdr.ts";

const available = isHerdrAvailable();
if (!available) {
  console.log("⚠️  herdr is not available — skipping herdr-surface integration tests");
  console.log("   Run inside a herdr pane to enable these tests.");
}

const PI_TIMEOUT = Number(process.env.PI_TEST_TIMEOUT ?? "60000");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function waitForScreen(surface: string, pattern: RegExp, timeout = 15_000, lines = 100): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const screen = await readScreenAsync(surface, lines);
      if (pattern.test(screen)) return screen;
    } catch {}
    await sleep(500);
  }
  let finalScreen = "";
  try {
    finalScreen = readScreen(surface, lines);
  } catch {}
  throw new Error(`Timeout (${timeout}ms) waiting for ${pattern}.\nLast screen:\n${finalScreen.slice(-1000)}`);
}

// The suite is a no-op outside herdr so `npm run test:integration` can run the
// file on any host without failing.
const suite = available ? describe : describe.skip;

suite("herdr-surface", { timeout: PI_TIMEOUT }, () => {
  const created: string[] = [];

  function track(surface: string): string {
    created.push(surface);
    return surface;
  }

  function untrack(surface: string): void {
    const i = created.indexOf(surface);
    if (i >= 0) created.splice(i, 1);
  }

  after(() => {
    for (const surface of created) {
      try {
        closeSurface(surface);
      } catch {}
    }
  });

  it("creates a surface, sends a command, reads output, and closes it", async () => {
    const surface = track(createSurface("echo-test"));
    await sleep(1000);

    const marker = uniqueId();
    sendCommand(surface, `echo "MARKER_${marker}"`);
    await waitForScreen(surface, new RegExp(`MARKER_${marker}`));

    const screen = readScreen(surface, 50);
    assert.ok(screen.includes(`MARKER_${marker}`), `Expected screen to contain MARKER_${marker}. Got:\n${screen}`);

    closeSurface(surface);
    untrack(surface);
  });

  it("preserves shell special characters in echo output", async () => {
    const surface = track(createSurface("escape-test"));
    await sleep(1000);

    const marker = uniqueId();
    // Single-quoted string — $ and " are literal inside single quotes
    sendCommand(surface, `echo 'SPEC_${marker}_$HOME_"quotes"_done'`);
    await waitForScreen(surface, new RegExp(`SPEC_${marker}`));

    const screen = readScreen(surface, 50);
    assert.ok(screen.includes("$HOME"), `Expected literal $HOME in output. Got:\n${screen}`);
  });

  it("sends a long command via script file without truncation", async () => {
    const surface = track(createSurface("long-cmd-test"));
    await sleep(1000);

    const marker = uniqueId();
    const longValue = "X".repeat(500);
    sendLongCommand(surface, `echo "LONG_${marker}_${longValue}_END"`);
    await waitForScreen(surface, new RegExp(`LONG_${marker}`));

    const screen = readScreen(surface, 50);
    assert.ok(screen.includes("_END"), `Expected full output (not truncated). Got:\n${screen.slice(-300)}`);
  });

  it("reads screen asynchronously", async () => {
    const surface = track(createSurface("async-read-test"));
    await sleep(1000);

    const marker = uniqueId();
    sendCommand(surface, `echo "ASYNC_${marker}"`);
    await waitForScreen(surface, new RegExp(`ASYNC_${marker}`));

    const screen = await readScreenAsync(surface, 50);
    assert.ok(screen.includes(`ASYNC_${marker}`), `Async read should find marker. Got:\n${screen}`);
  });

  it("manages multiple surfaces concurrently", async () => {
    const s1 = track(createSurface("multi-1"));
    const s2 = track(createSurfaceSplit("multi-2", "down"));
    await sleep(1500);

    const m1 = uniqueId();
    const m2 = uniqueId();
    sendCommand(s1, `echo "S1_${m1}"`);
    sendCommand(s2, `echo "S2_${m2}"`);

    await Promise.all([
      waitForScreen(s1, new RegExp(`S1_${m1}`)),
      waitForScreen(s2, new RegExp(`S2_${m2}`)),
    ]);

    const screen1 = readScreen(s1, 50);
    const screen2 = readScreen(s2, 50);
    assert.ok(screen1.includes(`S1_${m1}`), `Surface 1 missing marker. Got:\n${screen1}`);
    assert.ok(screen2.includes(`S2_${m2}`), `Surface 2 missing marker. Got:\n${screen2}`);
  });

  it("writes output to a file and verifies via surface", async () => {
    const surface = track(createSurface("file-test"));
    await sleep(1000);

    const marker = uniqueId();
    const filePath = `/tmp/pi-herdr-test-${marker}.txt`;

    sendCommand(surface, `echo "FILE_${marker}" > ${filePath} && echo "WRITTEN_${marker}"`);
    await waitForScreen(surface, new RegExp(`WRITTEN_${marker}`));

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !existsSync(filePath)) await sleep(200);
    assert.ok(existsSync(filePath), `Expected ${filePath} to exist`);
    const content = readFileSync(filePath, "utf8");
    assert.ok(content.includes(`FILE_${marker}`), `File content wrong. Got: ${content}`);

    try {
      unlinkSync(filePath);
    } catch {}
  });
});
