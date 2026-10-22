import { resolveImageHost } from './image-dns';
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type RequestOptions,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { ImportFailure } from '../../domain/import-error';
import { isPublicAddress, samePeer } from './network-policy';

const MAX_BYTES = 20 * 1024 * 1024;
export interface RemoteTarget {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
}
export interface RemoteResponse {
  status: number;
  headers: IncomingHttpHeaders;
  peerAddress: string | undefined;
  body: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}
interface Dependencies {
  // Resolution owns cancellation: settle all DNS work before fulfilling/rejecting.
  resolve(
    hostname: string,
    signal: AbortSignal,
  ): Promise<{ address: string; family: number }[]>;
  // Failure settles only after all owned HTTP resources retire. Success transfers
  // ownership to close(), which destroys and awaits request/response/socket close.
  request(target: RemoteTarget, signal: AbortSignal): Promise<RemoteResponse>;
}
type RequestFunction = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

/** Node transport has no agent reuse, implicit proxy, redirects, or credentials. */
export function createNodeTransport(
  http: RequestFunction = httpRequest,
  https: RequestFunction = httpsRequest,
): Dependencies['request'] {
  return (target, signal) =>
    new Promise((resolve, reject) => {
      let response: IncomingMessage | undefined;
      let responseClosed = Promise.resolve();
      let socketClosed = Promise.resolve();
      let retirement: Promise<void> | undefined;
      // close events, rather than destroyed flags or error events, prove retirement.
      const close = (): Promise<void> => {
        retirement ??= (async () => {
          response?.destroy();
          request.destroy();
          await requestClosed;
          await Promise.all([responseClosed, socketClosed]);
        })();
        return retirement;
      };
      const secure = target.url.protocol === 'https:';
      const request = (secure ? https : http)(
        {
          protocol: target.url.protocol,
          hostname: target.address,
          family: target.family,
          port: secure ? 443 : 80,
          method: 'GET',
          path: target.url.pathname + target.url.search,
          headers: { Host: target.url.host, 'Accept-Encoding': 'identity' },
          agent: false,
          // Destination is already a numeric IP, so neither proxy nor DNS can rebind it.
          ...(secure
            ? {
                servername: isIP(target.hostname) ? '' : target.hostname,
                rejectUnauthorized: true,
              }
            : {}),
          signal,
        },
        (incoming) => {
          response = incoming;
          responseClosed = new Promise<void>((done) =>
            response!.once('close', done),
          );
          if (!samePeer(response.socket.remoteAddress, target.address)) {
            void close().then(() =>
              reject(new ImportFailure('SOURCE_NOT_ALLOWED')),
            );
            return;
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            peerAddress: response.socket.remoteAddress,
            body: response,
            close,
          });
        },
      );
      const requestClosed = new Promise<void>((done) =>
        request.once('close', done),
      );
      request.on('socket', (socket) => {
        socketClosed = new Promise<void>((done) => socket.once('close', done));
        socket.once(secure ? 'secureConnect' : 'connect', () => {
          if (!samePeer(socket.remoteAddress, target.address))
            request.destroy(new ImportFailure('SOURCE_NOT_ALLOWED'));
        });
      });
      request.once('error', (error) => {
        void close().then(() => reject(error));
      });
      request.end();
    });
}

function allowedUrl(raw: string, base?: URL): URL {
  // WHATWG URL repairs several malformed inputs, so reject those before parsing.
  if (
    [...raw].some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) ||
    raw.includes('\\')
  )
    throw new ImportFailure('SOURCE_NOT_ALLOWED');
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new ImportFailure('SOURCE_NOT_ALLOWED');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.port
  )
    throw new ImportFailure('SOURCE_NOT_ALLOWED');
  if (base?.protocol === 'https:' && url.protocol !== 'https:')
    throw new ImportFailure('SOURCE_NOT_ALLOWED');
  return url;
}

export function createRemoteImageReader(dependencies: Dependencies) {
  return async (
    raw: string,
    callerSignal: AbortSignal,
  ): Promise<Uint8Array> => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    callerSignal.addEventListener('abort', cancel, { once: true });
    if (callerSignal.aborted) cancel();
    const timer = setTimeout(cancel, 30_000);
    const signal = controller.signal;
    try {
      let url = allowedUrl(raw);
      for (let redirects = 0; ; redirects++) {
        if (signal.aborted) throw new ImportFailure('IMAGE_UNAVAILABLE');
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const literal = isIP(hostname);
        const addresses = literal
          ? [{ address: hostname, family: literal }]
          : await dependencies.resolve(hostname, signal);
        if (signal.aborted) throw new ImportFailure('IMAGE_UNAVAILABLE');
        if (
          !addresses.length ||
          addresses.some(
            (item) =>
              !isPublicAddress(item.address) ||
              isIP(item.address) !== item.family,
          )
        )
          throw new ImportFailure('SOURCE_NOT_ALLOWED');
        const pinned = addresses[0];
        const response = await dependencies.request(
          {
            url,
            hostname,
            address: pinned.address,
            family: pinned.family as 4 | 6,
          },
          signal,
        );
        let closing: Promise<void> | undefined;
        const close = () => (closing ??= response.close());
        // Start destruction synchronously on abort; finally owns its completion.
        const cancelResponse = () => {
          void close().catch(() => {});
        };
        signal.addEventListener('abort', cancelResponse, { once: true });
        let iterator: AsyncIterator<Uint8Array> | undefined;
        try {
          if (signal.aborted) throw new ImportFailure('IMAGE_UNAVAILABLE');
          if (!samePeer(response.peerAddress, pinned.address))
            throw new ImportFailure('SOURCE_NOT_ALLOWED');
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (redirects >= 3 || typeof response.headers.location !== 'string')
              throw new ImportFailure('SOURCE_NOT_ALLOWED');
            url = allowedUrl(response.headers.location, url);
            continue;
          }
          if (
            response.status !== 200 ||
            (response.headers['content-encoding'] !== undefined &&
              response.headers['content-encoding'] !== 'identity')
          )
            throw new ImportFailure('IMAGE_UNAVAILABLE');
          const chunks: Uint8Array[] = [];
          let count = 0;
          iterator = response.body[Symbol.asyncIterator]();
          for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            count += next.value.byteLength;
            if (count > MAX_BYTES)
              throw new ImportFailure('IMAGE_LIMIT_EXCEEDED');
            chunks.push(next.value);
          }
          if (signal.aborted) throw new ImportFailure('IMAGE_UNAVAILABLE');
          return Buffer.concat(chunks, count);
        } finally {
          signal.removeEventListener('abort', cancelResponse);
          try {
            await close();
          } finally {
            await iterator?.return?.();
          }
        }
      }
    } catch (error) {
      throw error instanceof ImportFailure
        ? error
        : new ImportFailure('IMAGE_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      callerSignal.removeEventListener('abort', cancel);
    }
  };
}

export const readRemoteImage = createRemoteImageReader({
  resolve: resolveImageHost,
  request: createNodeTransport(),
});
