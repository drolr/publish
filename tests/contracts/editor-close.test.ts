import { expect, it } from 'vitest';
import {
  manualChannels,
  manualRequests,
  manualResponses,
} from '../../src/contracts/manual-article';
import { ManualCloseRequestSchema } from '../../src/contracts/manual-edit';
it('exposes exactly twenty-three bounded requests and no generic clipboard bridge', () => {
  expect(Object.keys(manualChannels)).toHaveLength(23);
  expect(Object.keys(manualRequests).sort()).toEqual(
    Object.keys(manualChannels).sort(),
  );
  expect(Object.keys(manualResponses).sort()).toEqual(
    Object.keys(manualChannels).sort(),
  );
  expect(
    Object.keys(manualChannels).some((k) => /clipboard|invoke|path/i.test(k)),
  ).toBe(false);
});
it('close event contains only the opaque request identity', () => {
  const request = { requestId: '00000000-0000-4000-8000-000000000001' };
  expect(ManualCloseRequestSchema.safeParse(request).success).toBe(true);
  expect(
    ManualCloseRequestSchema.safeParse({
      ...request,
      sessionId: request.requestId,
    }).success,
  ).toBe(false);
  expect(
    ManualCloseRequestSchema.safeParse({ requestId: '../secret' }).success,
  ).toBe(false);
});
