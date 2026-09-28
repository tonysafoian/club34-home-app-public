import { describe, expect, it } from 'vitest';
import {
  validateCompleteDailyEnergyStatistics,
  type StatisticsPoint,
} from '../haStatistics.js';

function point(change: number, start = '2026-09-01T07:00:00.000Z'): StatisticsPoint {
  return {
    start,
    end: '2026-09-02T07:00:00.000Z',
    state: change,
    sum: change,
    change,
  };
}

describe('validateCompleteDailyEnergyStatistics', () => {
  const required = ['sensor.main', 'sensor.leaf'];

  it('accepts a complete day including a real zero statistic', () => {
    const result = validateCompleteDailyEnergyStatistics({
      'sensor.main': [point(12.5)],
      'sensor.leaf': [point(0)],
    }, '2026-09-01', required);

    expect(result.complete).toBe(true);
    expect(result.missingEntityIds).toEqual([]);
    expect(result.invalidEntityIds).toEqual([]);
    expect(Object.fromEntries(result.values)).toEqual({
      'sensor.main': 12.5,
      'sensor.leaf': 0,
    });
  });

  it('excludes a day when a canonical statistic is absent', () => {
    const result = validateCompleteDailyEnergyStatistics({
      'sensor.main': [point(12.5)],
    }, '2026-09-01', required);

    expect(result.complete).toBe(false);
    expect(result.missingEntityIds).toEqual(['sensor.leaf']);
  });

  it('does not treat a point from a different LA date as complete', () => {
    const result = validateCompleteDailyEnergyStatistics({
      'sensor.main': [point(12.5)],
      'sensor.leaf': [point(2, '2026-09-02T07:00:00.000Z')],
    }, '2026-09-01', required);

    expect(result.complete).toBe(false);
    expect(result.missingEntityIds).toEqual(['sensor.leaf']);
  });

  it('rejects negative or non-finite changes instead of coercing them to zero', () => {
    const invalid = point(-1);
    const result = validateCompleteDailyEnergyStatistics({
      'sensor.main': [point(12.5)],
      'sensor.leaf': [invalid],
    }, '2026-09-01', required);

    expect(result.complete).toBe(false);
    expect(result.invalidEntityIds).toEqual(['sensor.leaf']);
    expect(result.values.has('sensor.leaf')).toBe(false);
  });

  it.each([
    ['null', null],
    ['empty string', ''],
    ['numeric string', '0'],
    ['boolean', false],
    ['undefined', undefined],
  ])('rejects a malformed %s change instead of coercing it to zero', (_label, change) => {
    const malformed = { ...point(0), change } as unknown as StatisticsPoint;
    const result = validateCompleteDailyEnergyStatistics({
      'sensor.main': [point(12.5)],
      'sensor.leaf': [malformed],
    }, '2026-09-01', required);

    expect(result.complete).toBe(false);
    expect(result.invalidEntityIds).toEqual(['sensor.leaf']);
    expect(result.values.has('sensor.leaf')).toBe(false);
  });
});