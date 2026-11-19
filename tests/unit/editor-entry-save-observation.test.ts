import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import type { Page, Request } from 'playwright-core';
import {
  observeEditorEntrySave,
  observeLiveSaves,
} from '../../src/infrastructure/platforms/judongche/production-editor-entry';

function request(
  path = '/motor/dealer_admin/go_api/article/create',
  method = 'POST',
  status = 200,
) {
  return {
    url: () => 'https://www.autoengine.com' + path,
    method: () => method,
    response: async () => ({ status: () => status }),
  } as unknown as Request;
}

it('only exact observed create requests block entry; finished and failed requests settle independently', async () => {
  const page = new EventEmitter();
  const observation = observeEditorEntrySave(page as unknown as Page);
  page.emit(
    'request',
    request('/motor/dealer_admin/go_api/article/create-extra'),
  );
  page.emit('request', request(undefined, 'GET'));
  expect(() => observation.assertIdle()).not.toThrow();
  const first = request(),
    second = request();
  page.emit('request', first);
  page.emit('request', second);
  page.emit('requestfinished', first);
  expect(() => observation.assertIdle()).toThrow('RESULT_AMBIGUOUS');
  page.emit('requestfailed', second);
  await Promise.resolve();
  expect(() => observation.assertIdle()).not.toThrow();
  observation.dispose();
});

for (const status of [401, 403]) {
  it(`a finished observed request cannot conceal access denial ${status}`, async () => {
    const page = new EventEmitter();
    const observation = observeEditorEntrySave(page as unknown as Page);
    expect(observation.isActive()).toBe(true);
    const value = request(undefined, undefined, status);
    page.emit('request', value);
    page.emit('requestfinished', value);
    await Promise.resolve();
    expect(() => observation.assertIdle()).toThrow(
      status === 401 ? 'LOGIN_REQUIRED' : 'PERMISSION_DENIED',
    );
    observation.dispose();
    expect(observation.isActive()).toBe(false);
  });
}

for (const end of ['dispose', 'close'] as const) {
  it(`entry watcher has one owner and releases every event listener on ${end}`, async () => {
    const page = new EventEmitter();
    const observation = observeEditorEntrySave(page as unknown as Page);
    for (const event of [
      'request',
      'requestfinished',
      'requestfailed',
      'close',
    ])
      expect(page.listenerCount(event)).toBe(1);
    page.emit('request', request());
    if (end === 'close') page.emit('close');
    else observation.dispose();
    await Promise.resolve();
    observation.dispose();
    for (const event of [
      'request',
      'requestfinished',
      'requestfailed',
      'close',
    ])
      expect(page.listenerCount(event)).toBe(0);
    expect(() => observation.assertIdle()).toThrow('PAGE_CHANGED');
  });
}
it('transport completion cannot race ahead of the response access check', async () => {
  const page = new EventEmitter();
  const observation = observeEditorEntrySave(page as unknown as Page);
  let resolve!: (response: { status(): number }) => void;
  const value = request();
  value.response = () =>
    new Promise((done) => {
      resolve = done as typeof resolve;
    });
  page.emit('request', value);
  page.emit('requestfinished', value);
  expect(() => observation.assertIdle()).toThrow('RESULT_AMBIGUOUS');
  resolve({ status: () => 403 });
  await Promise.resolve();
  expect(() => observation.assertIdle()).toThrow('PERMISSION_DENIED');
  observation.dispose();
});

for (const status of [401, 403] as const) {
  const reason = status === 401 ? 'LOGIN_REQUIRED' : 'PERMISSION_DENIED';
  it(`only the live handoff retires fully ended historical ${status}; entry stays strict`, async () => {
    const page = new EventEmitter();
    const entry = observeEditorEntrySave(page as unknown as Page);
    const live = observeLiveSaves(page as unknown as Page);
    const value = request(undefined, undefined, status);
    page.emit('request', value);
    page.emit('requestfinished', value);
    await Promise.resolve();
    expect(() => entry.assertIdle()).toThrow(reason);
    expect(() => live.assertIdle()).toThrow(reason);
    const history = live.captureHandledDenials();
    expect(() => history.assertIdle()).not.toThrow();
    // Capture/read does not itself clear historical refusal.
    expect(() => live.assertIdle()).toThrow(reason);
    history.retire();
    expect(() => live.assertIdle()).not.toThrow();
    expect(() => entry.assertIdle()).toThrow(reason);
    expect('captureHandledDenials' in entry).toBe(false);
    entry.dispose();
    live.dispose();
  });
  it(`a classified ${status} whose transport was still pending at capture cannot become history during drain`, async () => {
    const page = new EventEmitter(),
      live = observeLiveSaves(page as unknown as Page);
    const value = request(undefined, undefined, status);
    page.emit('request', value);
    await Promise.resolve();
    const history = live.captureHandledDenials();
    page.emit('requestfinished', value);
    expect(() => history.assertIdle()).toThrow(reason);
    expect(() => history.retire()).toThrow(reason);
    expect(() => live.assertIdle()).toThrow(reason);
    live.dispose();
  });
  it(`requestfinished before access classification preserves late ${status} across the capture boundary`, async () => {
    const page = new EventEmitter(),
      live = observeLiveSaves(page as unknown as Page);
    let resolve!: (response: { status(): number }) => void;
    const value = request();
    value.response = () =>
      new Promise((done) => {
        resolve = done as typeof resolve;
      });
    page.emit('request', value);
    page.emit('requestfinished', value);
    const history = live.captureHandledDenials();
    expect(() => history.assertIdle()).toThrow('RESULT_AMBIGUOUS');
    resolve({ status: () => status });
    await Promise.resolve();
    expect(() => history.assertIdle()).toThrow(reason);
    expect(() => history.retire()).toThrow(reason);
    live.dispose();
  });
  it(`a new ${status} after explicit capture is never cleared with the old denial`, async () => {
    const page = new EventEmitter(),
      live = observeLiveSaves(page as unknown as Page);
    const old = request(undefined, undefined, status === 401 ? 403 : 401);
    page.emit('request', old);
    page.emit('requestfinished', old);
    await Promise.resolve();
    const history = live.captureHandledDenials();
    const fresh = request(undefined, undefined, status);
    page.emit('request', fresh);
    page.emit('requestfinished', fresh);
    await Promise.resolve();
    expect(() => history.assertIdle()).toThrow(reason);
    expect(() => history.retire()).toThrow(reason);
    // A later explicit user retry can handle the now fully ended denial.
    live.captureHandledDenials().retire();
    expect(() => live.assertIdle()).not.toThrow();
    live.dispose();
  });
}
it('pending successful access remains busy until finished, and page retirement invalidates its captured capability', async () => {
  const page = new EventEmitter(),
    live = observeLiveSaves(page as unknown as Page);
  const value = request();
  page.emit('request', value);
  const history = live.captureHandledDenials();
  await Promise.resolve();
  expect(() => history.assertIdle()).toThrow('RESULT_AMBIGUOUS');
  page.emit('requestfinished', value);
  expect(() => history.assertIdle()).not.toThrow();
  page.emit('close');
  expect(() => history.assertIdle()).toThrow('PAGE_CHANGED');
});
