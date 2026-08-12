/**
 * Launching a Chrome that is safe to instrument.
 *
 * Always a throwaway profile: attaching to a browser the user is signed into
 * risks touching their session, and a shared profile makes runs non-repeatable.
 * This never reuses, and never kills, an existing browser.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Chrome writes the port it chose here when started with `--remote-debugging-port=0`. */
async function readActivePort(profile: string): Promise<number | null> {
  try {
    const [line] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
    const n = Number(line);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export interface LaunchOptions {
  /** Path to a Chrome/Chromium binary. */
  executablePath: string;
  /**
   * Debugging port. Omit — or pass 0 — to let Chrome choose a free one, which
   * is the safe default: a fixed port collides with any browser the user
   * already has open for debugging, and we must never disturb that.
   */
  port?: number;
  headless?: boolean;
  /** Extra flags. `--user-data-dir` and the debugging port are always ours. */
  args?: string[];
  startupTimeoutMs?: number;
}

export interface LaunchedChrome {
  process: ChildProcess;
  browserURL: string;
  /** Kills only the process we spawned and removes only the profile we made. */
  kill: () => Promise<void>;
}

export async function launchChrome(options: LaunchOptions): Promise<LaunchedChrome> {
  const port = options.port ?? 0;
  const profile = await mkdtemp(join(tmpdir(), 'webcodecs-census-'));

  const proc = spawn(
    options.executablePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      ...(options.headless === false ? [] : ['--headless=new']),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-backgrounding-occluded-windows',
      ...(options.args ?? []),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let exited: Error | null = null;
  proc.once('exit', (code) => {
    exited ??= new Error(`Chrome exited with code ${code} before the debugging port opened`);
  });

  // With port 0 Chrome writes the port it actually chose into the profile.
  const deadline = Date.now() + (options.startupTimeoutMs ?? 20_000);
  let browserURL = '';
  for (;;) {
    if (exited) {
      await rm(profile, { recursive: true, force: true });
      throw exited;
    }
    try {
      const actual = port || (await readActivePort(profile));
      if (actual) {
        const candidate = `http://127.0.0.1:${actual}`;
        const res = await fetch(`${candidate}/json/version`);
        if (res.ok) {
          browserURL = candidate;
          break;
        }
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      await rm(profile, { recursive: true, force: true });
      throw new Error(
        `Chrome did not expose a debugging port in time` + (port ? ` on ${port}` : ''),
      );
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  return {
    process: proc,
    browserURL,
    kill: async () => {
      if (!proc.killed) proc.kill('SIGKILL');
      await rm(profile, { recursive: true, force: true });
    },
  };
}
