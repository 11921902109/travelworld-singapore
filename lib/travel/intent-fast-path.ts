import {
  parseSingaporeIntentResult,
  type SingaporeIntentRequest,
  type SingaporeIntentResult,
} from "./singapore-intent";

type LiteralPatch = {
  field: string;
  op: "set" | "clear";
  value?: string | number;
  evidenceText: string;
  certainty: "explicit";
};

// Deliberately narrow: a match must cover the entire message. Partial extraction
// from a longer sentence could hide a correction, negation, or hotel nickname.
const fullDate = String.raw`(20\d{2})\s*(?:年|[/.\-])\s*(\d{1,2})\s*(?:月|[/.\-])\s*(\d{1,2})\s*(?:日|号)?`;
const dateRange = new RegExp(
  String.raw`^(?:(?:把|将)?(?:出行|旅行|行程)?日期(?:改成|改为|调整为|设为|是)\s*)?(${fullDate})\s*(?:至|到|[-–—~～])\s*(${fullDate})$`,
);

const areaNames: Record<string, string> = {
  bugis: "Bugis",
  orchard: "Orchard",
  chinatown: "Chinatown",
  "little india": "Little India",
  "kampong glam": "Kampong Glam",
  "marina bay": "Marina Bay",
  sentosa: "Sentosa",
  牛车水: "Chinatown",
  武吉士: "Bugis",
  乌节路: "Orchard",
};

export type IntentPreparseCandidate = {
  kind: "date" | "time" | "traveler_count";
  value: string | number;
  evidenceText: string;
  startIndex: number;
  endIndex: number;
};

export type IntentPreparseRisk = {
  kind: "negation" | "contrast" | "pronoun" | "hotel_nickname" | "multiple_dates" | "alternative";
  evidenceText: string;
  startIndex: number;
  endIndex: number;
};

export type IntentPreparseResult = {
  originalText: string;
  candidates: IntentPreparseCandidate[];
  risks: IntentPreparseRisk[];
};

function literalDate(year: string, month: string, day: string): string | null {
  const value = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? value : null;
}

function literalTime(hour: string, minute: string): string | null {
  const number = Number(hour);
  return number >= 0 && number <= 23
    ? `${hour.padStart(2, "0")}:${minute}` : null;
}

function patch(field: string, value: string | number, evidenceText: string): LiteralPatch {
  return { field, op: "set", value, evidenceText, certainty: "explicit" };
}

function clearPatch(field: string, evidenceText: string): LiteralPatch {
  return { field, op: "clear", evidenceText, certainty: "explicit" };
}

/** Literal hints for Bailian. A candidate is never an accepted intent patch. */
export function preparseIntentInput(message: string): IntentPreparseResult {
  const candidates: IntentPreparseCandidate[] = [];
  const risks: IntentPreparseRisk[] = [];
  const addCandidate = (kind: IntentPreparseCandidate["kind"], value: string | number, evidenceText: string, startIndex: number) => {
    if (candidates.length < 24 && !candidates.some((item) => item.kind === kind && item.startIndex < startIndex + evidenceText.length && item.endIndex > startIndex)) {
      candidates.push({ kind, value, evidenceText, startIndex, endIndex: startIndex + evidenceText.length });
    }
  };
  const addRisk = (kind: IntentPreparseRisk["kind"], evidenceText: string, startIndex: number) => {
    if (risks.length < 16) risks.push({ kind, evidenceText, startIndex, endIndex: startIndex + evidenceText.length });
  };

  for (const match of message.matchAll(new RegExp(fullDate, "g"))) {
    const date = literalDate(match[1], match[2], match[3]);
    if (date) addCandidate("date", date, match[0], match.index);
  }
  for (const match of message.matchAll(/(?:[01]?\d|2[0-3])[:：][0-5]\d/g)) {
    const [hour, minute] = match[0].split(/[:：]/);
    const time = literalTime(hour, minute);
    if (time) addCandidate("time", time, match[0], match.index);
  }
  for (const match of message.matchAll(/我一个人|(?<!\d)(\d{1,2})\s*(?:位成人|个?人)/g)) {
    const count = match[1] ? Number(match[1]) : 1;
    if (count >= 1 && count <= 20) addCandidate("traveler_count", count, match[0], match.index);
  }
  const chineseCounts: Record<string, number> = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  };
  for (const match of message.matchAll(/([一二两三四五六七八九十])\s*(?:位成人|个?人)/g)) {
    addCandidate("traveler_count", chineseCounts[match[1]], match[0], match.index);
  }

  const riskPatterns: Array<[IntentPreparseRisk["kind"], RegExp]> = [
    ["negation", /不要|不想|不去|不住|不是|取消|避开|排除|不推荐/g],
    ["contrast", /但是|不过|但|而是|改成|改为|改住|重新|其实/g],
    ["pronoun", /那个|这个|那家|这家|那里|它|他|她/g],
    ["hotel_nickname", /(?:头上|头顶|顶着|顶个).{0,12}(?:船|游轮).{0,10}(?:酒店)?|(?:像船|船形).{0,10}酒店/g],
    ["alternative", /或者|或是|要么|也可以/g],
  ];
  for (const [kind, pattern] of riskPatterns) {
    for (const match of message.matchAll(pattern)) addRisk(kind, match[0], match.index);
  }
  const dates = candidates.filter((item) => item.kind === "date");
  if (dates.length > 2) addRisk("multiple_dates", dates[2].evidenceText, dates[2].startIndex);

  candidates.sort((a, b) => a.startIndex - b.startIndex);
  risks.sort((a, b) => a.startIndex - b.startIndex);
  return { originalText: message, candidates, risks };
}

/**
 * Handles only standalone, unambiguous single-slot utterances. Complex language
 * returns null and stays on the visit's existing Bailian Agent Session.
 */
export function tryResolveDeterministicIntentTurn(
  input: SingaporeIntentRequest,
  currentDate: string,
): SingaporeIntentResult | null {
  if (input.currentOutline.length) return null;
  const message = input.message.trim().replace(/[。！!]\s*$/, "").trim();
  if (!message) return null;
  let patches: LiteralPatch[] | null = null;

  const dates = message.match(dateRange);
  if (dates) {
    const start = literalDate(dates[2], dates[3], dates[4]);
    const end = literalDate(dates[6], dates[7], dates[8]);
    if (!start || !end) return null;
    patches = [patch("startDate", start, dates[1]), patch("endDate", end, dates[5])];
  }

  if (!patches) {
    const start = message.match(/^(?:每天|每日)\s*(\d{1,2}):([0-5]\d)\s*(?:出发|从酒店出发)$/);
    if (start) {
      const time = literalTime(start[1], start[2]);
      if (!time) return null;
      patches = [patch("dailyStartTime", time, message)];
    }
  }

  if (!patches) {
    const returned = message.match(/^(?:每天|每日)\s*(\d{1,2}):([0-5]\d)\s*(?:回酒店|返回酒店|返店)$/);
    if (returned) {
      const time = literalTime(returned[1], returned[2]);
      if (!time) return null;
      patches = [
        patch("preferredReturnTime", time, message),
        patch("latestReturnTime", time, message),
      ];
    }
  }

  if (!patches) {
    if (/^我一个人$/.test(message)) {
      patches = [patch("travelers.total", 1, message)];
    } else {
      const travelers = message.match(/^(?:这次|同行|一共)?\s*(\d{1,2})\s*(?:个?人|位成人)$/);
      if (travelers) {
        const count = Number(travelers[1]);
        if (count < 1 || count > 20) return null;
        patches = [patch("travelers.total", count, message)];
        if (/位成人$/.test(message)) patches.push(patch("travelers.adults", count, message));
      }
    }
  }

  if (!patches) {
    const area = message.match(/^(?:我想)?住(?:在)?\s*(Bugis|Orchard|Chinatown|Little India|Kampong Glam|Marina Bay|Sentosa|牛车水|武吉士|乌节路)\s*(?:附近|一带|区域)?$/i);
    if (area) patches = [patch("accommodation.areaName", areaNames[area[1].toLowerCase()], message)];
  }

  if (!patches) {
    const pace = message.match(/^(?:旅行)?节奏\s*(轻松|平衡|紧凑)$/);
    if (pace) {
      const paceValues: Record<string, string> = { 轻松: "relaxed", 平衡: "balanced", 紧凑: "intensive" };
      patches = [patch("pace", paceValues[pace[1]], message)];
    }
  }

  if (!patches) {
    if (message === "清除每日出发时间") {
      patches = [clearPatch("dailyStartTime", message)];
    } else if (message === "清除每日返店时间") {
      patches = [
        clearPatch("preferredReturnTime", message),
        clearPatch("latestReturnTime", message),
      ];
    } else if (message === "清除旅行节奏") {
      patches = [clearPatch("pace", message)];
    }
  }

  if (!patches) return null;
  return parseSingaporeIntentResult(JSON.stringify({
    purpose: "update_intent",
    patches,
    unresolvedMentions: [],
    acknowledgement: "已记录这项明确的旅行条件。",
  }), input, currentDate);
}
