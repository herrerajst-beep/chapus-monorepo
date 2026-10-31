import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approximateZone, isAddressRevealed, navigationLinks } from '../src/address';
import { percentile } from '../src/perf';

test('approximateZone deja solo código postal y ciudad', () => {
  assert.equal(approximateZone('Calle de Alcalá 45, 3ºB, 28014 Madrid'), '28014 Madrid');
  assert.equal(approximateZone('Av. Diagonal 640, 08017 Barcelona, España'), '08017 Barcelona');
  assert.equal(approximateZone('Plaza 1, 4º izq, 46001'), '46001');
  assert.equal(approximateZone('Calle Mayor 3, Sevilla'), 'Sevilla');
});

test('la dirección exacta solo se revela desde ASSIGNED', () => {
  assert.equal(isAddressRevealed('AWAITING_PAYMENT'), false);
  assert.equal(isAddressRevealed('OPEN'), false);
  assert.equal(isAddressRevealed('ASSIGNED'), true);
  assert.equal(isAddressRevealed('IN_PROGRESS'), true);
});

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
