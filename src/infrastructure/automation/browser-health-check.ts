import { randomUUID } from 'node:crypto';
import type { BrowserContext } from 'playwright-core';
import type { BrowserHealthView } from '../../contracts/browser-health';
export class BrowserHealthFailure extends Error {
  constructor(
    readonly stage: BrowserHealthView['stage'],
    readonly reason: BrowserHealthView['reason'] = 'capability_failed',
    readonly status: BrowserHealthView['status'] = 'check_failed',
    readonly version: string | null = null,
  ) {
    super('Browser health check failed');
  }
}
export function parseEdgeVersion(
  value: unknown,
): { full: string; major: number } | null {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(value))
    return null;
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) return null;
  return { full: value, major: parts[0] };
}
export function bounded<T>(
  work: () => Promise<T>,
  milliseconds: number,
  controller: AbortController,
  stage: BrowserHealthView['stage'],
): Promise<T> {
  if (controller.signal.aborted)
    return Promise.reject(new BrowserHealthFailure(stage, 'timeout'));
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      reject(new BrowserHealthFailure(stage, 'timeout'));
    };
    const timer = setTimeout(() => controller.abort(), milliseconds);
    controller.signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(work)
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', abort);
      });
  });
}
// One immutable, synthetic PNG; no filesystem or remote content participates.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1kAAAAASUVORK5CYII=',
  'base64',
);
export interface BrowserEditorDiagnostic {
  innerTextMatches: boolean;
  innerTextLength: number;
  innerTextLf: number;
  innerTextCr: number;
  textContentLength: number;
  selectionAvailable: boolean | null;
  selectionMatches: boolean | null;
  selectionLength: number | null;
  selectionLf: number | null;
  prefixMatches: boolean | null;
  orderMatches: boolean | null;
  connected: boolean;
  focused: boolean;
  documentFocused: boolean;
  visible: boolean;
  firstMismatchIndex: number | null;
  singleDeletionMatches: boolean;
  extraPosition: number | null;
  extraCategory:
    | 'whitespace'
    | 'zero_width'
    | 'control'
    | 'cjk'
    | 'latin'
    | 'number'
    | 'other'
    | null;
  whitespaceCount: number;
  zeroWidthCount: number;
}
export type BrowserCapabilityDiagnostic =
  | { phase: 'fill-start' | 'fill-return' | 'evaluate-start' }
  | { phase: 'evaluate-return'; editor: BrowserEditorDiagnostic }
  | {
      phase: 'exception';
      operation: 'fill' | 'evaluate';
      category: 'health_failure' | 'timeout_error' | 'error' | 'unknown';
    };
export async function checkLocalCapabilities(
  context: BrowserContext,
  signal: AbortSignal,
  onDiagnostic?: (event: BrowserCapabilityDiagnostic) => void,
): Promise<void> {
  const diagnose = (event: BrowserCapabilityDiagnostic) => {
    try {
      onDiagnostic?.(event);
    } catch {
      // Observability never controls capability admission or cleanup.
    }
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  let page: Awaited<ReturnType<BrowserContext['newPage']>> | undefined;
  let stage: BrowserHealthView['stage'] = 'evaluate';
  let failure: BrowserHealthFailure | undefined;
  const step = async <T>(
    next: NonNullable<BrowserHealthView['stage']>,
    work: () => Promise<T>,
  ): Promise<T> => {
    stage = next;
    try {
      return await bounded(work, 5000, controller, next);
    } catch (error) {
      throw error instanceof BrowserHealthFailure
        ? error
        : new BrowserHealthFailure(next);
    }
  };
  const total = setTimeout(() => controller.abort(), 45000);
  try {
    await step('evaluate', async () => {
      await context.route('**/*', (route) => route.abort());
      page = await context.newPage();
      if (controller.signal.aborted) {
        await page.close();
        throw new BrowserHealthFailure('evaluate', 'timeout');
      }
      await page.setContent(
        '<!doctype html><meta charset="utf-8"><input id="health-text" aria-label="检查文字"><div id="health-editor" contenteditable="true"></div><input id="health-file" type="file">',
        { timeout: 5000 },
      );
      const nonce = randomUUID();
      if ((await page.evaluate((value) => value, nonce)) !== nonce)
        throw new BrowserHealthFailure('evaluate');
    });
    await step('locator', async () => {
      const locator = page!.locator('#health-text');
      if ((await locator.count()) !== 1 || !(await locator.isVisible()))
        throw new BrowserHealthFailure('locator');
      await locator.fill('本地浏览器检查', { timeout: 5000 });
      if ((await locator.inputValue()) !== '本地浏览器检查')
        throw new BrowserHealthFailure('locator');
    });
    await step('editor', async () => {
      const editor = page!.locator('#health-editor');
      let operation: 'fill' | 'evaluate' = 'fill';
      let ok: boolean;
      try {
        diagnose({ phase: 'fill-start' });
        await editor.fill('第一段\n第二段', { timeout: 5000 });
        diagnose({ phase: 'fill-return' });
        operation = 'evaluate';
        diagnose({ phase: 'evaluate-start' });
        const result = await editor.evaluate((element) => {
          const innerText = (element as HTMLElement).innerText;
          const expected = '第一段\n第二段';
          const snapshot: BrowserEditorDiagnostic = {
            innerTextMatches: innerText === '第一段\n第二段',
            innerTextLength: innerText.length,
            innerTextLf: innerText.split('\n').length - 1,
            innerTextCr: innerText.split('\r').length - 1,
            textContentLength: element.textContent?.length ?? 0,
            selectionAvailable: null,
            selectionMatches: null,
            selectionLength: null,
            selectionLf: null,
            prefixMatches: null,
            orderMatches: null,
            connected: element.isConnected,
            focused: document.activeElement === element,
            documentFocused: document.hasFocus(),
            visible: document.visibilityState === 'visible',
            firstMismatchIndex: null,
            singleDeletionMatches: false,
            extraPosition: null,
            extraCategory: null,
            whitespaceCount: (innerText.match(/\s/gu) ?? []).length,
            zeroWidthCount: (
              innerText.match(/[\u200b-\u200d\u2060\ufeff]/gu) ?? []
            ).length,
          };
          if (!snapshot.innerTextMatches) {
            let index = 0;
            while (
              index < Math.min(innerText.length, expected.length) &&
              innerText[index] === expected[index]
            )
              index++;
            snapshot.firstMismatchIndex = index;
            if (innerText.length === expected.length + 1) {
              for (let position = 0; position < innerText.length; position++) {
                if (
                  innerText.slice(0, position) +
                    innerText.slice(position + 1) !==
                  expected
                )
                  continue;
                snapshot.singleDeletionMatches = true;
                snapshot.extraPosition = position;
                const extra = innerText[position];
                snapshot.extraCategory = /[\u200b-\u200d\u2060\ufeff]/u.test(
                  extra,
                )
                  ? 'zero_width'
                  : /\s/u.test(extra)
                    ? 'whitespace'
                    : /\p{Cc}/u.test(extra)
                      ? 'control'
                      : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
                            extra,
                          )
                        ? 'cjk'
                        : /\p{Script=Latin}/u.test(extra)
                          ? 'latin'
                          : /\p{N}/u.test(extra)
                            ? 'number'
                            : 'other';
                break;
              }
            }
          }
          if (!snapshot.innerTextMatches) return { ok: false, snapshot };
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = window.getSelection();
          snapshot.selectionAvailable = !!selection;
          if (!selection) return { ok: false, snapshot };
          selection.removeAllRanges();
          selection.addRange(range);
          const text = selection.toString();
          selection.removeAllRanges();
          snapshot.selectionMatches = text === '第一段\n第二段';
          snapshot.selectionLength = text.length;
          snapshot.selectionLf = text.split('\n').length - 1;
          if (!snapshot.selectionMatches) return { ok: false, snapshot };
          snapshot.prefixMatches = element.textContent?.indexOf('第一段') === 0;
          if (!snapshot.prefixMatches) return { ok: false, snapshot };
          snapshot.orderMatches = element.textContent!.indexOf('第二段') > 0;
          return { ok: snapshot.orderMatches, snapshot };
        });
        diagnose({ phase: 'evaluate-return', editor: result.snapshot });
        ok = result.ok;
      } catch (error) {
        diagnose({
          phase: 'exception',
          operation,
          category:
            error instanceof BrowserHealthFailure
              ? 'health_failure'
              : error instanceof Error
                ? error.name === 'TimeoutError'
                  ? 'timeout_error'
                  : 'error'
                : 'unknown',
        });
        throw error;
      }
      if (!ok) throw new BrowserHealthFailure('editor');
    });
    await step('file', async () => {
      await page!
        .locator('#health-file')
        .setInputFiles(
          { name: 'health.png', mimeType: 'image/png', buffer: png },
          { timeout: 5000 },
        );
      const actual = await page!
        .locator('#health-file')
        .evaluate(async (element) => {
          const files = (element as HTMLInputElement).files;
          if (!files || files.length !== 1) return null;
          const file = files[0];
          return {
            name: file.name,
            type: file.type,
            size: file.size,
            bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
          };
        });
      if (
        !actual ||
        actual.name !== 'health.png' ||
        actual.type !== 'image/png' ||
        actual.size !== 68 ||
        actual.bytes.length !== png.length ||
        actual.bytes.some((byte, index) => byte !== png[index])
      )
        throw new BrowserHealthFailure('file');
    });
  } catch (error) {
    failure =
      error instanceof BrowserHealthFailure
        ? error
        : new BrowserHealthFailure(stage);
  } finally {
    clearTimeout(total);
    signal.removeEventListener('abort', abort);
  }
  if (page) {
    try {
      await bounded(
        () => page!.close(),
        10000,
        new AbortController(),
        'cleanup',
      );
    } catch {
      failure = new BrowserHealthFailure('cleanup', 'cleanup_failed');
    }
  }
  if (failure) throw failure;
}
