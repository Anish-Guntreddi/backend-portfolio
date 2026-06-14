import { describe, expect, it } from 'vitest';
import { missingPlaceholders, placeholders, render } from '../src/template.ts';

describe('placeholders', () => {
  it('extracts distinct names in first-seen order, tolerating whitespace', () => {
    expect(placeholders('Hi {{ name }}, your {{item}} for {{name}} shipped')).toEqual(['name', 'item']);
  });
  it('returns empty for a template with no placeholders', () => {
    expect(placeholders('static text')).toEqual([]);
  });
});

describe('missingPlaceholders', () => {
  it('reports names absent or null/undefined in the data', () => {
    const t = 'Hello {{name}}, code {{code}}, ref {{ref}}';
    expect(missingPlaceholders(t, { name: 'Ada', code: null })).toEqual(['code', 'ref']);
  });
  it('treats 0 and empty string as present (only null/undefined are missing)', () => {
    expect(missingPlaceholders('{{a}}{{b}}', { a: 0, b: '' })).toEqual([]);
  });
});

describe('render', () => {
  it('interpolates values and stringifies non-strings', () => {
    expect(render('{{greeting}}, {{name}}! You have {{count}} messages.', {
      greeting: 'Hi',
      name: 'Ada',
      count: 3,
    })).toBe('Hi, Ada! You have 3 messages.');
  });
  it('renders missing values as empty string and never throws', () => {
    expect(render('Hi {{name}}{{missing}}', { name: 'Ada' })).toBe('Hi Ada');
  });
  it('does not recurse into injected values (no template injection)', () => {
    expect(render('{{x}}', { x: '{{y}}' })).toBe('{{y}}');
  });
});
