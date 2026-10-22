import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import type { BrowserContext } from 'playwright-core';

export interface BrowserSession {
  open(): Promise<BrowserContext>;
  current(): BrowserContext | undefined;
  generation(): string;
  close(): Promise<void>;
}
export class BrowserSessionError extends Error {
  constructor(readonly reason: 'BROWSER_UNAVAILABLE' | 'BROWSER_UNSUPPORTED') {
    super(reason);
    this.name = 'BrowserSessionError';
  }
}
const unavailable = () => new BrowserSessionError('BROWSER_UNAVAILABLE');
const markerName = '.draft-assistant-profile';
const markerValue = 'draft-assistant:judongche:profile:v1\n';
const leasedProfiles = new Set<string>();

// Main must derive this directory beneath app.userData and check containment.
// This second guard prevents adoption of personal profiles or linked locations.
async function claimProfile(directory: string): Promise<void> {
  if (
    !isAbsolute(directory) ||
    /^[\\/]{2}/.test(directory) ||
    directory.includes('\0') ||
    resolve(directory) === parse(directory).root
  )
    throw unavailable();
  const validateAncestors = async () => {
    let cursor = resolve(directory);
    for (;;) {
      try {
        const info = await lstat(cursor);
        if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  };
  await validateAncestors();
  await mkdir(directory, { recursive: true });
  await validateAncestors();
  const marker = join(directory, markerName);
  const entries = await readdir(directory);
  if (entries.length === 0)
    await writeFile(marker, markerValue, { flag: 'wx', mode: 0o600 });
  const info = await lstat(marker);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (await readFile(marker, 'utf8')) !== markerValue
  )
    throw unavailable();
}

export function createBrowserSession(profileDirectory: string): BrowserSession {
  let ready: BrowserContext | undefined;
  let owned: BrowserContext | undefined;
  let opening: Promise<BrowserContext> | undefined;
  let closing: Promise<void> | undefined;
  let generation = randomUUID();
  const leaseKey =
    process.platform === 'win32'
      ? resolve(profileDirectory).toLowerCase()
      : resolve(profileDirectory);
  let leased = false;
  const release = () => {
    if (leased) leasedProfiles.delete(leaseKey);
    leased = false;
  };
  const invalidate = () => {
    ready = undefined;
    generation = randomUUID();
  };
  const dispose = async () => {
    const context = owned;
    if (context) {
      await context.close();
      if (owned === context) owned = undefined;
    }
    release();
  };
  const launch = async (): Promise<BrowserContext> => {
    try {
      if (leasedProfiles.has(leaseKey)) throw unavailable();
      leasedProfiles.add(leaseKey);
      leased = true;
      await claimProfile(profileDirectory);
      if (closing) throw unavailable();
      const { chromium } = await import('playwright-core');
      if (closing) throw unavailable();
      const context = await chromium.launchPersistentContext(profileDirectory, {
        channel: 'msedge',
        headless: false,
        chromiumSandbox: true,
        // Permit the owner-installed official browser connector in this profile.
        ignoreDefaultArgs: ['--disable-extensions'],
        viewport: null,
        acceptDownloads: false,
      });
      owned = context;
      let closed = false;
      context.on('close', () => {
        closed = true;
        if (owned === context) {
          owned = undefined;
          invalidate();
          release();
        }
      });
      let version: string | undefined;
      try {
        version = context.browser()?.version();
      } catch {
        /* Unsupported if no version is available. */
      }
      if (!version || !/^(153|154|155)\./.test(version))
        throw new BrowserSessionError('BROWSER_UNSUPPORTED');
      context.setDefaultTimeout(10_000);
      context.setDefaultNavigationTimeout(30_000);
      if (closing || closed) throw unavailable();
      ready = context;
      generation = randomUUID();
      return context;
    } catch (error) {
      invalidate();
      try {
        await dispose();
      } catch {
        /* Retain ownership and block opens until close succeeds. */
      }
      throw error instanceof BrowserSessionError ? error : unavailable();
    }
  };
  return {
    open() {
      if (closing || (owned && !ready && !opening))
        return Promise.reject(unavailable());
      if (opening) return opening;
      if (ready) return Promise.resolve(ready);
      opening = launch().finally(() => {
        opening = undefined;
      });
      return opening;
    },
    current: () => ready,
    generation: () => generation,
    close() {
      if (closing) return closing;
      invalidate();
      closing = (async () => {
        // Let an in-flight launch acquire and dispose its context before returning.
        if (opening) await opening.catch(() => undefined);
        await dispose();
      })()
        .catch(() => {
          throw unavailable();
        })
        .finally(() => {
          closing = undefined;
        });
      return closing;
    },
  };
}
