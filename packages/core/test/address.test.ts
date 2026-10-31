import { test } from 'node:test';
import assert from 'node:assert/strict';
import { navigationLinks } from '../src/address';
import { percentile } from '../src/perf';

test('navigationLinks genera enlaces universales', () => {
  const l = navigationLinks({ lat: 40.4, lng: -3.7 });
  assert.match(l.waze, /^https:\/\/waze\.com\/ul\?ll=40\.4,-3\.7&navigate=yes$/);
  assert.match(l.googleMaps, /destination=40\.4,-3\.7/);
});

test('percentile nearest-rank', () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([10, 20, 30, 40, 200], 95), 200);
  assert.equal(percentile([5, 1, 3], 50), 3);
});
