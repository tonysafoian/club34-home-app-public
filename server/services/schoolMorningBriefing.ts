export type SchoolBriefingSlot = "650am" | "730am";

const WAKE_UP = "Good morning! It is time to get up and get ready for the day.";
const DEPARTURE =
  "Good morning, everyone. It is time to head downstairs. We're leaving in five minutes or less. Please bring everything you need.";
const MAX_HEADLINE_WORDS = 11;
const MAX_MARKET_WORDS = 20;
const ENCOURAGEMENTS = [
  "You've got this. Let's make it a great day.",
  "Start steady, be kind, and make today count.",
  "Take a deep breath and start the day strong.",
  "A fresh day is waiting. Let's get moving.",
  "Bring your best energy and have a good day.",
] as const;

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function capWords(text: string, maximum: number): string {
  const tokens = words(text);
  if (tokens.length <= maximum) return text.trim();
  return `${tokens.slice(0, maximum).join(" ").replace(/[,:;.!?]+$/, "")}.`;
}

function normalizeSentence(text: string): string {
  const cleaned = text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\([^)]*https?:\/\/[^)]*\)/g, "")
    .replace(/[*_#`~]/g, "")
    .replace(/^\s*(?:[-•–—]|\d+[.)])\s*/, "")
    .replace(/^\s*(?:headline|story|market update|markets?)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function encouragementForDate(dateKey?: string): string {
  const resolvedDate = dateKey && /^\d{4}-\d{2}-\d{2}$/.test(dateKey)
    ? dateKey
    : new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
  const [year, month, day] = resolvedDate.split("-").map(Number);
  const dayNumber = Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
  return ENCOURAGEMENTS[((dayNumber % ENCOURAGEMENTS.length) + ENCOURAGEMENTS.length) % ENCOURAGEMENTS.length];
}

export function cleanGlobalHeadlines(raw: string): string[] {
  const candidates = raw
    .replace(/\r/g, "")
    .split(/\n+|(?<=\.)\s+(?=\d+[.)]\s)/)
    .map(normalizeSentence)
    .filter(
      (line) =>
        line.length > 5 &&
        !/^(?:sources?|top stories|global news|headlines)(?:\s*:)?\.?$/i.test(line),
    );

  return candidates.slice(0, 3).map((line) => capWords(line, MAX_HEADLINE_WORDS));
}

export function cleanMarketUpdate(raw: string): string {
  const first = raw
    .replace(/\r/g, "")
    .split(/\n+/)
    .map(normalizeSentence)
    .find(
      (line) =>
        line.length > 5 &&
        !/^(?:sources?|market update|markets?)(?:\s*:)?\.?$/i.test(line),
    );
  return first ? capWords(first, MAX_MARKET_WORDS) : "";
}

export function composeSchoolMorningAnnouncement(input: {
  slot: SchoolBriefingSlot;
  dateKey?: string;
  weatherClause?: string;
  headlines?: string[];
  marketUpdate?: string;
}): string {
  if (input.slot === "650am") {
    const parts = [WAKE_UP, encouragementForDate(input.dateKey)];
    if (input.weatherClause?.trim()) parts.push(normalizeSentence(input.weatherClause));
    parts.push("Please check your morning email and be downstairs by 7:30.");
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  return DEPARTURE;
}

export function countBriefingWords(...scripts: string[]): number {
  return words(scripts.join(" ")).length;
}