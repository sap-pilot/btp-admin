import type { EvaluationMode } from '../../types/index.js';

const evaluationModes = new Map<string, EvaluationMode>();
const intervalOverrides = new Map<string, number>();

export function getEvaluationMode(name: string): EvaluationMode {
  return evaluationModes.get(name) ?? 'condition';
}

export function setEvaluationMode(name: string, mode: EvaluationMode): void {
  if (mode === 'condition') evaluationModes.delete(name);
  else evaluationModes.set(name, mode);
}

export function getIntervalOverride(name: string): number | null {
  return intervalOverrides.has(name) ? (intervalOverrides.get(name) ?? null) : null;
}

export function setIntervalOverride(name: string, intervalSeconds: number): void {
  intervalOverrides.set(name, intervalSeconds);
}
