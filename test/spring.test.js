import test from 'node:test';
import assert from 'node:assert/strict';
import { spring, springSamples } from '../public/js/spring.js';

test('a spring starts at rest at 0 and settles at 1', () => {
  assert.equal(spring(0, 38, 0.35), 0);
  assert.ok(Math.abs(spring(2, 38, 0.35) - 1) < 0.001);
});

test('underdamped, it overshoots by the textbook amount, then comes back', () => {
  const zeta = 0.35, s = springSamples(1, 38, zeta, 1000), peak = Math.max(...s);
  const expected = 1 + Math.exp(-Math.PI * zeta / Math.sqrt(1 - zeta * zeta));
  assert.ok(Math.abs(peak - expected) < 0.001);
  assert.ok(s.at(-1) < peak);
});

test('samples are one a frame', () => {
  assert.equal(springSamples(0.24, 38, 0.35).length, 15);
});
