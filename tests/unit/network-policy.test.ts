import { describe, expect, it } from 'vitest';
import { isPublicAddress } from '../../src/infrastructure/assets/network-policy';

describe('remote address policy', () => {
  it.each([
    '192.31.196.1',
    '192.52.193.1',
    '192.175.48.1',
    '2620:4f:8000::1',
    '3ffe::1',
  ])('rejects special-purpose service range %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
  ])('accepts public unicast %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
  it.each([
    'localhost',
    '127.1',
    '2130706433',
    '0x7f000001',
    '0.0.0.0',
    '10.1.2.3',
    '100.64.1.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.0.1',
    '192.0.0.9',
    '192.0.2.1',
    '192.88.99.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.1.1.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:8.8.8.8',
    '::ffff:127.0.0.1',
    '64:ff9b::808:808',
    '100::1',
    '2001:db8::1',
    '2001::1',
    '2002:0808:0808::1',
    '3fff::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    'fe80::1%12',
  ])('rejects nonpublic, special or unknown %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});
