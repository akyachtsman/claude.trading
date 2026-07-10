import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseFeed, dedupeRank, mergeFeedConfig } from '../fetch-news.js';

const fixture = f => readFile(new URL('./fixtures/' + f, import.meta.url), 'utf8');

test('parseFeed reads RSS 2.0 items with dates', async () => {
  const items = parseFeed(await fixture('rss-cnbc.xml'), 'CNBC');
  assert.equal(items.length, 4);
  assert.equal(items[0].src, 'CNBC');
  assert.match(items[0].title, /S&P 500 ends higher/);
  assert.ok(items[0].at instanceof Date);
});

test('parseFeed splits Google News " - Source" suffix into src', async () => {
  const items = parseFeed(await fixture('rss-google-news.xml'), 'Google News');
  assert.equal(items[0].title, 'Nvidia hits fresh record as AI demand holds');
  assert.equal(items[0].src, 'Reuters');
});

test('parseFeed tolerates malformed XML', () => {
  assert.deepEqual(parseFeed('<not-a-feed>', 'X'), []);
});

test('parseFeed decodes numeric/HTML entities in titles', () => {
  const xml = '<rss><channel><item><title>&#x2018;Rates&#x2019; &amp; more &#8212; a test</title></item></channel></rss>';
  assert.equal(parseFeed(xml, 'X')[0].title, '‘Rates’ & more — a test');
});

test('mergeFeedConfig: owner file wins, junk falls back to defaults', () => {
  const merged = mergeFeedConfig({
    general: [{ src: 'Reuters', url: 'https://feeds.example.com/reuters' }, { src: 'bad', url: 'http://insecure' }],
    perTicker: { enabled: false },
    maxItems: 12,
  });
  assert.deepEqual(merged.general.map(f => f.src), ['Reuters'], 'non-https feed dropped');
  assert.equal(merged.perTicker.enabled, false);
  assert.equal(merged.maxItems, 12);
  const fallback = mergeFeedConfig(null);
  assert.equal(fallback.source, 'defaults');
  assert.equal(fallback.general.length, 2);
  assert.equal(mergeFeedConfig({ general: [] }).general.length, 2, 'empty roster falls back');
});

test('dedupeRank dedupes titles, ranks holdings first, caps 20', async () => {
  const general = parseFeed(await fixture('rss-cnbc.xml'), 'CNBC');
  const tagged = parseFeed(await fixture('rss-google-news.xml'), 'Google News').map(it => ({ ...it, chip: 'NVDA' }));
  const out = dedupeRank([...general, ...tagged], ['NVDA', 'TLT']);
  assert.equal(out.length, 4); // duplicate CNBC NVDA headline collapsed
  assert.ok(out[0].chips.length > 0, 'holdings-tagged items rank first');
  const tltTextMatch = out.find(it => /TLT slips/.test(it.title));
  assert.deepEqual(tltTextMatch.chips, ['TLT'], 'text-match degrade tags literal ticker mentions');
  assert.ok(out.every(it => it.chips.length <= 2));
});
