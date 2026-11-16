/**
 * Credential redaction (SECURITY-CBP §3.4). One implementation, four bridges use it:
 * `meta.raw` before the prompt, `call.args`, `reply.text`, and every driver log /
 * onState.lastError string. The key table is verbatim from §3.4 (case-insensitive key
 * match); the two string rules strip a query `token=`/`access_token=` tail and a
 * `scheme://user:pass@` userinfo. Completeness is NOT promised (§6-7): unknown vendor
 * key names, steganography, and tokens typed into message text stay.
 */
export const SENSITIVE_KEYS: readonly string[] = [
  'token',
  'access_token',
  'secret',
  'password',
  'passwd',
  'api_key',
  'apikey',
  'authorization',
  'cookie',
  'set-cookie',
  'csrf_token',
  'x-signature',
  'signature',
  'credentials',
];

const SENSITIVE = new Set(SENSITIVE_KEYS.map((k) => k.toLowerCase()));

/** `[?&](access_)?token=<value>` → value replaced by <redacted>; neighbours survive. */
const QUERY_TOKEN_RE = /([?&](?:access_)?token=)[^\s&]*/gi;
/** `scheme://user:pass@` → userinfo replaced by <redacted>. Port-only hosts do not match. */
const USERINFO_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@]+:[^\s@/]+@/g;

/** Strip query-token values and URL userinfo from a single string. */
export function redactText(s: string): string {
  return s.replace(QUERY_TOKEN_RE, '$1<redacted>').replace(USERINFO_RE, '$1<redacted>@');
}

/**
 * Deep copy with sensitive keys deleted (case-insensitive) and every string value run
 * through `redactText`. Non-sensitive structure survives verbatim — §3.4 keeps the
 * 「恒留」 rule as 「恒留剥除后的原始载荷」.
 */
export function redactJson<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactJson(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE.has(k.toLowerCase())) continue;
      out[k] = redactJson(v);
    }
    return out as T;
  }
  return value;
}
