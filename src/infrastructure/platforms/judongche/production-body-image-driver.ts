import { defaultUploadWaits, type UploadWaits } from './upload-waits';
import { createHash } from 'node:crypto';
import {
  errors,
  type Page,
  type JSHandle,
  type ElementHandle,
} from 'playwright-core';
import { captureUploadSelection } from './production-upload-selection';
import {
  fail,
  JudongchePageError,
  type OwnedBodyUploadDialog,
} from './production-state';

export type BodyImageUploadStage =
  | 'open'
  | 'file-control'
  | 'select-file'
  | 'preview-visible'
  | 'preview-loaded'
  | 'confirm'
  | 'dialog-end';
export type BodyImageUploadInput = Readonly<{
  waits?: UploadWaits;
  allowPreviewReload?: boolean;
  page: Page;
  bytes: Uint8Array;
  mime: 'image/jpeg' | 'image/png';
  stop(): void;
  currentPage(): Page;
  guard(imageDialog: boolean, proof?: OwnedBodyUploadDialog): Promise<unknown>;
  stage(stage: BodyImageUploadStage, completePrevious?: boolean): void;
  completeStage(stage: BodyImageUploadStage): void;
  action(action: 'select-file' | 'confirm'): void;
  onPreviewError?(eventTime: number): void;
  observe?(record: BodyImageUploadRecord): void;
}>;
type ConfirmStep =
  | 'check-dialog'
  | 'check-library'
  | 'wait-button'
  | 'button-bound'
  | 'recheck-preview'
  | 'wait-preview-reload'
  | 'click-started'
  | 'click-returned'
  | 'click-error'
  | 'dialog-closed';
export type BodyImageUploadRecord = Readonly<{
  confirmTrace?: ReadonlyArray<{ step: ConfirmStep; elapsedMs: number }>;
  confirmButton?: {
    matches: number;
    visible: boolean;
    disabled: boolean | null;
    busy: boolean;
    nestedLabel: boolean;
  };
  fileSelectionCount: number;
  confirmationCount: number;
  modalClosed: boolean;
  uploadState: 'settled' | 'pending' | 'unknown';
}>;
/** Native action/timeout errors retain their identity just as page guard errors do. */
export type BodyImageUploadOutcome = BodyImageUploadRecord &
  ({ status: 'confirmed' } | { status: 'paused'; error: unknown });

/** Shared only by the body-image dialog and its insertion readback. */
export function createBodyImageWait(stop: () => void, page: () => Page) {
  return async (
    ready: () => Promise<boolean>,
    timeout: number,
    check: () => Promise<unknown> = async () => {
      stop();
      page();
    },
    until = performance.now() + timeout,
  ) => {
    for (;;) {
      await check();
      if (await ready()) {
        stop();
        return;
      }
      if (performance.now() >= until)
        throw new errors.TimeoutError('Body image stage timed out');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
}
/** Owns only the upload dialog lifecycle; editor positioning remains with pages. */
export async function uploadBodyImage(
  inputOptions: BodyImageUploadInput,
): Promise<BodyImageUploadOutcome> {
  const {
    page: p,
    bytes,
    mime,
    stop,
    currentPage: page,
    guard,
    stage: diagnosticStage,
    completeStage,
    action,
  } = inputOptions;
  let fileSelectionCount = 0,
    confirmationCount = 0;
  let modal: ElementHandle<Element> | undefined;
  let modalClosed = false;
  let uploadState: BodyImageUploadRecord['uploadState'] = 'unknown';
  let deadline = 0;
  let released = false;
  let capture: Awaited<ReturnType<typeof captureUploadSelection>> | undefined;
  let previewErrorReported = false;
  const preserveActionError = (
    actionError: unknown,
    observationError: unknown,
  ) =>
    observationError instanceof JudongchePageError || actionError === undefined
      ? observationError
      : actionError;
  const waits = inputOptions.waits ?? defaultUploadWaits;
  const budgets: Record<BodyImageUploadStage, number> = {
    open: waits.imageAction,
    'file-control': waits.imageAction,
    'select-file': waits.imageAction,
    'preview-visible': waits.preview,
    'preview-loaded': waits.preview,
    confirm: waits.imageAction,
    'dialog-end': waits.settleImage,
  };
  const stage = (next: BodyImageUploadStage, completePrevious = true) => {
    deadline = performance.now() + budgets[next];
    diagnosticStage(next, completePrevious);
  };
  const checkBudget = () => {
    stop();
    if (performance.now() >= deadline)
      throw new errors.TimeoutError('Body image stage timed out');
  };
  const remaining = () => {
    checkBudget();
    return Math.max(1, deadline - performance.now());
  };
  const started = performance.now();
  let confirmTrace: NonNullable<BodyImageUploadRecord['confirmTrace']> = [];
  let confirmButton: BodyImageUploadRecord['confirmButton'];
  const record = (): BodyImageUploadRecord => ({
    fileSelectionCount,
    confirmationCount,
    modalClosed,
    uploadState,
    ...(confirmTrace.length ? { confirmTrace } : {}),
    ...(confirmButton ? { confirmButton } : {}),
  });
  const publish = () => {
    try {
      inputOptions.observe?.(record());
    } catch {
      /* Fixed diagnostics cannot change the operation. */
    }
  };
  const markConfirm = (step: ConfirmStep) => {
    confirmTrace = [
      ...confirmTrace,
      { step, elapsedMs: Math.round(performance.now() - started) },
    ];
    publish();
  };
  // Only page observations change settlement. Listener/handle cleanup never does.
  const refresh = async () => {
    try {
      if (page() !== p) {
        uploadState = 'unknown';
        publish();
        return record();
      }
      const state = await p.evaluate(
        ({ modal, selected, confirmed, capture }) => {
          const readState = () => {
            const visible = (e: Element) =>
              e.getClientRects().length > 0 &&
              getComputedStyle(e).visibility === 'visible';
            const dialogs = Array.from(
              document.querySelectorAll(
                '[role=dialog],[aria-modal=true],.ant-modal',
              ),
            ).filter(visible);
            if (!modal?.isConnected)
              return {
                closed: dialogs.length === 0,
                state:
                  dialogs.length === 0 && (!selected || confirmed)
                    ? ('settled' as const)
                    : ('unknown' as const),
              };
            if (dialogs.length !== 1 || dialogs[0] !== modal)
              return { closed: false, state: 'unknown' as const };
            if (
              Array.from(
                modal.querySelectorAll(
                  '[role=progressbar],[aria-busy=true],progress',
                ),
              ).some(visible)
            )
              return { closed: false, state: 'pending' as const };
            const images = Array.from(modal.querySelectorAll('img'));
            const files = Array.from(
              modal.querySelectorAll<HTMLInputElement>('input[type=file]'),
            );
            const idle =
              !selected && files.length === 1 && files[0]!.files?.length === 0;
            const loaded =
              images.length === 1 &&
              visible(images[0]!) &&
              images[0]!.complete &&
              images[0]!.naturalWidth > 0;
            return {
              closed: false,
              state:
                idle || loaded ? ('settled' as const) : ('unknown' as const),
            };
          };
          return {
            ...readState(),
            previewErrorAt: capture?.previewErrorAt ?? null,
          };
        },
        {
          modal,
          selected: fileSelectionCount,
          confirmed: confirmationCount,
          capture,
        },
      );
      if (!previewErrorReported && state.previewErrorAt !== null) {
        previewErrorReported = true;
        try {
          inputOptions.onPreviewError?.(state.previewErrorAt);
        } catch {
          /* Observation only. */
        }
      }
      modalClosed = state.closed;
      uploadState = state.state;
    } catch {
      uploadState = 'unknown';
    }
    publish();
    return record();
  };
  publish();
  try {
    stage('open');
    const button = p.locator('.syl-toolbar-tool.image button');
    if ((await button.count()) !== 1)
      fail('PAGE_CHANGED', 'body-open-control-count');
    stop();
    try {
      await button.click({ timeout: remaining() });
    } catch (error) {
      // Reconcile a dispatched open; never replay it after a lost acknowledgement.
      try {
        page();
        if (
          (await p
            .locator('[role=dialog]:visible,.ant-modal:visible')
            .count()) !== 1
        )
          throw error;
      } catch (observationError) {
        throw preserveActionError(error, observationError);
      }
    }
    // A completed toolbar click does not prove that its modal opened.
    stage('file-control', false);
    const file = p.locator('input[type="file"]');
    // Poll only observations. Never replay a file selection or confirmation.
    const waitImage = createBodyImageWait(stop, page);
    const wait = async (
      ready: () => Promise<boolean>,
      check: () => Promise<unknown> = async () => {
        stop();
        page();
      },
    ) => {
      await waitImage(
        ready,
        remaining(),
        async () => {
          checkBudget();
          await check();
          checkBudget();
        },
        deadline,
      );
      checkBudget();
    };
    await wait(async () => (await file.count()) > 0);
    if ((await file.count()) !== 1)
      fail('PAGE_CHANGED', 'body-file-control-count');
    await guard(true);
    const input = await file.elementHandle();
    if (!input) fail('PAGE_CHANGED');
    let dialog: JSHandle<Element | null> | undefined;
    let library: ElementHandle<Element> | null = null;
    try {
      if (
        !(await input!.evaluate(
          (node) =>
            node instanceof HTMLInputElement && node.files?.length === 0,
        ))
      ) {
        fail('PAGE_CHANGED', 'body-input-not-empty');
      }
      dialog = await input!.evaluateHandle((node) =>
        node.closest('[role="dialog"],.ant-modal'),
      );
      // Capture File objects before the platform clears or unmounts the input,
      // using the same passive event-capture semantics as the cover driver.
      modal = dialog.asElement() ?? undefined;
      if (
        !modal ||
        !(await input!.evaluate(
          (node, modal) =>
            modal?.isConnected &&
            node.isConnected &&
            modal.querySelectorAll('input[type=file]').length === 1 &&
            modal.querySelector('input[type=file]') === node,
          modal,
        ))
      )
        fail('PAGE_CHANGED', 'body-dialog-unbound');
      const selection = await captureUploadSelection(input!, modal!);
      capture = selection;
      let proof: OwnedBodyUploadDialog = {
        modal: modal!,
        input: input!,
        selectionPhase: 'before-selection',
        selection,
      };
      await guard(true, proof);
      await refresh();
      checkBudget();
      // Reuse the existing unique-input/modal binding and safety evidence.
      // Updating this earlier history entry adds no reads, waits or actions.
      completeStage('open');
      stage('select-file');
      const selectionTimeout = remaining();
      fileSelectionCount++;
      action('select-file');
      uploadState = 'unknown';
      publish();
      let selectionError: unknown;
      try {
        await input!.setInputFiles(
          {
            name: mime === 'image/png' ? 'body.png' : 'body.jpg',
            mimeType: mime,
            buffer: Buffer.from(bytes),
          },
          { timeout: selectionTimeout },
        );
      } catch (error) {
        selectionError = error;
      }
      try {
        const selected = await selection.evaluate(async (capture) => {
          const file = capture.files[0];
          return file &&
            !capture.invalid &&
            capture.inputCount === 1 &&
            capture.changeCount === 1
            ? {
                size: file.size,
                mime: file.type,
                digest: Array.from(
                  new Uint8Array(
                    await crypto.subtle.digest(
                      'SHA-256',
                      await file.arrayBuffer(),
                    ),
                  ),
                )
                  .map((b) => b.toString(16).padStart(2, '0'))
                  .join(''),
              }
            : null;
        });
        if (
          !selected ||
          selected.size !== bytes.length ||
          selected.mime !== mime ||
          selected.digest !== createHash('sha256').update(bytes).digest('hex')
        ) {
          if (selectionError) throw selectionError;
          await guard(true, proof);
          fail('PAGE_CHANGED', 'body-selected-file-mismatch');
        }
        checkBudget();
      } catch (error) {
        throw preserveActionError(selectionError, error);
      }
      proof = {
        modal: modal!,
        input: input!,
        selectionPhase: 'selected',
        selection,
      };
      const uploadGuard = async () => {
        await guard(true, proof);
        if (
          !(await selection.evaluate(
            (capture, input) =>
              !capture.invalid &&
              capture.inputCount === 1 &&
              capture.changeCount === 1 &&
              (!(input instanceof HTMLInputElement) ||
                !input.isConnected ||
                input.files?.length === 0 ||
                (input.files?.length === 1 &&
                  input.files[0] === capture.files[0])),
            input!,
          ))
        )
          fail('PAGE_CHANGED', 'body-selected-file-mismatch');
        if (!(await modal!.evaluate((node) => node.isConnected)))
          fail('PAGE_CHANGED', 'body-upload-ownership-lost');
        await refresh();
      };
      stage('preview-visible');
      await wait(
        () =>
          modal!.evaluate((node) =>
            Array.from(node.querySelectorAll('img')).some((img) => {
              const box = img.getBoundingClientRect();
              return (
                getComputedStyle(img).visibility === 'visible' &&
                box.width > 0 &&
                box.height > 0
              );
            }),
          ),
        uploadGuard,
      );
      stage('preview-loaded');
      const previewDeadline = deadline;
      await wait(
        () =>
          modal!.evaluate((node) => {
            const imgs = Array.from(node.querySelectorAll('img')).filter(
              (img) => {
                const box = img.getBoundingClientRect();
                return (
                  getComputedStyle(img).visibility === 'visible' &&
                  box.width > 0 &&
                  box.height > 0
                );
              },
            );
            return (
              imgs.length === 1 &&
              imgs[0]!.complete &&
              imgs[0]!.naturalWidth > 0
            );
          }),
        uploadGuard,
      );
      stage('confirm');
      markConfirm('check-dialog');
      // Native checkbox association is established by the same owned-modal
      // contract before/after selection. Uncheck this exact node at most once.
      await uploadGuard();
      markConfirm('check-library');
      library = await modal!.$('input[type=checkbox]');
      const libraryFalse = () =>
        modal!.evaluate((node, library) => {
          const checkboxes = Array.from(
            node.querySelectorAll('input[type=checkbox]'),
          );
          return library
            ? checkboxes.length === 1 &&
                checkboxes[0] === library &&
                library.isConnected &&
                library instanceof HTMLInputElement &&
                !library.checked &&
                !library.indeterminate
            : checkboxes.length === 0;
        }, library);
      if (library) {
        if (await library.isChecked()) {
          checkBudget();
          try {
            await library.setChecked(false, { timeout: remaining() });
          } catch {
            if (!(await libraryFalse()))
              fail('PAGE_CHANGED', 'body-library-not-false');
          }
        }
        await uploadGuard();
        if (!(await libraryFalse()))
          fail('PAGE_CHANGED', 'body-library-not-false');
      }
      // The button label may be rendered in a child span. Bind the exact
      // node that passed the readiness check, scoped to the owned dialog.
      const bound: { button: ElementHandle<HTMLButtonElement> | null } = {
        button: null,
      };
      let confirmationError: unknown;
      try {
        markConfirm('wait-button');
        await wait(async () => {
          const sample = await modal!.evaluateHandle((node) => {
            const matches = Array.from(node.querySelectorAll('button')).filter(
              (b) => b.textContent?.trim() === '确定',
            );
            const button = matches.length === 1 ? matches[0]! : null;
            const visible = !!button?.getClientRects().length;
            const busy = Array.from(
              node.querySelectorAll(
                '[role=progressbar],[aria-busy=true],progress',
              ),
            ).some((e) => e.getClientRects().length > 0);
            return {
              button:
                button && visible && !button.disabled && !busy ? button : null,
              state: {
                matches: matches.length,
                visible,
                disabled: button?.disabled ?? null,
                busy,
                nestedLabel: !!button?.childElementCount,
              },
            };
          });
          try {
            confirmButton = await sample.evaluate((s) => s.state);
            publish();
            const target = await sample.getProperty('button');
            const element = target.asElement();
            if (!element) {
              await target.dispose();
              return false;
            }
            bound.button = element as ElementHandle<HTMLButtonElement>;
            return true;
          } finally {
            await sample.dispose();
          }
        }, uploadGuard);
        markConfirm('button-bound');
        const checkConfirmation = async () => {
          await uploadGuard();
          if (!(await libraryFalse()))
            fail('PAGE_CHANGED', 'body-library-not-false');
        };
        let waitingForReload = false;
        const previewReady = async () => {
          const state = await modal!.evaluate((node, button) => {
            const matches = Array.from(node.querySelectorAll('button')).filter(
              (b) => b.textContent?.trim() === '确定',
            );
            if (
              matches.length !== 1 ||
              matches[0] !== button ||
              !button.isConnected
            )
              return 'button-changed';
            const images = node.querySelectorAll('img');
            const image = images[0];
            if (
              images.length !== 1 ||
              getComputedStyle(image).visibility !== 'visible' ||
              !image.getClientRects().length
            )
              return 'invalid';
            if (!image.complete) return 'loading';
            if (button.disabled) return 'button-disabled';
            const rect = image.getBoundingClientRect();
            const busy = Array.from(
              node.querySelectorAll(
                '[role=progressbar],[aria-busy=true],progress',
              ),
            ).some((e) => e.getClientRects().length > 0);
            return rect.width > 0 &&
              rect.height > 0 &&
              image.naturalWidth > 0 &&
              !busy
              ? 'ready'
              : 'invalid';
          }, bound.button!);
          if (state === 'button-disabled' && waitingForReload) return false;
          if (state === 'button-changed' || state === 'button-disabled')
            fail('PAGE_CHANGED', 'body-confirm-button-changed');
          if (state === 'invalid') fail('PAGE_CHANGED', 'body-preview-changed');
          return state === 'ready';
        };
        await checkConfirmation();
        markConfirm('recheck-preview');
        if (!(await previewReady())) {
          if (!inputOptions.allowPreviewReload)
            fail('PAGE_CHANGED', 'body-preview-changed');
          // A first preview can start loading again as the platform switches sources.
          // Use the original preview deadline and preserve the remaining action budget.
          const clickBudget = remaining();
          deadline = previewDeadline;
          waitingForReload = true;
          markConfirm('wait-preview-reload');
          await wait(previewReady, checkConfirmation);
          deadline = performance.now() + clickBudget;
        }
        const confirmationTimeout = remaining();
        confirmationCount++;
        action('confirm');
        markConfirm('click-started');
        try {
          await bound.button!.click({ timeout: confirmationTimeout });
          markConfirm('click-returned');
        } catch (error) {
          markConfirm('click-error');
          // Observe first. A missing acknowledgement never licenses another click.
          await refresh();
          confirmationError = error;
        }
      } finally {
        await bound.button?.dispose().catch(() => {});
      }
      stage('dialog-end');
      const closedNormally = async () => {
        stop();
        page();
        const ended = await p.evaluate((modal) => {
          const shown = Array.from(
            document.querySelectorAll(
              '[role=dialog],[aria-modal=true],.ant-modal',
            ),
          ).filter(
            (node) =>
              node.getClientRects().length > 0 &&
              getComputedStyle(node).visibility === 'visible',
          );
          return { detached: !modal.isConnected, dialogCount: shown.length };
        }, modal!);
        if (!ended.detached) return false;
        if (ended.dialogCount) {
          await guard(true, proof);
          return false;
        }
        if (
          !(await selection.evaluate(
            (value) =>
              !value.invalid &&
              value.inputCount === 1 &&
              value.changeCount === 1,
          ))
        )
          fail('PAGE_CHANGED', 'body-upload-ownership-lost');
        await guard(false);
        return true;
      };
      try {
        await wait(
          () => modal!.evaluate((node) => !node.isConnected),
          async () => {
            stop();
            page();
            if (await modal!.evaluate((node) => node.isConnected)) {
              try {
                await uploadGuard();
              } catch (error) {
                const closingRace =
                  error instanceof JudongchePageError &&
                  error.reason === 'PAGE_CHANGED' &&
                  (error.check === 'body-upload-ownership-lost' ||
                    (error.check === 'unknown-dialog' &&
                      error.bodyUploadDialog?.rejection === 'dialog-count' &&
                      error.bodyUploadDialog.dialogCount === 0));
                if (!closingRace || !(await closedNormally())) throw error;
              }
            } else if (!(await closedNormally()))
              fail('PAGE_CHANGED', 'body-upload-unsettled');
          },
        );
      } catch (error) {
        throw preserveActionError(confirmationError, error);
      }
      const terminal = await refresh();
      if (terminal.modalClosed) markConfirm('dialog-closed');
      if (!terminal.modalClosed || terminal.uploadState !== 'settled')
        fail('PAGE_CHANGED', 'body-upload-unsettled');
    } finally {
      await refresh();
      released = true;
      if (capture) {
        const time = await capture
          .evaluate((value) => {
            value.dispose();
            return value.previewErrorAt;
          })
          .catch(() => null);
        if (!previewErrorReported && time !== null) {
          try {
            inputOptions.onPreviewError?.(time);
          } catch {
            /* Observation only. */
          }
        }
        await capture.dispose().catch(() => {});
      }
      await library?.dispose().catch(() => {});
      await dialog?.dispose().catch(() => {});
      await input!.dispose().catch(() => {});
    }

    const terminal = record();
    if (!terminal.modalClosed || terminal.uploadState !== 'settled')
      fail('PAGE_CHANGED', 'body-upload-unsettled');
    return {
      status: 'confirmed',
      fileSelectionCount,
      confirmationCount,
      modalClosed,
      uploadState,
    };
  } catch (error) {
    if (!released) await refresh();
    return {
      status: 'paused',
      error,
      fileSelectionCount,
      confirmationCount,
      modalClosed,
      uploadState,
    };
  }
}
