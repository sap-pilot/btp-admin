import type { ConditionResult } from '../../types/index.js';

interface EvalContext {
  status: number;
  responseTime: number;
  body: string;
  headers: Record<string, string>;
}

export function evaluateCondition(condition: string, ctx: EvalContext): ConditionResult {
  const trimmed = condition.trim();

  // Supports: [STATUS], [RESPONSE_TIME], [BODY], [BODY].path, [HEADER.name], len([BODY].path)
  const fullMatch = trimmed.match(
    /^(len\()?(\[(?:STATUS|RESPONSE_TIME|BODY(?:[\w.\[\]]*)?|HEADER\.[^\]]+)\])\)?\s*(==|!=|<=|>=|<|>)\s*(.+)$/,
  );

  if (!fullMatch) {
    return { condition, passed: false, actual: 'parse-error', expected: '' };
  }

  const [, hasLen, varRef, operator, rhsRaw] = fullMatch;

  let actual: string | number = resolveVar(varRef, ctx);

  if (hasLen) {
    actual = applyLen(actual);
  }

  const rhs = parseRHS(rhsRaw.trim());
  const passed = compare(actual, operator, rhs);

  return {
    condition,
    passed,
    actual: String(actual),
    expected: `${operator} ${rhsRaw.trim()}`,
  };
}

function resolveVar(varRef: string, ctx: EvalContext): string | number {
  if (varRef === '[STATUS]') return ctx.status;
  if (varRef === '[RESPONSE_TIME]') return ctx.responseTime;
  if (varRef === '[BODY]') return ctx.body;
  if (varRef.startsWith('[BODY]')) {
    const path = varRef.slice(6);
    return resolveJsonPath(ctx.body, path);
  }
  if (varRef.startsWith('[HEADER.')) {
    const name = varRef.slice(8, -1).toLowerCase();
    return ctx.headers[name] ?? '';
  }
  return '';
}

function resolveJsonPath(body: string, path: string): string {
  try {
    let obj: unknown = JSON.parse(body);
    const parts = path.match(/\.(\w+)|\[(\d+)\]/g) ?? [];
    for (const part of parts) {
      if (obj == null || typeof obj !== 'object') return '';
      if (part.startsWith('[')) {
        const idx = parseInt(part.slice(1, -1), 10);
        obj = (obj as unknown[])[idx];
      } else {
        obj = (obj as Record<string, unknown>)[part.slice(1)];
      }
    }
    if (obj === null || obj === undefined) return '';
    return typeof obj === 'object' ? JSON.stringify(obj) : String(obj);
  } catch {
    return '';
  }
}

function applyLen(value: string | number): number {
  if (typeof value === 'number') return value;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.length;
    if (typeof parsed === 'object' && parsed !== null) return Object.keys(parsed).length;
  } catch {
    // fall through to string length
  }
  return value.length;
}

type PatternRHS = { type: 'pattern'; re: RegExp };
type RHSValue = string | number | PatternRHS;

function parseRHS(rhs: string): RHSValue {
  const patMatch = rhs.match(/^pat\((.+)\)$/);
  if (patMatch) {
    const inner = patMatch[1];
    const reStr = inner
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return { type: 'pattern', re: new RegExp(reStr, 'i') };
  }
  if (
    (rhs.startsWith('"') && rhs.endsWith('"')) ||
    (rhs.startsWith("'") && rhs.endsWith("'"))
  ) {
    return rhs.slice(1, -1);
  }
  const n = Number(rhs);
  if (!isNaN(n) && rhs !== '') return n;
  return rhs;
}

function compare(actual: string | number, op: string, expected: RHSValue): boolean {
  if (typeof expected === 'object' && expected.type === 'pattern') {
    return expected.re.test(String(actual));
  }
  if (typeof actual === 'number' && typeof expected === 'number') {
    switch (op) {
      case '==': return actual === expected;
      case '!=': return actual !== expected;
      case '<':  return actual < expected;
      case '>':  return actual > expected;
      case '<=': return actual <= expected;
      case '>=': return actual >= expected;
    }
  }
  const a = String(actual);
  const e = String(expected);
  switch (op) {
    case '==': return a === e;
    case '!=': return a !== e;
    case '<':  return a < e;
    case '>':  return a > e;
    case '<=': return a <= e;
    case '>=': return a >= e;
  }
  return false;
}
