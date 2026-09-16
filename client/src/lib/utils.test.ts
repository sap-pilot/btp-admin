import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cn } from './utils.js';

describe('cn — class merging utility', () => {
  test('merges plain class strings', () => {
    assert.equal(cn('foo', 'bar'), 'foo bar');
  });

  test('single class returns unchanged', () => {
    assert.equal(cn('only-class'), 'only-class');
  });

  test('drops falsy values (false, null, undefined, 0)', () => {
    const result = cn('a', false, null, undefined, 0 as unknown as string, 'b');
    assert.equal(result, 'a b');
  });

  test('handles conditional object syntax', () => {
    const active = true;
    const disabled = false;
    const result = cn({ 'font-bold': active, italic: disabled });
    assert.equal(result, 'font-bold');
  });

  test('merges object and string arguments', () => {
    const result = cn('base-class', { extra: true, skipped: false });
    assert.equal(result, 'base-class extra');
  });

  test('deduplicates conflicting Tailwind classes (last wins)', () => {
    // tailwind-merge resolves conflicts: last p-* wins
    const result = cn('p-2', 'p-4');
    assert.equal(result, 'p-4');
  });

  test('deduplicates conflicting text-color classes', () => {
    const result = cn('text-red-500', 'text-blue-500');
    assert.equal(result, 'text-blue-500');
  });

  test('keeps non-conflicting Tailwind utilities', () => {
    const result = cn('flex', 'items-center', 'justify-between');
    assert.equal(result, 'flex items-center justify-between');
  });

  test('empty call returns empty string', () => {
    assert.equal(cn(), '');
  });

  test('handles array syntax (via clsx spread)', () => {
    const result = cn(['a', 'b'], 'c');
    assert.equal(result, 'a b c');
  });
});
