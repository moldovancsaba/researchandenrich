import test from 'node:test';
import assert from 'node:assert/strict';
import { makeResult, mergeResults } from '../src/resultSchema.js';

test('merges duplicate URLs across engines and keeps provenance for both', () => {
  const a = makeResult({ url: 'https://Example.com/Page/', title: 'From A', snippet: 'a-snippet', engine: 'parallel', rank: 1 });
  const b = makeResult({ url: 'https://example.com/page', title: '', snippet: 'b-snippet', engine: 'youcom', rank: 3 });
  const merged = mergeResults([a, b]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sourceCount, 2);
  assert.equal(merged[0].bestRank, 1);
  const engines = merged[0].sources.map((s) => s.engine).sort();
  assert.deepEqual(engines, ['parallel', 'youcom']);
  assert.equal(merged[0].title, 'From A'); // first non-empty title wins
});

test('keeps distinct URLs separate and sorts by source count then best rank', () => {
  const a = makeResult({ url: 'https://a.com/1', engine: 'wiby', rank: 2 });
  const b = makeResult({ url: 'https://a.com/2', engine: 'wiby', rank: 1 });
  const c = makeResult({ url: 'https://a.com/2', engine: 'parallel', rank: 1 });
  const merged = mergeResults([a, b, c]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].url, 'https://a.com/2'); // 2 sources beats 1 source even though rank ties
  assert.equal(merged[0].sourceCount, 2);
  assert.equal(merged[1].url, 'https://a.com/1');
});

test('drops entries with no URL rather than crashing', () => {
  const a = makeResult({ url: '', title: 'no url', engine: 'parallel', rank: 1 });
  const merged = mergeResults([a]);
  assert.equal(merged.length, 0);
});
