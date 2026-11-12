import crypto from 'node:crypto';
import { JSDOM } from 'jsdom';
import type { FieldConfig, ScrapeConfig, Selector, Transform } from '../contract/schemas.js';

// jsdom is created WITHOUT `runScripts` and `resources`, so page scripts never
// run and no subresource is fetched: it is used purely as a DOM + XPath engine.

export interface ParsedPage {
  document: Document;
  /** Absolute URL used to resolve relative links. */
  url: string;
  close(): void;
}

export function parsePage(html: string, url: string): ParsedPage {
  const dom = new JSDOM(html, { url, contentType: 'text/html' });
  return { document: dom.window.document, url, close: () => dom.window.close() };
}

// ----------------------------------------------------------------- selectors

const XPATH_ANY = 0;
const XPATH_ORDERED_SNAPSHOT = 7;
const NODE = { ELEMENT: 1, ATTRIBUTE: 2, TEXT: 3, CDATA: 4 } as const;

type Scope = Document | Element;

function docOf(scope: Scope): Document {
  return scope.nodeType === 9 ? (scope as Document) : (scope as Element).ownerDocument;
}

/** Result of selecting with one selector: DOM nodes or (XPath) primitives. */
type Picked = Node | string | number | boolean;

function xpathAll(scope: Scope, expr: string): Picked[] {
  const doc = docOf(scope);
  const res = doc.evaluate(expr, scope, null, XPATH_ANY, null);
  switch (res.resultType) {
    case 1:
      return [res.numberValue];
    case 2:
      return [res.stringValue];
    case 3:
      return [res.booleanValue];
    default: {
      const snap = doc.evaluate(expr, scope, null, XPATH_ORDERED_SNAPSHOT, null);
      const out: Node[] = [];
      for (let i = 0; i < snap.snapshotLength; i++) out.push(snap.snapshotItem(i)!);
      return out;
    }
  }
}

export function selectAll(scope: Scope, sel: Selector): Picked[] {
  if (sel.type === 'css') return Array.from(scope.querySelectorAll(sel.value));
  return xpathAll(scope, sel.value);
}

export function selectFirst(scope: Scope, sel: Selector): Picked | null {
  if (sel.type === 'css') return scope.querySelector(sel.value);
  return xpathAll(scope, sel.value)[0] ?? null;
}

/** Throws if the selector is syntactically invalid. */
export function validateSelector(sel: Selector): void {
  const doc = new JSDOM('<html><body></body></html>').window.document;
  if (sel.type === 'css') doc.querySelector(sel.value);
  else doc.evaluate(sel.value, doc, null, XPATH_ANY, null);
}

export function validateConfigSelectors(config: ScrapeConfig): string[] {
  const errors: string[] = [];
  const check = (path: string, sel: Selector | undefined) => {
    if (!sel) return;
    try {
      validateSelector(sel);
    } catch (e) {
      errors.push(`${path}: invalid ${sel.type} selector "${sel.value}" (${(e as Error).message})`);
    }
  };
  check('extraction.itemSelector', config.extraction.itemSelector);
  config.extraction.fields.forEach((f, i) => check(`extraction.fields[${i}].selector`, f.selector));
  if (config.navigation.pagination.type === 'nextLink') {
    check('navigation.pagination.selector', config.navigation.pagination.selector);
  }
  check('navigation.followLinks.selector', config.navigation.followLinks?.selector);
  return errors;
}

// -------------------------------------------------------------------- values

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function rawValue(picked: Picked, attr: string): string | null {
  if (typeof picked === 'string') return picked;
  if (typeof picked === 'number' || typeof picked === 'boolean') return String(picked);
  const node = picked;
  switch (node.nodeType) {
    case NODE.ATTRIBUTE:
      return (node as Attr).value;
    case NODE.TEXT:
    case NODE.CDATA:
      return (node as Text).data;
    case NODE.ELEMENT: {
      const el = node as Element;
      if (attr === 'text') return el.textContent ?? '';
      if (attr === 'html') return el.innerHTML;
      return el.getAttribute(attr);
    }
    default:
      return node.textContent;
  }
}

export function parseNumber(input: string): number | null {
  // Keep digits, separators and sign; drop currency symbols, letters, spaces.
  let s = input.replace(/[^\d.,\-+]/g, '');
  const negative = /^-|-$/.test(s.trim()) || /^\(.*\)$/.test(input.trim());
  s = s.replace(/[+-]/g, '');
  if (!/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let normalized: string;
  if (lastDot !== -1 && lastComma !== -1) {
    // The right-most separator is the decimal one.
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    normalized = s.split(thou).join('').replace(dec, '.');
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? '.' : ',';
    const count = s.split(sep).length - 1;
    const after = s.length - s.lastIndexOf(sep) - 1;
    // "1.234" / "1,234,567" => thousands; "12.5" / "3,50" => decimal.
    if (count > 1 || (after === 3 && !/^0[.,]/.test(s))) normalized = s.split(sep).join('');
    else normalized = s.replace(sep, '.');
  } else {
    normalized = s;
  }
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export function parseDate(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  // Day-first numeric dates (dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy).
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (dmy) {
    const [, d, m, y, hh = '0', mm = '0', ss = '0'] = dmy;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)));
    if (date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) return null;
    return date.toISOString();
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

export function applyTransform(value: string | null, transform: Transform, pageUrl: string): string | number | null {
  if (value === null) return null;
  switch (transform) {
    case 'trim': {
      const v = value.trim();
      return v === '' ? null : v;
    }
    case 'number':
      return parseNumber(value);
    case 'absoluteUrl': {
      const v = value.trim();
      if (!v) return null;
      try {
        return new URL(v, pageUrl).href;
      } catch {
        return null;
      }
    }
    case 'date':
      return parseDate(value);
  }
}

export function extractField(scope: Scope, field: FieldConfig, pageUrl: string): string | number | null {
  const picked = selectFirst(scope, field.selector);
  if (picked === null) return null;
  let raw = rawValue(picked, field.attr);
  if (raw !== null && field.attr === 'text' && typeof picked === 'object') raw = collapse(raw);
  return applyTransform(raw, field.transform, pageUrl);
}

// --------------------------------------------------------------------- items

export interface RawItem {
  data: Record<string, string | number | null>;
}

export interface ExtractionOutcome {
  items: RawItem[];
  /** Candidates found (list mode: matched item nodes; single: 1). */
  candidates: number;
  /** Candidates discarded (missing required field or no data at all). */
  skipped: number;
}

export function extractItems(page: ParsedPage, extraction: ScrapeConfig['extraction']): ExtractionOutcome {
  const scopes: Scope[] =
    extraction.mode === 'list'
      ? selectAll(page.document, extraction.itemSelector!).filter(
          (n): n is Element => typeof n === 'object' && n.nodeType === NODE.ELEMENT,
        )
      : [page.document];

  const items: RawItem[] = [];
  let skipped = 0;
  for (const scope of scopes) {
    const data: Record<string, string | number | null> = {};
    let missingRequired = false;
    let anyValue = false;
    for (const f of extraction.fields) {
      let v: string | number | null = null;
      try {
        v = extractField(scope, f, page.url);
      } catch {
        v = null;
      }
      data[f.key] = v;
      if (v === null) {
        if (f.required) missingRequired = true;
      } else {
        anyValue = true;
      }
    }
    if (missingRequired || !anyValue) {
      skipped++;
      continue;
    }
    items.push({ data });
  }
  return { items, candidates: scopes.length, skipped };
}

// ---------------------------------------------------------------- dedupe key

/** Canonical JSON (sorted keys) so equal data always hashes equally. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * SHA-256 (hex) of the values of `dedupeKeyFields` (in the configured order),
 * or of the whole `data` object when no fields are configured.
 */
export function computeDedupeKey(
  data: Record<string, unknown>,
  dedupeKeyFields?: string[],
): string {
  const payload =
    dedupeKeyFields && dedupeKeyFields.length > 0
      ? JSON.stringify(dedupeKeyFields.map((k) => data[k] ?? null))
      : canonicalJson(data);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// --------------------------------------------------------------------- links

export function extractLinks(page: ParsedPage, sel: Selector): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const picked of selectAll(page.document, sel)) {
    let href: string | null = null;
    if (typeof picked === 'string') href = picked;
    else if (typeof picked === 'object') {
      if (picked.nodeType === NODE.ATTRIBUTE) href = (picked as Attr).value;
      else if (picked.nodeType === NODE.ELEMENT) {
        const el = picked as Element;
        href = el.getAttribute('href') ?? el.getAttribute('src');
      }
    }
    if (!href) continue;
    try {
      const abs = new URL(href.trim(), page.url);
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
      abs.hash = '';
      if (!seen.has(abs.href)) {
        seen.add(abs.href);
        out.push(abs.href);
      }
    } catch {
      /* ignore unparsable links */
    }
  }
  return out;
}

export function extractFirstLink(page: ParsedPage, sel: Selector): string | null {
  return extractLinks(page, sel)[0] ?? null;
}
