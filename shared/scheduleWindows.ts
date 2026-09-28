export interface ScheduleWindow {
  startHour: number;
  endHour: number;
  label: string;
  timezone: string;
}

export const GYM_SCHEDULE: ScheduleWindow = {
  startHour: 6,
  endHour: 15,
  label: '6 AM–3 PM',
  timezone: 'America/Los_Angeles',
};

export const THEATER_SCHEDULE: ScheduleWindow = {
  startHour: 10,
  endHour: 23,
  label: '10 AM–11 PM',
  timezone: 'America/Los_Angeles',
};

export const GYM_HEAT_TEMP = 64;
export const GYM_COOL_TEMP = 67;
export const THEATER_HEAT_TEMP = 66;
export const THEATER_COOL_TEMP = 72;

export function getHourInTimezone(date: Date, timezone: string): number {
  return new Date(date.toLocaleString('en-US', { timeZone: timezone })).getHours();
}

export function isWithinSchedule(window: ScheduleWindow, now: Date = new Date()): boolean {
  const hour = getHourInTimezone(now, window.timezone);
  return hour >= window.startHour && hour < window.endHour;
}

export function isWithinScheduleStartGrace(
  window: ScheduleWindow,
  graceMinutes: number,
  now: Date = new Date(),
): boolean {
  const local = new Date(now.toLocaleString('en-US', { timeZone: window.timezone }));
  const currentMinute = local.getHours() * 60 + local.getMinutes();
  const startMinute = window.startHour * 60;
  return currentMinute >= startMinute && currentMinute < startMinute + graceMinutes;
}
