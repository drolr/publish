import type { ElementHandle, JSHandle } from 'playwright-core';

export type SelectionCapture = {
  files: readonly File[];
  previewErrorAt: number | null;
  inputCount: number;
  changeCount: number;
  extraSelectionEventCount: number;
  invalid: boolean;
  dispose(): void;
};

/** Passive single-selection observer shared by the body and cover uploaders.
 * Keep the actual File objects even if the platform resets/unmounts its input. */
export function captureUploadSelection(
  input: ElementHandle<Element>,
  modal?: ElementHandle<Element>,
): Promise<JSHandle<SelectionCapture>> {
  return input.evaluateHandle((node, modal) => {
    if (
      !(node instanceof HTMLInputElement) ||
      node.disabled ||
      !node.isConnected
    )
      throw Error('upload-input-unavailable');
    const capture: SelectionCapture = {
      files: [],
      previewErrorAt: null,
      inputCount: 0,
      changeCount: 0,
      extraSelectionEventCount: 0,
      invalid: false,
      dispose: () => {},
    };
    const observedEvents = new WeakSet<Event>();
    const observe = (event: Event) => {
      if (observedEvents.has(event)) return;
      if (event.target !== node) {
        if (
          event.target instanceof HTMLInputElement &&
          event.target.type === 'file' &&
          modal?.contains(event.target)
        ) {
          observedEvents.add(event);
          capture.extraSelectionEventCount++;
          capture.invalid = true;
        }
        return;
      }
      observedEvents.add(event);
      if (event.type === 'input') capture.inputCount++;
      else capture.changeCount++;
      const current = Array.from(node.files ?? []);
      if (
        capture.inputCount > 1 ||
        capture.changeCount > 1 ||
        current.length !== 1
      ) {
        capture.invalid = true;
        return;
      }
      if (!capture.files.length) capture.files = Object.freeze(current);
      else if (current.some((file, index) => file !== capture.files[index]))
        capture.invalid = true;
    };
    node.addEventListener('input', observe, true);
    node.addEventListener('change', observe, true);
    node.ownerDocument.addEventListener('input', observe, true);
    node.ownerDocument.addEventListener('change', observe, true);
    modal?.addEventListener('input', observe, true);
    modal?.addEventListener('change', observe, true);
    const previewError = (event: Event) => {
      if (
        capture.files.length &&
        event.target instanceof HTMLImageElement &&
        modal?.contains(event.target)
      )
        capture.previewErrorAt ??= Date.now();
    };
    modal?.addEventListener('error', previewError, true);
    capture.dispose = () => {
      modal?.removeEventListener('error', previewError, true);
      node.removeEventListener('input', observe, true);
      node.removeEventListener('change', observe, true);
      node.ownerDocument.removeEventListener('input', observe, true);
      node.ownerDocument.removeEventListener('change', observe, true);
      modal?.removeEventListener('input', observe, true);
      modal?.removeEventListener('change', observe, true);
    };
    return capture;
  }, modal);
}
