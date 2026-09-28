import {
  cleanGlobalHeadlines,
  cleanMarketUpdate,
  composeSchoolMorningAnnouncement,
  countBriefingWords,
} from "../services/schoolMorningBriefing.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const rawNews = [
  "## Top stories",
  "1. **Global leaders agree emergency ceasefire talks** [1]",
  "2. Pacific nations coordinate after a powerful offshore earthquake. https://example.com",
  "3. International health officials expand a cross-border vaccination campaign. [3]",
  "4. This fourth story must never be spoken.",
].join("\n");

const headlines = cleanGlobalHeadlines(rawNews);
assert(headlines.length === 3, `expected exactly three headlines, got ${headlines.length}`);
assert(headlines[0].includes("ceasefire"), "news heading displaced a real story");
assert(!headlines.join(" ").match(/https?:\/\/|\[\d+\]|[*#]/), "news retained formatting or citations");
assert(!headlines.join(" ").includes("fourth"), "news retained more than three stories");

const market = cleanMarketUpdate(
  "## Market Update\nS&P 500, Dow, and Nasdaq futures rise as cooling inflation supports sentiment. [Reuters]\nSources: https://example.com",
);
assert(market.length > 0, "market update was removed");
assert(!market.match(/https?:\/\/|\[\d+\]|[*#]/), "market retained formatting or citations");
assert(!/\b(buy|sell|recommend)\b/i.test(market), "market output contains advice");

const early = composeSchoolMorningAnnouncement({
  slot: "650am",
  dateKey: "2026-09-08",
  weatherClause: "it's 58 and cloudy out — grab a sweater.",
});
const late = composeSchoolMorningAnnouncement({ slot: "730am" });
assert(early.startsWith("Good morning, Emme and Isla."), "6:50 is not personalized");
assert(early.includes("58") && early.includes("sweater"), "6:50 lacks weather/clothing guidance");
assert(early.includes("be downstairs by 7:30"), "6:50 lacks the practical deadline");
assert(!early.includes("world stories") && !late.includes("Markets"), "wake-up still includes non-actionable briefing content");
assert(
  late.includes("leaving in five minutes or less") && late.endsWith("everything you need for school."),
  "7:30 does not end with departure instruction",
);
const totalWords = countBriefingWords(early, late);
assert(totalWords >= 45 && totalWords <= 75, `combined scripts exceed duration budget: ${totalWords} words`);

const noWeather = composeSchoolMorningAnnouncement({
  slot: "650am",
  dateKey: "2026-09-08",
});
assert(
  noWeather.includes("time to get up") && noWeather.includes("be downstairs by 7:30"),
  "weather failure suppressed wake-up essentials",
);
const totalLateFailure = composeSchoolMorningAnnouncement({ slot: "730am" });
assert(totalLateFailure.includes("come downstairs"), "7:30 departure instruction is missing");

const consecutiveGreetings = ["2026-09-08", "2026-09-09", "2026-09-10"].map((dateKey) =>
  composeSchoolMorningAnnouncement({ slot: "650am", dateKey }),
);
assert(
  new Set(consecutiveGreetings).size === consecutiveGreetings.length,
  "encouragement does not rotate across school days",
);

assert(/[.!?]$/.test(early) && /[.!?]$/.test(late), "announcement can end mid-sentence");

console.log(`[PASS] school morning briefing composition (${totalWords} combined words)`);