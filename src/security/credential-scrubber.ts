/**
 * Credential Scrubber
 *
 * Strips sensitive data from captured network traffic before output:
 * - Authorization headers (Bearer, Basic, Proxy-Authorization)
 * - Cookie / Set-Cookie headers
 * - Custom auth headers (X-API-Key, X-Auth-Token, X-Session-ID, X-CSRF-Token, X-XSRF-Token)
 * - Bearer tokens in URLs
 * - API keys in query parameters and URL fragments
 * - JWTs
 * - Password, secret, token fields in request/response bodies
 * - Credit card numbers
 * - AWS access keys
 * - Environment variable values in output text
 */

export interface ScrubOptions {
  includeCookies?: boolean;
  additionalPatterns?: RegExp[];
}

export interface HeaderMap {
  [key: string]: string;
}

// -------------------------------------------------------------------------
// Sensitive header patterns (case-insensitive matching)
// -------------------------------------------------------------------------

/** Headers that are always scrubbed (regardless of includeCookies). */
const ALWAYS_SCRUB_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-session-id',
  'x-csrf-token',
  'x-xsrf-token',
]);

/** Cookie-related headers (scrubbed by default, preserved when includeCookies is true). */
const COOKIE_HEADERS = new Set([
  'cookie',
  'set-cookie',
]);

// -------------------------------------------------------------------------
// Sensitive URL query parameter names
// -------------------------------------------------------------------------
const SENSITIVE_PARAMS = new Set([
  'token',
  'api_key',
  'apikey',
  'key',
  'secret',
  'password',
  'passwd',
  'access_token',
  'auth',
  'id_token',
]);

// -------------------------------------------------------------------------
// Sensitive JSON body field names (case-insensitive matching)
// -------------------------------------------------------------------------
const SENSITIVE_BODY_FIELDS = new Set([
  'password',
  'passwd',
  'secret',
  'client_secret',
  'token',
  'access_token',
  'refresh_token',
  'apikey',
  'api_key',
  'aws_access_key',
  'aws_secret_key',
  'sessiontoken',
]);

// -------------------------------------------------------------------------
// Credit card regex (Visa, Mastercard, Amex, Discover, etc.)
// Matches 13-19 digit card numbers with optional spaces or dashes
// -------------------------------------------------------------------------
const CREDIT_CARD_RE = /\b(?:\d[ -]*?){13,19}\b/g;

/**
 * Validate a potential credit card number using the Luhn algorithm.
 */
function isLuhnValid(digits: string): boolean {
  const nums = digits.replace(/\D/g, '');
  if (nums.length < 13 || nums.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let i = nums.length - 1; i >= 0; i--) {
    let n = parseInt(nums[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

// -------------------------------------------------------------------------
// AWS key patterns
// -------------------------------------------------------------------------
const AWS_ACCESS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g;
const AWS_SECRET_KEY_RE = /\b[A-Za-z0-9/+=]{40}\b/g;

// -------------------------------------------------------------------------
// JWT pattern: eyJ<base64>.<base64>.<signature>
// -------------------------------------------------------------------------
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

/**
 * Scrub sensitive headers from a header map.
 * Replaces sensitive header values with [REDACTED].
 * Removes Cookie/Set-Cookie by default, preserves when includeCookies is true.
 */
export function scrubHeaders(
  headers: HeaderMap,
  options?: ScrubOptions
): HeaderMap {
  const result: HeaderMap = {};
  const includeCookies = options?.includeCookies ?? false;

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();

    if (ALWAYS_SCRUB_HEADERS.has(lower)) {
      result[key] = '[REDACTED]';
      continue;
    }

    if (COOKIE_HEADERS.has(lower)) {
      if (includeCookies) {
        result[key] = value;
      } else {
        result[key] = '[REDACTED]';
      }
      continue;
    }

    result[key] = value;
  }

  return result;
}

/**
 * Scrub sensitive values from a URL (query parameters and fragment).
 * Masks: token, api_key, apiKey, key, secret, password, access_token, auth, id_token
 */
export function scrubUrl(url: string): string {
  try {
    const parsed = new URL(url);

    // Build scrubbed query string manually to avoid percent-encoding of [REDACTED]
    const params = Array.from(parsed.searchParams.entries());
    if (params.length > 0) {
      const scrubbedParams = params.map(([key, value]) => {
        if (SENSITIVE_PARAMS.has(key.toLowerCase())) {
          return `${key}=[REDACTED]`;
        }
        return `${key}=${value}`;
      });
      // Replace the search portion manually
      const baseUrl = parsed.origin + parsed.pathname;
      let result = baseUrl + '?' + scrubbedParams.join('&');

      // Scrub fragment
      if (parsed.hash) {
        result += scrubFragment(parsed.hash);
      }

      result = maskJwt(result);
      return result;
    }

    // No query params — handle fragment only
    let result = parsed.origin + parsed.pathname;
    if (parsed.hash) {
      result += scrubFragment(parsed.hash);
    }

    result = maskJwt(result);
    return result;
  } catch {
    // If URL parsing fails, do best-effort string replacement
    return maskJwt(url);
  }
}

/**
 * Scrub sensitive params from a URL fragment string (e.g., #access_token=xxx).
 */
function scrubFragment(hash: string): string {
  if (!hash || hash === '#') return hash;

  const fragment = hash.substring(1); // remove #
  try {
    const fragmentParams = new URLSearchParams(fragment);
    const entries = Array.from(fragmentParams.entries());
    if (entries.length === 0) return hash;

    let hasChanges = false;
    const scrubbedParts = entries.map(([key, value]) => {
      if (SENSITIVE_PARAMS.has(key.toLowerCase())) {
        hasChanges = true;
        return `${key}=[REDACTED]`;
      }
      return `${key}=${value}`;
    });

    if (hasChanges) {
      return '#' + scrubbedParts.join('&');
    }
  } catch {
    // Not parseable as params
  }
  return hash;
}

/**
 * Detect and mask JWT tokens in a string.
 */
export function maskJwt(value: string): string {
  return value.replace(JWT_RE, '[JWT REDACTED]');
}

/**
 * Scrub sensitive fields from a JSON object, recursively.
 */
function scrubJsonObject(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => scrubJsonObject(item));
  }

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_BODY_FIELDS.has(key.toLowerCase())) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = scrubJsonObject(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Scrub credit card numbers from text.
 */
function scrubCreditCards(text: string): string {
  return text.replace(CREDIT_CARD_RE, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && isLuhnValid(digits)) {
      return '[CARD REDACTED]';
    }
    return match;
  });
}

/**
 * Scrub AWS access keys from text.
 */
function scrubAwsKeys(text: string): string {
  return text.replace(AWS_ACCESS_KEY_RE, '[AWS_KEY REDACTED]');
}

/**
 * Scrub form-encoded body sensitive fields.
 */
function scrubFormBody(body: string): string {
  try {
    const params = new URLSearchParams(body);
    let changed = false;
    for (const [key] of params) {
      if (SENSITIVE_BODY_FIELDS.has(key.toLowerCase())) {
        params.set(key, '[REDACTED]');
        changed = true;
      }
    }
    return changed ? params.toString() : body;
  } catch {
    return body;
  }
}

/**
 * Scrub sensitive fields from a request/response body string.
 * Handles JSON bodies with password, secret, token, apiKey fields.
 * Handles form-encoded bodies.
 * Handles credit card patterns and AWS keys.
 * Handles non-JSON gracefully.
 */
export function scrubBody(body: string): string {
  if (!body) return body;

  let result = body;

  // Try JSON parse
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const scrubbed = scrubJsonObject(parsed);
      result = JSON.stringify(scrubbed);
      // Still apply pattern-based scrubbing for credit cards and AWS keys
      result = scrubCreditCards(result);
      result = scrubAwsKeys(result);
      return result;
    }
  } catch {
    // Not valid JSON — try other formats
  }

  // Try form-encoded
  if (body.includes('=') && !body.includes(' ') && !body.startsWith('{')) {
    result = scrubFormBody(body);
    result = scrubCreditCards(result);
    result = scrubAwsKeys(result);
    return result;
  }

  // Plain text — apply pattern-based scrubbing
  result = scrubCreditCards(result);
  result = scrubAwsKeys(result);

  // Best-effort regex scrub for password/secret patterns in malformed JSON
  result = result.replace(
    /("(?:password|passwd|secret|client_secret|token|access_token|refresh_token|apiKey|api_key|aws_access_key|aws_secret_key|SessionToken)")\s*:\s*"([^"]*?)"/gi,
    '$1: "[REDACTED]"'
  );

  return result;
}

/**
 * Alias for scrubBody — used by security tests as scrubResponseBody.
 */
export function scrubResponseBody(body: string): string {
  if (!body) return body;

  let result = body;

  // Try JSON parse
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const scrubbed = scrubJsonObject(parsed);
      result = JSON.stringify(scrubbed);
      result = scrubCreditCards(result);
      result = scrubAwsKeys(result);
      return result;
    }
  } catch {
    // Not valid JSON
  }

  // Try form-encoded (detect by presence of & and = without spaces before first &)
  if (body.includes('=') && /^[^{<]/.test(body)) {
    const maybeForm = scrubFormBody(body);
    if (maybeForm !== body) {
      result = maybeForm;
      result = scrubCreditCards(result);
      result = scrubAwsKeys(result);
      return result;
    }
  }

  // Plain text — apply pattern-based scrubbing
  result = scrubCreditCards(result);
  result = scrubAwsKeys(result);

  // Best-effort regex scrub for sensitive field patterns in malformed/partial JSON
  result = result.replace(
    /("(?:password|passwd|secret|client_secret|token|access_token|refresh_token|apiKey|api_key|aws_access_key|aws_secret_key|SessionToken)")\s*:\s*"([^"]*?)"/gi,
    '$1:"[REDACTED]"'
  );

  return result;
}

/**
 * Scrub known environment variable values from text.
 * Only scrubs values longer than 3 characters to avoid false positives.
 */
export function scrubEnvValues(text: string, envVarNames: string[]): string {
  let result = text;

  for (const name of envVarNames) {
    const value = process.env[name];
    if (!value || value.length <= 3) continue;

    // Escape regex special characters in the value
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'g');
    result = result.replace(re, `[ENV:${name}]`);
  }

  return result;
}

/**
 * Scrub all sensitive data from a captured network request.
 */
export function scrubRequest(
  request: {
    url: string;
    headers: HeaderMap;
    body?: string;
  },
  options?: ScrubOptions
): {
  url: string;
  headers: HeaderMap;
  body?: string;
} {
  return {
    url: scrubUrl(request.url),
    headers: scrubHeaders(request.headers, options),
    body: request.body ? scrubBody(request.body) : undefined,
  };
}
