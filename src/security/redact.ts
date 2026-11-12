import type { Secrets } from '../contract/schemas.js';

const REDACTED = '[REDACTED]';
const SENSITIVE_HEADER = /\b(authorization|proxy-authorization|cookie|set-cookie)\b(\s*["']?\s*[:=]\s*)(["']?)[^\r\n"']*/gi;

/**
 * Removes secret values and sensitive header values from any text that is
 * about to be logged, sent in a webhook or returned in an API response.
 */
export class Redactor {
  private readonly values: string[];

  constructor(secrets?: Secrets) {
    const vals = new Set<string>();
    for (const v of Object.values(secrets?.headers ?? {})) vals.add(v);
    for (const c of secrets?.cookies ?? []) vals.add(c.value);
    // Also catch the individual tokens of "Bearer xyz" style values.
    for (const v of [...vals]) {
      const parts = v.split(/\s+/);
      if (parts.length > 1) for (const p of parts) vals.add(p);
    }
    this.values = [...vals].filter((v) => v.length >= 3).sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    let out = text.replace(SENSITIVE_HEADER, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`);
    for (const v of this.values) {
      if (out.includes(v)) out = out.split(v).join(REDACTED);
    }
    return out;
  }
}

export const NO_REDACTION = new Redactor();
