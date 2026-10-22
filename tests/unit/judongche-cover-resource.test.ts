import { describe, expect, it } from 'vitest';
import { coverResourceKey } from '../../src/infrastructure/platforms/judongche/cover-resource';
const object = '/tos-cn-i-f042mdwyw7/' + 'a'.repeat(32);
const preview =
  'https://p3-dcd-sign.byteimg.com' +
  object +
  '~tplv-resize:640:0.image?lk3s=4e54bfa5&x-expires=1&x-signature=first';
const reopened =
  'https://p3-dcd-sign.byteimg.com' +
  object +
  '~tplv-f042mdwyw7-origin:0:0.image?lk3s=4e54bfa5&x-expires=2&x-signature=second&psm=motor.dealer_admin.goapi';
describe('observed single-cover source identity', () => {
  it('keeps identity across the observed preview and reopen transformations', () => {
    expect(coverResourceKey(preview)).toBe(coverResourceKey(reopened));
  });
  it('never accepts another platform object', () => {
    expect(coverResourceKey(preview)).not.toBe(
      coverResourceKey(reopened.replace('a'.repeat(32), 'b'.repeat(32))),
    );
  });
  it.each([
    reopened.replace('p3-dcd-sign.byteimg.com', 'untrusted.example'),
    reopened.replace('https:', 'http:'),
    reopened.replace('p3-dcd-sign.byteimg.com', 'p3-dcd-sign.byteimg.com:8443'),
    reopened.replace('p3-dcd-sign.byteimg.com', 'user@p3-dcd-sign.byteimg.com'),
    reopened.replace('f042mdwyw7/', 'other/'),
    reopened.replace('~tplv-f042mdwyw7-origin:0:0.image', '~unknown.image'),
    reopened + '&crop=1',
    reopened + '&x-signature=duplicate',
    reopened + '#other',
  ])('does not generalize unknown URL shape %s', (other) => {
    expect(coverResourceKey(preview)).not.toBe(coverResourceKey(other));
  });
  it('preserves exact comparison for legacy fixture and other shapes', () => {
    expect(coverResourceKey('https://example.test/image.png')).toBe(
      coverResourceKey('https://example.test/image.png'),
    );
    expect(coverResourceKey('https://example.test/image.png?a=1')).not.toBe(
      coverResourceKey('https://example.test/image.png?a=2'),
    );
  });
});

it('recognizes observed p9 preview and reopen without inventing cross-host mapping', () => {
  const p9Preview = preview.replace('p3-dcd-sign', 'p9-dcd-sign');
  const p9Reopened = reopened.replace('p3-dcd-sign', 'p9-dcd-sign');
  expect(coverResourceKey(p9Preview)).toBe(coverResourceKey(p9Reopened));
  expect(coverResourceKey(p9Preview)).not.toBe(coverResourceKey(preview));
});
