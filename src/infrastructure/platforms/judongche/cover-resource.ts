import { createHash } from 'node:crypto';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
/** Only the two SINGLE-cover CDN forms observed before save and on reopen.
 * Preserve exact-URL semantics for every unverified host, transform or parameter.
 * This does not map material-library IDs, arbitrary filenames, or other CDNs.
 */
export function coverResourceKey(value: string): string {
  try {
    const url = new URL(value);
    const object =
      /^\/(tos-cn-i-f042mdwyw7\/[a-f0-9]{32})~(?:tplv-resize:640:0|tplv-f042mdwyw7-origin:0:0)\.image$/.exec(
        url.pathname,
      )?.[1];
    const keys = [...url.searchParams.keys()];
    const required = ['lk3s', 'x-expires', 'x-signature'];
    if (
      [
        'https://p3-dcd-sign.byteimg.com',
        'https://p9-dcd-sign.byteimg.com',
      ].includes(url.origin) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      object &&
      keys.length === new Set(keys).size &&
      keys.every((key) => [...required, 'psm'].includes(key)) &&
      required.every((key) => !!url.searchParams.get(key)) &&
      /^[a-f0-9]+$/.test(url.searchParams.get('lk3s')!) &&
      /^\d+$/.test(url.searchParams.get('x-expires')!) &&
      (!url.searchParams.has('psm') ||
        url.searchParams.get('psm') === 'motor.dealer_admin.goapi')
    ) {
      return hash(
        'judongche:cover:observed-object-v1\0' +
          (url.hostname === 'p3-dcd-sign.byteimg.com'
            ? ''
            : url.hostname + '\0') +
          object,
      );
    }
  } catch {
    /* Unsupported URL retains existing exact comparison semantics. */
  }
  return hash('judongche:cover:https-exact\0' + value);
}
