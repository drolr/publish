import {
  ManualFragmentV2Schema,
  type ManualFragmentV2,
} from '../../contracts/manual-rich-draft';
import {
  cloneManualFragment,
  manualFragmentText,
} from '../../domain/manual-draft-version';
import { createHash, randomUUID } from 'node:crypto';
import type { ManualImage } from '../../contracts/manual-article';
import type {
  ClipboardFragmentPort,
  ManualClipboard,
} from '../../domain/ports/manual-clipboard';
import type { ManualImageSource } from '../../domain/ports/manual-images';
import { WebPasteFailure } from '../../domain/web-paste-error';
import {
  encodeManualClipboardFragment,
  parseManualClipboardFragment,
} from '../../contracts/editor-close';
interface Grant {
  id: string;
  expires: number;
  fragment: ManualFragmentV2;
  images: ManualImage[];
  reads: Set<Promise<unknown>>;
  timer?: ReturnType<typeof setTimeout>;
  retirement?: Promise<void>;
  fingerprints: Map<string, string>;
  target?: { sessionId: string; aliases: Map<string, ManualImage> };
}
const MAX_BYTES = 200 * 1024 * 1024;
const TTL = 10 * 60 * 1000;
/** The native port never accepts caller-supplied HTML and reads only its own active write. */
export function createClipboardFragmentPort(clipboard: {
  write(data: { text: string; html: string }): Promise<void>;
  readBack(): Promise<{ text: string; html: string }>;
}): ClipboardFragmentPort {
  return {
    async write(grantId, selectedText) {
      const html = encodeManualClipboardFragment(grantId, selectedText);
      if (
        Buffer.byteLength(html) + Buffer.byteLength(selectedText) >
        2 * 1024 * 1024
      )
        throw new WebPasteFailure('INPUT_LIMIT');
      await clipboard.write({ text: selectedText, html });
      const actual = await clipboard.readBack();
      if (
        actual.text !== selectedText ||
        parseManualClipboardFragment(actual.html) !== grantId
      )
        throw new WebPasteFailure('INPUT_LIMIT');
    },
  };
}
/** Exactly one active grant; old, replacement and retiring reads share one reservation. */
export function createManualClipboard(
  images: ManualImageSource,
  writer: ClipboardFragmentPort,
  clock: () => number = Date.now,
): ManualClipboard {
  let current: Grant | undefined,
    busy = false,
    closing = false,
    failure: unknown;
  let reservedBytes = 0,
    reservedImages = 0;
  const owned = new Set<Grant>();
  const operations = new Set<Promise<unknown>>();
  function retire(grant: Grant): Promise<void> {
    if (grant.retirement) return grant.retirement;
    if (grant.timer) clearTimeout(grant.timer);
    grant.retirement = (async () => {
      await Promise.allSettled([...grant.reads]);
      await images.release(grant.id);
      if (owned.delete(grant)) {
        reservedBytes -= grant.images.reduce((n, i) => n + i.byteSize, 0);
        reservedImages -= grant.images.length;
      }
    })().catch((error) => {
      failure = error;
      throw error;
    });
    return grant.retirement;
  }
  function track<T>(promise: Promise<T>): Promise<T> {
    operations.add(promise);
    return promise.finally(() => operations.delete(promise));
  }
  return {
    isReady: () =>
      !closing && !failure && ![...owned].some((g) => g.retirement),
    copy(sessionId, fragment, sourceImages, signal) {
      if (closing || busy || failure)
        return Promise.reject(new WebPasteFailure('RECOVERY_REQUIRED'));
      const parsed = ManualFragmentV2Schema.safeParse(fragment);
      if (!parsed.success)
        return Promise.reject(new WebPasteFailure('INPUT_LIMIT'));
      const blocks = parsed.data.blocks;
      if (
        blocks.some((b) => b.type === 'image-pending') ||
        blocks.filter((b) => b.type === 'image').length > 200
      )
        return Promise.reject(new WebPasteFailure('INPUT_LIMIT'));
      const tokens = [
        ...new Set(
          blocks.flatMap((b) => (b.type === 'image' ? [b.imageToken] : [])),
        ),
      ];
      const selected = tokens.map((t) =>
        sourceImages.find((i) => i.imageToken === t),
      );
      if (selected.some((i) => !i))
        return Promise.reject(new WebPasteFailure('INPUT_LIMIT'));
      const bytes = selected.reduce((n, i) => n + i!.byteSize, 0);
      if (
        reservedBytes + bytes > MAX_BYTES ||
        reservedImages + selected.length > 200
      )
        return Promise.reject(new WebPasteFailure('IMAGE_LIMIT'));
      busy = true;
      reservedBytes += bytes;
      reservedImages += selected.length;
      const grant: Grant = {
        id: randomUUID(),
        expires: clock() + TTL,
        fragment: { version: 2, blocks: [], openStart: false, openEnd: false },
        images: [],
        reads: new Set(),
        fingerprints: new Map(),
      };
      owned.add(grant);
      // Reserve the complete proposed budget before any async ownership preparation.
      grant.images = selected.map((i) => ({ ...i! }));
      return track(
        (async () => {
          try {
            const aliases = new Map<string, string>();
            const origin = new Map<string, ManualImage>();
            const ready: ManualImage[] = [];
            for (const image of selected) {
              signal.throwIfAborted();
              const value = await images.read(
                sessionId,
                image!.imageToken,
                signal,
              );
              const copied = await images.authorizeBytes(
                grant.id,
                value.bytes,
                signal,
              );
              if (
                copied.byteSize !== image!.byteSize ||
                copied.mime !== image!.mime
              )
                throw new WebPasteFailure('IMAGE_INVALID');
              aliases.set(image!.imageToken, copied.imageToken);
              grant.fingerprints.set(
                copied.imageToken,
                createHash('sha256').update(value.bytes).digest('hex'),
              );
              origin.set(copied.imageToken, { ...image! });
              ready.push(copied);
            }
            grant.images = ready;
            grant.target = { sessionId, aliases: origin };
            grant.fragment = cloneManualFragment(
              parsed.data,
              undefined,
              (token) => aliases.get(token)!,
            );
            const text = manualFragmentText(parsed.data);
            signal.throwIfAborted();
            if (closing) throw new WebPasteFailure('CANCELLED');
            await writer.write(grant.id, text);
            signal.throwIfAborted();
            if (closing) throw new WebPasteFailure('CANCELLED');
            const previous = current;
            current = grant;
            grant.timer = setTimeout(() => {
              if (current === grant) current = undefined;
              void track(retire(grant)).catch((error) => {
                failure = error;
              });
            }, TTL);
            grant.timer.unref?.();
            if (previous) await retire(previous);
          } catch (error) {
            if (current !== grant) {
              try {
                await retire(grant);
              } catch (cleanup) {
                failure = cleanup;
                throw new WebPasteFailure('RECOVERY_REQUIRED');
              }
            }
            if (failure) throw new WebPasteFailure('RECOVERY_REQUIRED');
            if (signal.aborted) throw new WebPasteFailure('CANCELLED');
            throw error instanceof WebPasteFailure
              ? error
              : new WebPasteFailure('INPUT_LIMIT');
          } finally {
            busy = false;
          }
        })(),
      );
    },
    paste(grantId, sessionId, signal, retainedTokens, capacity) {
      const grant = current;
      if (closing || busy || failure)
        return Promise.reject(new WebPasteFailure('RECOVERY_REQUIRED'));
      if (!grant || grant.id !== grantId || clock() >= grant.expires)
        return Promise.reject(new WebPasteFailure('INPUT_LIMIT'));
      const retained = new Set(retainedTokens);
      const existing = new Map<string, ManualImage>();
      const newFingerprints = new Map<string, number>();
      for (const image of grant.images) {
        const fingerprint = grant.fingerprints.get(image.imageToken)!;
        const cached =
          grant.target?.sessionId === sessionId
            ? grant.target.aliases.get(image.imageToken)
            : undefined;
        const owned =
          cached && retained.has(cached.imageToken)
            ? cached
            : images.findEquivalent?.(sessionId, fingerprint, retainedTokens);
        if (owned) existing.set(image.imageToken, owned);
        else newFingerprints.set(fingerprint, image.byteSize);
      }
      const retainedImages = new Map(
        capacity?.images.map((i) => [i.imageToken, i]),
      );
      if (
        capacity &&
        (retainedImages.size + capacity.candidates + newFingerprints.size >
          200 ||
          [...retainedImages.values()].reduce((n, i) => n + i.byteSize, 0) +
            [...newFingerprints.values()].reduce((n, bytes) => n + bytes, 0) >
            MAX_BYTES)
      )
        return Promise.reject(new WebPasteFailure('IMAGE_LIMIT'));
      busy = true;
      const operation = (async () => {
        try {
          const aliases = new Map<string, string>();
          const ready: ManualImage[] = [];
          const prepared = new Map<string, ManualImage>();
          const targetAliases = new Map<string, ManualImage>();
          for (const image of grant.images) {
            signal.throwIfAborted();
            const value = await images.read(grant.id, image.imageToken, signal);
            const fingerprint = grant.fingerprints.get(image.imageToken)!;
            if (
              createHash('sha256').update(value.bytes).digest('hex') !==
                fingerprint ||
              value.mime !== image.mime ||
              value.bytes.byteLength !== image.byteSize
            )
              throw new WebPasteFailure('IMAGE_INVALID');
            let copied =
              existing.get(image.imageToken) ?? prepared.get(fingerprint);
            if (copied) {
              const verified = await images.read(
                sessionId,
                copied.imageToken,
                signal,
              );
              if (
                createHash('sha256').update(verified.bytes).digest('hex') !==
                  fingerprint ||
                copied.byteSize !== image.byteSize ||
                copied.mime !== image.mime ||
                copied.width !== image.width ||
                copied.height !== image.height
              )
                throw new WebPasteFailure('IMAGE_INVALID');
            } else
              copied = await images.authorizeBytes(
                sessionId,
                value.bytes,
                signal,
              );
            prepared.set(fingerprint, copied);
            targetAliases.set(image.imageToken, copied);
            aliases.set(image.imageToken, copied.imageToken);
            ready.push(copied);
          }
          signal.throwIfAborted();
          grant.target = { sessionId, aliases: targetAliases };
          return {
            fragment: cloneManualFragment(grant.fragment, randomUUID, (token) =>
              aliases.get(token)!,
            ),
            images: ready,
          };
        } catch (error) {
          try {
            await images.retain(sessionId, retainedTokens);
          } catch {
            throw new WebPasteFailure('RECOVERY_REQUIRED');
          }
          throw error;
        } finally {
          busy = false;
        }
      })();
      grant.reads.add(operation);
      return track(operation.finally(() => grant.reads.delete(operation)));
    },
    async drain() {
      closing = true;
      await Promise.allSettled([...operations]);
      current = undefined;
      for (const grant of owned) await retire(grant);
      if (failure) throw new WebPasteFailure('RECOVERY_REQUIRED');
    },
  };
}
