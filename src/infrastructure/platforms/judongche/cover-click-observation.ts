import type { ElementHandle } from 'playwright-core';

export type CoverClickObservation = {
  checkpoint: 'open-returned' | 'open-failed' | 'follow-up';
  clickReceived: boolean | null;
  pickerVisible: boolean | null;
  clickToPickerMs: number | null;
  observedMs: number | null;
  interrupted: boolean | null;
};

// Only the retained cover slot and the known file picker are observed. No page
// callbacks are exposed by the desktop app. The driver still owns all actions.
export async function observeCoverClick(
  slot: ElementHandle<Element>,
  selector: string,
  publish: (event: CoverClickObservation) => void,
) {
  const probe = await slot
    .evaluateHandle((node, selector) => {
      const doc = node.ownerDocument;
      const url = doc.location.href;
      const start = performance.now();
      const firstVisible = new WeakMap<Element, number>();
      let clicked: number | null = null,
        shown: number | null = null;
      let interrupted = false,
        stopped = false,
        frame = 0;
      const click = (event: Event) => {
        if (event.isTrusted && clicked === null) clicked = performance.now();
      };
      const stop = () => {
        if (stopped) return;
        stopped = true;
        cancelAnimationFrame(frame);
        node.removeEventListener('click', click, true);
        doc.removeEventListener('pointerdown', input, true);
        doc.removeEventListener('keydown', input, true);
        window.removeEventListener('pagehide', interrupt);
      };
      const interrupt = () => {
        interrupted = true;
        stop();
      };
      const input = (event: Event) => {
        if (
          event.isTrusted &&
          (clicked !== null ||
            event.type === 'keydown' ||
            !event.composedPath().includes(node))
        )
          interrupt();
      };
      const sample = () => {
        if (stopped) return;
        if (doc.location.href !== url) {
          interrupt();
          return;
        }
        for (const modal of Array.from(doc.querySelectorAll(selector))) {
          const rect = modal.getBoundingClientRect();
          if (
            !rect.width ||
            !rect.height ||
            getComputedStyle(modal).visibility !== 'visible'
          )
            continue;
          if (!firstVisible.has(modal))
            firstVisible.set(modal, performance.now());
          if (
            modal.querySelector('input[type=file]') &&
            Array.from(modal.querySelectorAll('button,[role=button]')).some(
              (button) =>
                button.textContent?.trim() === '选择图片' ||
                button.getAttribute('aria-label') === '选择图片',
            )
          ) {
            shown = firstVisible.get(modal)!;
            stop();
            return;
          }
        }
      };
      const tick = () => {
        sample();
        if (!stopped) frame = requestAnimationFrame(tick);
      };
      node.addEventListener('click', click, { capture: true, passive: true });
      doc.addEventListener('pointerdown', input, {
        capture: true,
        passive: true,
      });
      doc.addEventListener('keydown', input, { capture: true, passive: true });
      window.addEventListener('pagehide', interrupt, { once: true });
      frame = requestAnimationFrame(tick);
      return {
        stop,
        read() {
          sample();
          return {
            clicked: clicked !== null,
            shown: shown !== null,
            interrupted,
            delay:
              clicked !== null && shown !== null && shown >= clicked
                ? Math.round(shown - clicked)
                : null,
            elapsed: Math.round(performance.now() - start),
          };
        },
      };
    }, selector)
    .catch(() => null);
  const read = async (checkpoint: CoverClickObservation['checkpoint']) => {
    const value = await probe?.evaluate((p) => p.read()).catch(() => null);
    const event = {
      checkpoint,
      clickReceived: value?.clicked ?? null,
      pickerVisible: value?.shown ?? null,
      clickToPickerMs: value?.delay ?? null,
      observedMs: value?.elapsed ?? null,
      interrupted: value?.interrupted ?? null,
    };
    try {
      publish(event);
    } catch {
      /* Diagnostics cannot change the outcome. */
    }
    return event;
  };
  const dispose = async () => {
    await probe?.evaluate((p) => p.stop()).catch(() => {});
    await probe?.dispose().catch(() => {});
  };
  return async (failed: boolean) => {
    const value = await read(failed ? 'open-failed' : 'open-returned');
    if (
      failed &&
      value.clickReceived &&
      value.pickerVisible === false &&
      value.interrupted === false
    ) {
      // The task pauses immediately. Only the observation outlives the attempt.
      const timer = setTimeout(() => {
        void read('follow-up').finally(dispose);
      }, 5000);
      timer.unref();
    } else await dispose();
  };
}
