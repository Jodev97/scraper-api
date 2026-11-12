import { describe, expect, it } from 'vitest';
import {
  applyTransform,
  computeDedupeKey,
  extractItems,
  extractLinks,
  parseDate,
  parseNumber,
  parsePage,
  validateSelector,
} from '../../src/extraction/extract.js';
import { scrapeConfigSchema } from '../../src/contract/schemas.js';

const HTML = `<!doctype html><html><body>
<div class="producto"><h2> Camiseta   roja </h2><span class="precio">€ 1.234,50</span><a href="/p/1">ver</a><time datetime="2024-03-05">5 mar</time></div>
<div class="producto"><h2>Pantalón</h2><span class="precio">$12.99</span><a href="https://other.com/p/2">ver</a></div>
<div class="producto"><span class="precio">3</span></div>
<a class="siguiente" href="?page=2">Siguiente</a>
<a class="detalle" href="/d/1#x">d1</a><a class="detalle" href="/d/1">d1 dup</a><a class="detalle" href="mailto:a@b.c">m</a>
</body></html>`;

const page = () => parsePage(HTML, 'https://shop.example.com/productos');

const cfg = (extraction: unknown) =>
  scrapeConfigSchema.parse({ version: 1, startUrls: ['https://shop.example.com/'], extraction }).extraction;

describe('extraction (CSS + XPath)', () => {
  it('extracts a list with CSS selectors, transforms and required', () => {
    const out = extractItems(
      page(),
      cfg({
        mode: 'list',
        itemSelector: { type: 'css', value: '.producto' },
        fields: [
          { key: 'titulo', selector: { type: 'css', value: 'h2' }, attr: 'text', required: true },
          { key: 'precio', selector: { type: 'css', value: '.precio' }, transform: 'number' },
          { key: 'url', selector: { type: 'css', value: 'a' }, attr: 'href', transform: 'absoluteUrl' },
        ],
      }),
    );
    expect(out.candidates).toBe(3);
    expect(out.skipped).toBe(1); // third product has no title (required)
    expect(out.items.map((i) => i.data)).toEqual([
      { titulo: 'Camiseta roja', precio: 1234.5, url: 'https://shop.example.com/p/1' },
      { titulo: 'Pantalón', precio: 12.99, url: 'https://other.com/p/2' },
    ]);
  });

  it('extracts with XPath, relative to each item', () => {
    const out = extractItems(
      page(),
      cfg({
        mode: 'list',
        itemSelector: { type: 'xpath', value: "//div[@class='producto']" },
        fields: [
          { key: 'titulo', selector: { type: 'xpath', value: './h2' }, required: true },
          { key: 'precio', selector: { type: 'xpath', value: ".//span[@class='precio']" }, transform: 'number' },
          { key: 'href', selector: { type: 'xpath', value: './a/@href' } },
          { key: 'ult', selector: { type: 'xpath', value: 'string(./h2)' } },
        ],
      }),
    );
    expect(out.items).toHaveLength(2);
    expect(out.items[0]!.data).toMatchObject({ titulo: 'Camiseta roja', precio: 1234.5, href: '/p/1' });
  });

  it('supports html and arbitrary attributes, and mixed selector types', () => {
    const out = extractItems(
      page(),
      cfg({
        mode: 'list',
        itemSelector: { type: 'css', value: '.producto' },
        fields: [
          { key: 'h', selector: { type: 'css', value: 'h2' }, attr: 'html', required: true },
          { key: 'when', selector: { type: 'xpath', value: './/time' }, attr: 'datetime', transform: 'date' },
        ],
      }),
    );
    expect(out.items[0]!.data).toEqual({ h: 'Camiseta   roja', when: '2024-03-05T00:00:00.000Z' });
  });

  it('single mode evaluates fields against the whole page', () => {
    const out = extractItems(
      page(),
      cfg({ mode: 'single', fields: [{ key: 't', selector: { type: 'css', value: 'h2' } }] }),
    );
    expect(out.items).toEqual([{ data: { t: 'Camiseta roja' } }]);
  });

  it('skips items where every field is empty', () => {
    const out = extractItems(
      page(),
      cfg({ mode: 'single', fields: [{ key: 'x', selector: { type: 'css', value: '.nope' } }] }),
    );
    expect(out.items).toHaveLength(0);
    expect(out.skipped).toBe(1);
  });

  it('extracts links (absolute, deduped, http(s) only, no fragments)', () => {
    const links = extractLinks(page(), { type: 'css', value: 'a.detalle' });
    expect(links).toEqual(['https://shop.example.com/d/1']);
    expect(extractLinks(page(), { type: 'xpath', value: "//a[@class='siguiente']/@href" })).toEqual([
      'https://shop.example.com/productos?page=2',
    ]);
  });

  it('validates selectors', () => {
    expect(() => validateSelector({ type: 'css', value: 'div[' })).toThrow();
    expect(() => validateSelector({ type: 'xpath', value: '//div[' })).toThrow();
    expect(() => validateSelector({ type: 'css', value: 'div > a.x' })).not.toThrow();
    expect(() => validateSelector({ type: 'xpath', value: ".//span[@class='precio']" })).not.toThrow();
  });
});

describe('transforms', () => {
  it('number', () => {
    const cases: Array<[string, number | null]> = [
      ['12', 12], ['12.5', 12.5], ['3,50', 3.5], ['1.234,56', 1234.56], ['1,234.56', 1234.56],
      ['1.234', 1234], ['1,234,567', 1234567], ['€ 99', 99], ['-5.5', -5.5], ['0.123', 0.123],
      ['abc', null], ['', null], ['  42 uds ', 42],
    ];
    for (const [input, expected] of cases) expect(parseNumber(input), input).toBe(expected);
  });
  it('date', () => {
    expect(parseDate('2024-03-05')).toBe('2024-03-05T00:00:00.000Z');
    expect(parseDate('05/03/2024')).toBe('2024-03-05T00:00:00.000Z'); // day-first
    expect(parseDate('31/02/2024')).toBeNull();
    expect(parseDate('2024-03-05T10:20:30Z')).toBe('2024-03-05T10:20:30.000Z');
    expect(parseDate('garbage')).toBeNull();
  });
  it('absoluteUrl and trim', () => {
    expect(applyTransform('/a?b=1', 'absoluteUrl', 'https://x.com/z/')).toBe('https://x.com/a?b=1');
    expect(applyTransform('../a', 'absoluteUrl', 'https://x.com/z/y')).toBe('https://x.com/a');
    expect(applyTransform('  hi  ', 'trim', 'https://x.com')).toBe('hi');
    expect(applyTransform('   ', 'trim', 'https://x.com')).toBeNull();
  });
});

describe('dedupeKey', () => {
  const data = { url: 'https://a/1', title: 'A', price: 3 };
  it('is the SHA-256 of the configured field values', () => {
    const k = computeDedupeKey(data, ['url']);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(k).toBe(computeDedupeKey({ ...data, title: 'changed' }, ['url']));
    expect(k).not.toBe(computeDedupeKey({ ...data, url: 'https://a/2' }, ['url']));
  });
  it('respects the order of fields', () => {
    expect(computeDedupeKey(data, ['url', 'title'])).not.toBe(computeDedupeKey(data, ['title', 'url']));
  });
  it('hashes the whole data object when no fields are configured (key-order independent)', () => {
    const a = computeDedupeKey({ a: 1, b: 2 });
    expect(a).toBe(computeDedupeKey({ b: 2, a: 1 }));
    expect(a).toBe(computeDedupeKey({ a: 1, b: 2 }, []));
    expect(a).not.toBe(computeDedupeKey({ a: 1, b: 3 }));
  });
});
