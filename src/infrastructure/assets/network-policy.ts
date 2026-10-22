import { isIP } from 'node:net';

function ipv4Number(address: string): number {
  return address
    .split('.')
    .reduce((value, part) => value * 256 + Number(part), 0);
}

function inV4Range(address: number, base: string, prefix: number): boolean {
  const size = 2 ** (32 - prefix);
  return Math.floor(address / size) === Math.floor(ipv4Number(base) / size);
}

function ipv6Number(address: string): bigint {
  const halves = address.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const parts =
    halves.length === 1
      ? left
      : [
          ...left,
          ...Array<string>(8 - left.length - right.length).fill('0'),
          ...right,
        ];
  return parts.reduce(
    (value, part) => (value << 16n) + BigInt(`0x${part}`),
    0n,
  );
}

/** Conservative public-unicast allow policy. Unknown/special ranges fail closed. */
export function isPublicAddress(address: string): boolean {
  if (address.includes('%')) return false;
  if (isIP(address) === 4) {
    const value = ipv4Number(address);
    const denied: readonly [string, number][] = [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.31.196.0', 24],
      ['192.52.193.0', 24],
      ['192.175.48.0', 24],
      ['192.88.99.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 3],
    ];
    return !denied.some(([base, prefix]) => inV4Range(value, base, prefix));
  }
  if (isIP(address) !== 6 || address.includes('.')) return false;
  const value = ipv6Number(address);
  // Only global unicast 2000::/3; block special assignments, documentation and 6to4.
  if (value >> 125n !== 1n) return false;
  return !(
    [
      ['2001::', 23],
      ['2001:db8::', 32],
      ['2002::', 16],
      ['3fff::', 20],
      ['3ffe::', 16],
      ['2620:4f:8000::', 48],
    ] as const
  ).some(
    ([base, prefix]) =>
      value >> BigInt(128 - prefix) ===
      ipv6Number(base) >> BigInt(128 - prefix),
  );
}

export function samePeer(actual: string | undefined, pinned: string): boolean {
  if (!actual) return false;
  // Dual-stack sockets may report an IPv4 peer in mapped notation. DNS/literal
  // mapped inputs are still prohibited; only the observed socket is normalized.
  if (isIP(pinned) === 4) {
    if (actual.toLowerCase().startsWith('::ffff:')) {
      const suffix = actual.slice(7);
      if (isIP(suffix) === 4) return suffix === pinned;
      if (/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(suffix)) {
        const parts = suffix.split(':').map((part) => parseInt(part, 16));
        return parts[0] * 65536 + parts[1] === ipv4Number(pinned);
      }
    }
    return actual === pinned;
  }
  return (
    isIP(actual) === 6 &&
    !actual.includes('%') &&
    !actual.includes('.') &&
    ipv6Number(actual) === ipv6Number(pinned)
  );
}
