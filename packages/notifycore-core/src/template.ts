/**
 * Minimal, safe template rendering: `{{ placeholder }}` tokens are replaced with values from a data
 * object. No logic, no loops, no nested evaluation — interpolation only. This is deliberate: a
 * notification template is operator/content config, and a Turing-complete template language would be
 * an injection and complexity liability. Missing variables are surfaced explicitly (see
 * `missingPlaceholders`) so a bad payload is rejected at enqueue time instead of rendering blanks.
 */

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

export type TemplateData = Record<string, unknown>;

/** Distinct placeholder names referenced by a template, in first-seen order. */
export function placeholders(template: string): string[] {
  const seen = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name) seen.add(name);
  }
  return [...seen];
}

/** Placeholder names a template needs but the data does not supply (null/undefined count as missing). */
export function missingPlaceholders(template: string, data: TemplateData): string[] {
  return placeholders(template).filter((name) => {
    const value = data[name];
    return value === undefined || value === null;
  });
}

/**
 * Render a template against data. Every `{{name}}` is replaced with `String(data[name])`; a token
 * whose value is missing renders as the empty string (callers should validate with
 * `missingPlaceholders` first if they want to reject incomplete data). Total — never throws.
 */
export function render(template: string, data: TemplateData): string {
  return template.replace(PLACEHOLDER, (_full, name: string) => {
    const value = data[name];
    return value === undefined || value === null ? '' : String(value);
  });
}
