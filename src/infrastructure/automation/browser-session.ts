import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
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

/**
 * Edge ignores --hide-crash-restore-bubble for the profile-level restore
 * infobar, so a forced shutdown leaves the first page blocked behind
 * "还原页面" and the automation launch never settles. Reset the recorded exit
 * state before every launch instead of inheriting it.
 */
export async function clearCrashState(directory: string): Promise<void> {
  const preferences = join(directory, 'Default', 'Preferences');
  try {
    const parsed = JSON.parse(await readFile(preferences, 'utf8')) as {
      profile?: { exit_type?: string; exited_safely?: boolean };
    };
    if (!parsed.profile) return;
    if (
      parsed.profile.exit_type === 'Normal' &&
      parsed.profile.exited_safely !== false
    )
      return;
    parsed.profile.exit_type = 'Normal';
    parsed.profile.exited_safely = true;
    await writeFile(preferences, JSON.stringify(parsed));
  } catch {
    // A missing or unreadable file is reported by the launch itself.
  }
}

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

import type { BrowserHealthRuntime } from '../../domain/ports/browser-health';
import {
  BrowserHealthResultSchema,
  BrowserHealthViewSchema,
  type BrowserHealthView,
  type BrowserHealthResult,
} from '../../contracts/browser-health';
import {
  bounded,
  BrowserHealthFailure,
  checkLocalCapabilities,
  parseEdgeVersion,
  type BrowserCapabilityDiagnostic,
} from './browser-health-check';
import { openMaintenancePage } from './browser-maintenance';
export interface ManagedBrowserSession
  extends BrowserSession, BrowserHealthRuntime {}
type Owner = {
  epoch: number;
  revision: number;
  context?: BrowserContext;
  pending: boolean;
  temporary?: string;
  temporaryIdentity?: { dev: bigint; ino: bigint };
  closed: boolean;
  closePromise?: Promise<void>;
  closeAttempted?: boolean;
  disposal?: Promise<void>;
  launchPromise?: Promise<BrowserContext>;
  kind: 'diagnostic' | 'maintenance' | 'business';
  controller: AbortController;
};
export function createBrowserSession(
  profileDirectory: string,
  options: {
    temporaryRoot: string;
    operationEpoch: () => number;
    onBusinessDisconnect?: (
      event: 'browser-disconnected' | 'business-context-closed',
      closeRequested: boolean,
    ) => void;
    onCapabilityDiagnostic?: (event: BrowserCapabilityDiagnostic) => void;
  },
): ManagedBrowserSession {
  let ready: BrowserContext | undefined,
    owner: Owner | undefined,
    opening: Promise<BrowserContext> | undefined,
    closing: Promise<void> | undefined;
  let action: Promise<BrowserHealthResult> | undefined;
  let active = false,
    generation = randomUUID(),
    revision = 0,
    leased = false;
  const listeners = new Set<(view: BrowserHealthView) => void>();
  const leaseKey =
    process.platform === 'win32'
      ? resolve(profileDirectory).toLowerCase()
      : resolve(profileDirectory);
  const publish = (
    status: BrowserHealthView['status'],
    version: string | null = null,
    stage: BrowserHealthView['stage'] = null,
    reason: BrowserHealthView['reason'] = null,
  ): BrowserHealthView => {
    const view = BrowserHealthViewSchema.parse({
      status,
      version,
      stage,
      reason,
    });
    for (const listener of listeners) {
      try {
        listener({ ...view });
      } catch {
        /* A view observer cannot change browser ownership. */
      }
    }
    return view;
  };
  const result = (
    status: BrowserHealthResult['status'],
    view: BrowserHealthView,
  ) => BrowserHealthResultSchema.parse({ status, view });
  const invalidate = () => {
    revision++;
    ready = undefined;
    generation = randomUUID();
  };
  const release = () => {
    if (!active && !owner) {
      if (leased) leasedProfiles.delete(leaseKey);
      leased = false;
    }
  };
  const freeOwner = (record: Owner) => {
    if (owner === record) owner = undefined;
    release();
  };
  const disposeOwner = async (record: Owner): Promise<void> => {
    if (record.pending)
      throw new BrowserHealthFailure('cleanup', 'ownership_unconfirmed');
    if (record.context && !record.closed) {
      if (!record.closePromise) {
        const context = record.context;
        record.closeAttempted = true;
        record.closePromise = Promise.resolve()
          .then(() => context.close())
          .then(() => {
            record.closed = true;
            record.context = undefined;
          })
          .catch((error) => {
            record.closePromise = undefined;
            throw error;
          });
      }
      try {
        await bounded(
          () => record.closePromise!,
          10000,
          new AbortController(),
          'cleanup',
        );
      } catch {
        throw new BrowserHealthFailure('cleanup', 'cleanup_failed');
      }
    }
    if (record.temporary) {
      // Only the exact freshly-created child is removable. Revalidate all ancestors;
      // never delete a live profile, a replacement link, the root, or business state.
      const directory = record.temporary;
      record.temporary = undefined;
      try {
        await bounded(
          async () => {
            const contained = relative(
              resolve(options.temporaryRoot),
              resolve(directory),
            );
            if (
              !contained ||
              contained.startsWith('..') ||
              isAbsolute(contained) ||
              resolve(directory) === resolve(profileDirectory)
            )
              throw unavailable();
            await validateDirectory(directory);
            const identity = await lstat(directory, { bigint: true });
            if (
              identity.dev !== record.temporaryIdentity?.dev ||
              identity.ino !== record.temporaryIdentity?.ino
            )
              throw unavailable();
            await rm(directory, { recursive: true, force: false });
          },
          5000,
          new AbortController(),
          'cleanup',
        );
      } catch {
        freeOwner(record);
        throw new BrowserHealthFailure('cleanup', 'cleanup_failed');
      }
    }
    freeOwner(record);
  };
  const cleanup = (record: Owner): Promise<void> => {
    if (record.disposal) return record.disposal;
    const pending = disposeOwner(record).finally(() => {
      record.disposal = undefined;
    });
    record.disposal = pending;
    return pending;
  };
  const launch = async (
    record: Owner,
    path: string,
  ): Promise<BrowserContext> => {
    const { chromium } = await import('playwright-core');
    if (record.controller.signal.aborted)
      throw new BrowserHealthFailure('launch', 'timeout');
    await clearCrashState(path);
    record.pending = true;
    const pending = Promise.resolve()
      .then(() =>
        chromium.launchPersistentContext(path, {
          channel: 'msedge',
          // Local diagnostics must not take OS focus from the operator's input.
          headless: record.kind === 'diagnostic',
          chromiumSandbox: true,
          ignoreDefaultArgs: ['--disable-extensions'],
          // A forced shutdown leaves profile.exit_type = Crashed; Edge then opens
          // a restore bubble over the first page and the automation launch hangs.
          args: ['--hide-crash-restore-bubble'],
          viewport: null,
          acceptDownloads: false,
          ...(record.kind === 'business'
            ? {}
            : { serviceWorkers: 'block' as const }),
        }),
      )
      .then(
        (context) => {
          record.pending = false;
          record.context = context;
          if (record.kind === 'business' && options.onBusinessDisconnect) {
            const report = (
              event: 'browser-disconnected' | 'business-context-closed',
            ) => {
              try {
                options.onBusinessDisconnect?.(event, !!record.closeAttempted);
              } catch {
                /* Observation only. */
              }
            };
            const browser = context.browser();
            if (browser)
              browser.once('disconnected', () =>
                report('browser-disconnected'),
              );
            else context.once('close', () => report('business-context-closed'));
          }
          context.on('close', () => {
            record.closed = true;
            record.context = undefined;
            const current =
              owner === record &&
              record.epoch === options.operationEpoch() &&
              record.revision === revision;
            if (record.kind === 'business') {
              if (current && ready === context) {
                invalidate();
                publish('unchecked');
              }
              freeOwner(record);
            } else if (record.kind === 'maintenance' || !active) {
              if (current) invalidate();
              const notificationRevision = revision;
              const notify = (failed: boolean) => {
                if (
                  !current ||
                  record.epoch !== options.operationEpoch() ||
                  notificationRevision !== revision
                )
                  return;
                if (failed)
                  publish('check_failed', null, 'cleanup', 'cleanup_failed');
                else publish('unchecked');
              };
              void cleanup(record).then(
                () => notify(false),
                () => notify(true),
              );
            }
          });
          if (record.controller.signal.aborted && !active)
            void cleanup(record).catch(() => {
              if (
                owner === record &&
                record.epoch === options.operationEpoch() &&
                record.revision === revision
              )
                publish('check_failed', null, 'cleanup', 'cleanup_failed');
            });
          return context;
        },
        (error) => {
          record.pending = false;
          if (record.controller.signal.aborted && !active)
            void cleanup(record).catch(() => undefined);
          throw error instanceof Error &&
            /Chromium distribution 'msedge' is not found/.test(error.message)
            ? new BrowserHealthFailure('launch', null, 'missing')
            : error;
        },
      );
    record.launchPromise = pending;
    return bounded(() => pending, 25000, record.controller, 'launch');
  };
  const reserve = () => {
    if (active || closing || owner || leasedProfiles.has(leaseKey))
      throw unavailable();
    leasedProfiles.add(leaseKey);
    leased = true;
    active = true;
  };
  const newOwner = (
    kind: Owner['kind'],
    controller: AbortController,
  ): Owner => {
    const record: Owner = {
      kind,
      controller,
      pending: false,
      closed: false,
      epoch: options.operationEpoch(),
      revision,
    };
    owner = record;
    return record;
  };
  const temporary = async (record: Owner) => {
    const healthRoot = resolve(options.temporaryRoot),
      businessRoot = resolve(profileDirectory);
    const overlaps = (parent: string, child: string) => {
      const value = relative(parent, child);
      return !value || (!value.startsWith('..') && !isAbsolute(value));
    };
    if (
      overlaps(healthRoot, businessRoot) ||
      overlaps(businessRoot, healthRoot)
    )
      throw unavailable();
    await validateDirectory(options.temporaryRoot);
    await mkdir(options.temporaryRoot, { recursive: true });
    await validateDirectory(options.temporaryRoot);
    record.temporary = await mkdtemp(
      join(options.temporaryRoot, record.kind + '-'),
    );
    await validateDirectory(record.temporary);
    const identity = await lstat(record.temporary, { bigint: true });
    record.temporaryIdentity = { dev: identity.dev, ino: identity.ino };
    return record.temporary;
  };
  const assertCurrent = (
    controller: AbortController,
    epoch: number,
    token: number,
  ) => {
    if (
      controller.signal.aborted ||
      options.operationEpoch() !== epoch ||
      revision !== token ||
      closing
    )
      throw new BrowserHealthFailure('launch', 'timeout');
  };
  const readVersion = (context: BrowserContext) => {
    try {
      return parseEdgeVersion(context.browser()?.version());
    } catch {
      return null;
    }
  };
  const diagnostic = async (
    controller: AbortController,
    epoch: number,
    token: number,
  ): Promise<string> => {
    const record = newOwner('diagnostic', controller);
    const path = await temporary(record);
    assertCurrent(controller, epoch, token);
    publish('checking', null, 'launch');
    const context = await launch(record, path);
    assertCurrent(controller, epoch, token);
    const version = readVersion(context);
    if (!version)
      throw new BrowserHealthFailure('version', null, 'unknown_version');
    if (version.major < 153) {
      publish('too_old', version.full, 'version');
      throw new BrowserHealthFailure('version', null, 'too_old', version.full);
    }
    publish('checking', version.full, 'evaluate');
    try {
      // The matrix owns its 45s capability budget, excluding page/context close.
      await checkLocalCapabilities(
        context,
        controller.signal,
        options.onCapabilityDiagnostic,
      );
      assertCurrent(controller, epoch, token);
      if (record.closed)
        throw new BrowserHealthFailure('cleanup', 'ownership_unconfirmed');
      await cleanup(record);
      assertCurrent(controller, epoch, token);
    } catch (error) {
      const fault =
        error instanceof BrowserHealthFailure
          ? error
          : new BrowserHealthFailure('evaluate');
      throw new BrowserHealthFailure(
        fault.stage,
        fault.reason,
        fault.status,
        version.full,
      );
    }
    return version.full;
  };
  const failure = async (
    error: unknown,
    version: string | null,
    epoch: number,
    token: number,
  ): Promise<BrowserHealthView> => {
    let fault =
      error instanceof BrowserHealthFailure
        ? error
        : new BrowserHealthFailure('launch', null, 'unavailable');
    if (
      owner &&
      !owner.pending &&
      !(fault.stage === 'cleanup' && owner.closeAttempted)
    ) {
      try {
        await cleanup(owner);
      } catch {
        fault = new BrowserHealthFailure('cleanup', 'cleanup_failed');
      }
    }
    const view = BrowserHealthViewSchema.parse({
      status: fault.status,
      version: fault.version ?? version,
      stage: fault.stage,
      reason: fault.reason,
    });
    // Cleanup remains mandatory, but a stopped/replaced operation owns no new UI state.
    return epoch === options.operationEpoch() && token === revision
      ? publish(view.status, view.version, view.stage, view.reason)
      : view;
  };
  const busy = (): BrowserHealthResult =>
    result(
      'blocked',
      publish(
        'busy',
        null,
        null,
        ready
          ? 'business_open'
          : owner?.kind === 'maintenance'
            ? 'maintenance_open'
            : 'ownership_unconfirmed',
      ),
    );
  const operate = async (
    kind: 'diagnostic' | 'maintenance',
  ): Promise<BrowserHealthResult> => {
    if (ready || active || closing || owner || leasedProfiles.has(leaseKey))
      return busy();
    reserve();
    invalidate();
    const token = revision,
      epoch = options.operationEpoch(),
      controller = new AbortController();
    try {
      if (kind === 'diagnostic') {
        const version = await diagnostic(controller, epoch, token);
        return result('ok', publish('passed', version));
      }
      const record = newOwner('maintenance', controller);
      const path = await temporary(record);
      assertCurrent(controller, epoch, token);
      const context = await launch(record, path);
      assertCurrent(controller, epoch, token);
      await openMaintenancePage(context, controller.signal);
      assertCurrent(controller, epoch, token);
      if (record.closed)
        throw new BrowserHealthFailure(
          'update',
          'update_unavailable',
          'unavailable',
        );
      return result('ok', publish('update_open'));
    } catch (error) {
      controller.abort();
      return result('blocked', await failure(error, null, epoch, token));
    } finally {
      active = false;
      release();
    }
  };
  const startOperation = (
    kind: 'diagnostic' | 'maintenance',
  ): Promise<BrowserHealthResult> => {
    if (ready || active || closing || owner || leasedProfiles.has(leaseKey))
      return Promise.resolve(busy());
    const pending = operate(kind);
    action = pending;
    void pending.then(() => {
      if (action === pending) action = undefined;
    });
    return pending;
  };
  return {
    open() {
      if (closing) return Promise.reject(unavailable());
      if (opening) return opening;
      if (ready) return Promise.resolve(ready);
      try {
        reserve();
      } catch {
        return Promise.reject(unavailable());
      }
      invalidate();
      const token = revision,
        epoch = options.operationEpoch(),
        controller = new AbortController();
      opening = (async () => {
        let version: string | null = null;
        try {
          await claimProfile(profileDirectory);
          assertCurrent(controller, epoch, token);
          version = await diagnostic(controller, epoch, token);
          const expires = Date.now() + 30000;
          assertCurrent(controller, epoch, token);
          const record = newOwner('business', controller);
          const context = await launch(record, profileDirectory);
          assertCurrent(controller, epoch, token);
          const actual = readVersion(context);
          if (!actual || actual.full !== version) {
            version = actual?.full ?? null;
            throw new BrowserHealthFailure('version', 'version_changed');
          }
          if (Date.now() >= expires)
            throw new BrowserHealthFailure('launch', 'timeout');
          if (record.closed)
            throw new BrowserHealthFailure('launch', 'ownership_unconfirmed');
          context.setDefaultTimeout(10000);
          context.setDefaultNavigationTimeout(30000);
          ready = context;
          generation = randomUUID();
          publish('passed', version);
          return context;
        } catch (error) {
          controller.abort();
          const view = await failure(error, version, epoch, token);
          throw new BrowserSessionError(
            ['too_old', 'unknown_version'].includes(view.status) ||
              view.reason === 'version_changed' ||
              view.reason === 'capability_failed'
              ? 'BROWSER_UNSUPPORTED'
              : 'BROWSER_UNAVAILABLE',
          );
        } finally {
          active = false;
          opening = undefined;
          release();
        }
      })();
      return opening;
    },
    current: () => ready,
    generation: () => generation,
    close() {
      if (closing) return closing;
      invalidate();
      const closeEpoch = options.operationEpoch(),
        closeRevision = revision;
      owner?.controller.abort();
      closing = bounded(
        async () => {
          if (opening) await opening.catch(() => undefined);
          if (action) await action;
          if (owner?.pending && owner.launchPromise)
            await owner.launchPromise.catch(() => undefined);
          if (owner) await cleanup(owner);
        },
        10000,
        new AbortController(),
        'cleanup',
      )
        .then(() => {
          if (
            !owner &&
            closeEpoch === options.operationEpoch() &&
            closeRevision === revision
          )
            publish('unchecked');
        })
        .catch(() => {
          throw unavailable();
        })
        .finally(() => {
          closing = undefined;
          release();
        });
      return closing;
    },
    checkHealth: () => startOperation('diagnostic'),
    openUpdate: () => startOperation('maintenance'),
    invalidateHealth() {
      invalidate();
      owner?.controller.abort();
      publish('unchecked');
    },
    isOccupied: () => active || !!closing || (!!owner && !ready),
    hasBusinessSession: () => !!ready,
    subscribeHealth(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
async function validateDirectory(directory: string): Promise<void> {
  if (
    !isAbsolute(directory) ||
    /^[\\/]{2}/.test(directory) ||
    directory.includes('\0') ||
    resolve(directory) === parse(directory).root
  )
    throw unavailable();
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
}
