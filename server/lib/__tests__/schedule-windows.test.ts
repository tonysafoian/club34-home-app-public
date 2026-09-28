import { describe, expect, it } from 'vitest';
import {
  THEATER_SCHEDULE,
  isWithinScheduleStartGrace,
} from '../../../shared/scheduleWindows';

describe('Theater schedule startup grace', () => {
  it('is active at the 10:00 AM schedule transition', () => {
    expect(
      isWithinScheduleStartGrace(THEATER_SCHEDULE, 30, new Date('2026-08-26T17:00:00Z')),
    ).toBe(true);
  });

  it('is active through 10:29 AM', () => {
    expect(
      isWithinScheduleStartGrace(THEATER_SCHEDULE, 30, new Date('2026-08-26T17:29:59Z')),
    ).toBe(true);
  });

  it('ends at 10:30 AM', () => {
    expect(
      isWithinScheduleStartGrace(THEATER_SCHEDULE, 30, new Date('2026-08-26T17:30:00Z')),
    ).toBe(false);
  });

  it('does not suppress alerts later in the active window', () => {
    expect(
      isWithinScheduleStartGrace(THEATER_SCHEDULE, 30, new Date('2026-08-26T21:00:00Z')),
    ).toBe(false);
  });
});