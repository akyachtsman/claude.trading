import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseFeed, dedupeRank } from '../fetch-news.js';

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
