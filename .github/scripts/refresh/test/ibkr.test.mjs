import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import { parseStatements, flexError, accountKeyMap } from '../fetch-ibkr.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const fixture = async f => parser.parse(await readFile(new URL('./fixtures/' + f, import.meta.url), 'utf8'));

test('parseStatements maps two accounts with nav/cash/dayPnl/positions/equity', async () => {
  const accounts = parseStatements(await fixture('flex-sample.xml'));
  assert.equal(accounts.length, 2);
  const [a, b] = accounts;
  assert.equal(a.accountId, 'U1111111');
  assert.equal(a.asOf, '2026-07-08');
  assert.equal(a.nav, 412386.54);
  assert.equal(a.cash, 31200);
  assert.equal(a.dayPnl, 2386.12); // 412386.54 - 410000.42
  assert.equal(a.totalUnrl, 34044.2); // 21140.20 + 12904.00
  assert.equal(a.positions.length, 2);
  assert.equal(a.equity.length, 2);
  assert.equal(b.asOf, '2026-07-08', 'YYYYMMDD reportDate normalized');
  assert.equal(b.equity[0].as_of, '2026-07-07');
});

test('flexError surfaces soft errors, null on success docs', async () => {
  const err = flexError(await fixture('flex-error.xml'));
  assert.equal(err.code, '1019');
  assert.match(err.message, /generation in progress/i);
  assert.equal(flexError(await fixture('flex-sample.xml')), null);
});

test('accountKeyMap: explicit env map wins, else sorted order', () => {
  process.env.IBKR_ACCOUNT_MAP = 'U2222222=1,U1111111=2';
  assert.equal(accountKeyMap(['U1111111', 'U2222222'])('U1111111'), 2);
  delete process.env.IBKR_ACCOUNT_MAP;
  const keyFor = accountKeyMap(['U2222222', 'U1111111']);
  assert.equal(keyFor('U1111111'), 1);
  assert.equal(keyFor('U2222222'), 2);
  assert.equal(accountKeyMap(['U1111111'])('U9999999'), null, 'unknown ids map to null and get filtered');
});
