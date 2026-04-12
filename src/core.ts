import LZString from 'lz-string';

export const URL_CODE_PARAM = 'code';
export const MAX_URL_LENGTH = 8000;
export const DEFAULT_BASE_URL =
  process.env.DIAGENT_BASE_URL ?? 'https://diagent.dev/';

export type EncodeResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

export type DecodeResult =
  | { ok: true; mermaid: string }
  | { ok: false; error: string };

/** Matches a `/d/<10 base32 chars>` short URL path. */
const SHORT_URL_PATH_RE = /^\/d\/[a-z2-7]{10}$/;

export function buildShareableUrl(
  mermaid: string,
  baseUrl: string = DEFAULT_BASE_URL,
): EncodeResult {
  if (!mermaid || !mermaid.trim()) {
    return { ok: false, error: 'Nothing to encode' };
  }
  const encoded = LZString.compressToEncodedURIComponent(mermaid);
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = `${normalized}?${URL_CODE_PARAM}=${encoded}`;
  if (url.length > MAX_URL_LENGTH) {
    return {
      ok: false,
      error: `Diagram too large for URL (${url.length} > ${MAX_URL_LENGTH} chars)`,
    };
  }
  return { ok: true, url };
}

export function extractMermaidFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const raw = parsed.searchParams.get(URL_CODE_PARAM);
  if (!raw) return null;
  const decoded = LZString.decompressFromEncodedURIComponent(raw);
  return decoded || null;
}

/**
 * Try to shorten a Mermaid source via the backend (`POST {baseUrl}api/s`).
 * Returns a short URL on success, or an error result on any failure
 * (network, 3s timeout, non-2xx). Retries once after a 500ms delay to
 * absorb cold-start hiccups and transient 5xxs from Cloudflare Workers.
 * Callers should fall back to `buildShareableUrl` for the inline format.
 */
export async function shortenViaBackend(
  mermaid: string,
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<EncodeResult> {
  if (!mermaid || !mermaid.trim()) {
    return { ok: false, error: 'Nothing to encode' };
  }
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const apiUrl = `${normalized}api/s`;

  const attempt = async (): Promise<EncodeResult> => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: mermaid,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return { ok: false, error: `backend ${res.status}` };
      const data = (await res.json()) as { id?: string; url?: string };
      if (!data?.url) return { ok: false, error: 'malformed backend response' };
      return { ok: true, url: data.url };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'network error',
      };
    }
  };

  const first = await attempt();
  if (first.ok) return first;

  // Retry once after a short delay — first-call cold starts and
  // transient 5xxs are common on Cloudflare Workers free tier.
  await new Promise((r) => setTimeout(r, 500));
  return attempt();
}

/**
 * Resolve any Diagent URL (inline `?code=` OR short `/d/<id>`) to its
 * underlying Mermaid source. For inline URLs this is a synchronous
 * extraction. For short URLs this HEADs the URL to follow the 302 Location
 * header, then extracts `?code=` from the redirect target. 3s timeout;
 * fails fast with a typed error result.
 */
export async function resolveMermaidFromUrl(
  url: string,
): Promise<DecodeResult> {
  // Fast path: inline ?code= URLs don't need a network call.
  const direct = extractMermaidFromUrl(url);
  if (direct) return { ok: true, mermaid: direct };

  // Parse the URL to check for the /d/<id> short-URL shape.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'not a valid URL' };
  }
  if (!SHORT_URL_PATH_RE.test(parsed.pathname)) {
    return {
      ok: false,
      error: 'URL has no ?code= param and is not a /d/<id> short URL',
    };
  }

  // Follow the 302 to pull the underlying inline URL, then recurse.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status !== 302) {
      return {
        ok: false,
        error: `backend returned ${res.status}, expected 302`,
      };
    }
    const location = res.headers.get('location');
    if (!location) {
      return { ok: false, error: 'backend 302 missing Location header' };
    }
    // Worker redirects a missing /d/:id to /?notfound=:id so both
    // browser and CLI get a structured signal. Surface a specific,
    // user-friendly error that the agent can relay verbatim.
    try {
      const locUrl = new URL(location, parsed.origin);
      const nfId = locUrl.searchParams.get('notfound');
      if (nfId) {
        return {
          ok: false,
          error: `short URL /d/${nfId} was not found (may have been deleted or never existed)`,
        };
      }
    } catch {
      // Fall through to the existing decode path; if the Location is
      // malformed, extractMermaidFromUrl will return its own error.
    }
    const decoded = extractMermaidFromUrl(location);
    if (!decoded) {
      return {
        ok: false,
        error: 'redirect target has no valid ?code= param',
      };
    }
    return { ok: true, mermaid: decoded };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'network error',
    };
  }
}

/**
 * Primary encode entry point: tries the backend first (unless preferInline
 * is set), falls back to inline URL on failure. The caller gets both the
 * result and a flag indicating which path produced it.
 */
export async function shortenOrInline(
  mermaid: string,
  baseUrl: string = DEFAULT_BASE_URL,
  preferInline = false,
): Promise<{ result: EncodeResult; usedFallback: boolean }> {
  if (!preferInline) {
    const short = await shortenViaBackend(mermaid, baseUrl);
    if (short.ok) return { result: short, usedFallback: false };
  }
  return {
    result: buildShareableUrl(mermaid, baseUrl),
    usedFallback: !preferInline,
  };
}
