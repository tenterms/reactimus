import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

let dispatcher: Dispatcher | undefined;

/**
 * fetch that honours HTTP(S)_PROXY / NO_PROXY environment variables.
 * Node's built-in fetch ignores them, which breaks page fetching in
 * proxied environments (e.g. Claude Code cloud sandboxes, corporate
 * networks). With no proxy variables set this behaves like plain fetch.
 */
export function proxyAwareFetch(
  url: string,
  init?: Parameters<typeof undiciFetch>[1],
): ReturnType<typeof undiciFetch> {
  if (
    !dispatcher &&
    (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy)
  ) {
    dispatcher = new EnvHttpProxyAgent();
  }
  return undiciFetch(url, { ...init, dispatcher });
}
