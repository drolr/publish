import { describe, expect, it } from 'vitest';
import { getAppStatus } from '../../src/application/get-app-status';
import {
  AppStatusSchema,
  NoArgumentsSchema,
} from '../../src/contracts/app-status';
describe('initialization boundary', () => {
  it('reports ready only for the supported database version', () => {
    expect(
      getAppStatus({ getSchemaVersion: () => 15, close() {} }, '0.1.0'),
    ).toEqual({ state: 'ready', appVersion: '0.1.0', schemaVersion: 15 });
    expect(
      getAppStatus({ getSchemaVersion: () => 3, close() {} }, '0.1.0').state,
    ).toBe('unavailable');
  });
  it('hides unavailable store and sensitive underlying failures', () => {
    const unavailable = { state: 'unavailable', code: 'INITIALIZATION_FAILED' };
    expect(getAppStatus(undefined, '0.1.0')).toEqual(unavailable);
    expect(
      getAppStatus(
        {
          getSchemaVersion() {
            throw new Error('secret local path');
          },
          close() {},
        },
        '0.1.0',
      ),
    ).toEqual(unavailable);
  });
  it('rejects extra request arguments and response data', () => {
    expect(NoArgumentsSchema.safeParse([]).success).toBe(true);
    expect(NoArgumentsSchema.safeParse([undefined]).success).toBe(false);
    expect(
      AppStatusSchema.safeParse({
        state: 'ready',
        appVersion: '0.1.0',
        schemaVersion: 15,
        path: 'secret',
      }).success,
    ).toBe(false);
    expect(
      AppStatusSchema.safeParse({
        state: 'ready',
        appVersion: '0.1.0',
        schemaVersion: 3,
      }).success,
    ).toBe(false);
  });
});
