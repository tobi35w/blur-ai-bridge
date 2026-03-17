import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import {
    buildBridgeJudgeSystemPrompt,
    buildBridgeJudgeUserPrompt,
    buildModelResponsePrompt,
    buildWeakSpotPrompt
} from "./prompts/judgingPrompts.js";
import { buildSessionConstraintsPrompt } from "./prompts/sessionControlPrompts.js";
import {
    applyDeterministicJudgeRules,
    applyJudgeConsistencyClamps,
    clampNum,
    tierFromScore,
    xpFromTier
} from "./prompts/judgeRules.mjs";
import { buildCharacterPrompt } from "./buildCharacterPrompt.js";
import { safeParseModelJson } from "./lib/modelParsing.js";
import { lastUserText, moderateMessage } from "./lib/moderation.js";
import { createSupabaseBridgeClient } from "./lib/supabase.js";
import { normalizeTranscript, toGroqMessages } from "./lib/transcript.js";
import { registerJudgeRoute } from "./routes/judgeRoute.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, ".env") });

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8787;
const DEFAULT_GROQ_BASE_URL = process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";
const DEFAULT_GROQ_CHAT_MODEL = process.env.GROQ_MODEL_CHAT || "llama-3.3-70b-versatile";
const DEFAULT_GROQ_JUDGE_MODEL = process.env.GROQ_MODEL_JUDGE || "llama-3.3-70b-versatile";
const JUDGE_RULES_ENABLED = String(process.env.JUDGE_RULES_ENABLED ?? "true").toLowerCase() !== "false";
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DEFAULT_CHAT_OPTIONS = {
  num_predict: 220,
  temperature: 0.7,
  top_p: 0.9
};
const END_TOKEN = "<END_SIMULATION/>";
const {
  hasSupabaseConfig,
  hasSupabaseAdminConfig,
  supabaseRest,
  supabaseAdminRest,
  getUserIdFromRequest,
} = createSupabaseBridgeClient({
  supabaseUrl: SUPABASE_URL,
  supabaseAnonKey: SUPABASE_ANON_KEY,
  supabaseServiceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
});

function getGroqKey() {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("Missing GROQ_API_KEY");
  return key;
}

function mergedOptions(options) {
  return { ...DEFAULT_CHAT_OPTIONS, ...(options || {}) };
}

function scoreJudgeLine(text = "") {
  const t = String(text ?? "");
  const lower = t.toLowerCase();
  let score = 0;
  if (/[!?]{2,}/.test(t)) score += 2;
  if (/(hate|stupid|idiot|shut up|mad|angry|annoyed)/i.test(lower)) score += 4;
  if (/(sorry|please|thank|calm|understand)/i.test(lower)) score += 2;
  if (t.length > 140) score += 1;
  return score;
}

function compactJudgeMessages(messages = [], opts = {}) {
  const maxItems = Number(opts.maxItems ?? opts.maxMessages ?? 18);
  const maxChars = Number(opts.maxChars ?? 260);
  const firstCount = Number(opts.firstCount ?? 2);
  const lastCount = Number(opts.lastCount ?? 4);
  const topUserCount = Number(opts.topUserCount ?? 6);
  const pairCount = Number(opts.pairCount ?? 6);

  const clean = normalizeTranscript(messages)
    .map((m, i) => ({
      i: Number.isInteger(m.idx) ? m.idx : i,
      role: m.role === "assistant" || m.role === "ai" ? "assistant" : "user",
      text: String(m.content ?? m.text ?? "").trim()
    }))
    .filter((m) => m.text.length > 0);

  if (clean.length <= maxItems) {
    return clean.map((m) => ({
      i: m.i,
      role: m.role,
      text: m.text.slice(0, maxChars)
    }));
  }

  const first = clean.slice(0, firstCount);
  const last = clean.slice(-lastCount);

  const topUserSignals = clean
    .filter((m) => m.role === "user")
    .map((m) => ({ ...m, s: scoreJudgeLine(m.text) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, topUserCount);

  const assistantPairs = [];
  for (let k = 0; k < clean.length - 1; k += 1) {
    const a = clean[k];
    const b = clean[k + 1];
    if (a.role !== "assistant" || b.role !== "user") continue;
    const qScore =
      (/\?/.test(a.text) ? 2 : 0) +
      scoreJudgeLine(a.text) +
      scoreJudgeLine(b.text);
    assistantPairs.push({ a, b, qScore });
  }

  const selectedPairs = assistantPairs
    .sort((x, y) => y.qScore - x.qScore)
    .slice(0, pairCount)
    .flatMap((p) => [p.a, p.b]);

  const merged = [...first, ...topUserSignals, ...selectedPairs, ...last];
  const seen = new Set();
  const deduped = [];
  for (const m of merged) {
    if (!m || seen.has(m.i)) continue;
    seen.add(m.i);
    deduped.push(m);
  }

  deduped.sort((a, b) => a.i - b.i);

  return deduped.slice(0, maxItems).map((m) => ({
    i: m.i,
    role: m.role,
    text: m.text.slice(0, maxChars)
  }));
}

function buildJudgeCompactionProfile(totalMessages = 0, reducedPayload = false) {
  let profile = {
    maxItems: 11,
    maxChars: 190,
    firstCount: 1,
    lastCount: 3,
    topUserCount: 5,
    pairCount: 4
  };

  if (totalMessages >= 16) {
    profile = {
      maxItems: 10,
      maxChars: 175,
      firstCount: 1,
      lastCount: 3,
      topUserCount: 4,
      pairCount: 3
    };
  }
  if (totalMessages >= 26) {
    profile = {
      maxItems: 9,
      maxChars: 160,
      firstCount: 1,
      lastCount: 2,
      topUserCount: 4,
      pairCount: 3
    };
  }

  if (!reducedPayload) return profile;
  return {
    maxItems: Math.max(6, profile.maxItems - 2),
    maxChars: Math.max(130, profile.maxChars - 30),
    firstCount: 1,
    lastCount: Math.max(2, profile.lastCount - 1),
    topUserCount: Math.max(2, profile.topUserCount - 2),
    pairCount: Math.max(2, profile.pairCount - 1)
  };
}

function computeJudgeNumPredict(totalMessages = 0, reducedPayload = false) {
  let budget = 420;
  if (totalMessages >= 10) budget = 520;
  if (totalMessages >= 18) budget = 620;
  if (totalMessages >= 30) budget = 760;
  if (reducedPayload) budget = Math.min(900, budget + 120);
  return budget;
}

async function groqChatCompletions({
  model,
  messages,
  options,
  stream = false,
  signal,
  responseFormat
}) {
  const baseUrl = DEFAULT_GROQ_BASE_URL;
  const apiKey = getGroqKey();
  const merged = mergedOptions(options);

  const body = {
    model,
    messages,
    temperature: merged.temperature ?? 0.7,
    top_p: merged.top_p ?? 0.9,
    max_tokens: merged.num_predict ?? 220,
    stream
  };
  if (responseFormat && !stream) {
    body.response_format = responseFormat;
  }

  return fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal
  });
}

function toReasonText(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const label = typeof value.label === "string" ? value.label.trim() : "";
  const why = typeof value.why === "string" ? value.why.trim() : "";
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (label && why) return `${label}: ${why}`;
  if (why) return why;
  if (text) return text;
  if (label) return label;
  return "";
}

function normalizeJudgeResult(result) {
  const safe = result && typeof result === "object" ? result : {};
  const unsafeFlag = Boolean(safe?.flags?.unsafe);

  // If the model flagged the session as unsafe, we enforce a full fail.
  const normalizedScore = unsafeFlag ? 0 : clampNum(safe?.score ?? 0, 0, 100);
  // Always recompute tier from score — never trust the model's tier value
  const normalizedTier = unsafeFlag ? "F" : tierFromScore(normalizedScore);
  const normalizedXp = unsafeFlag
    ? 0
    : [60, 50, 40, 30, 20, 0].includes(Number(safe?.xp_awarded ?? safe?.xp))
      ? Number(safe?.xp_awarded ?? safe?.xp)
      : xpFromTier(normalizedTier);

  const out = {
    ...safe,
    score: normalizedScore,
    tier: normalizedTier,
    xp: normalizedXp,
    xp_awarded: normalizedXp
  };
  const reasons = Array.isArray(out.reasons)
    ? out.reasons.map((x) => toReasonText(x)).filter(Boolean)
    : [];
  out.reasons = reasons.slice(0, 5);

  const tips = Array.isArray(out.tips)
    ? out.tips.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim())
    : [];
  out.tips = tips.slice(0, 3);

  const summaryCandidate = String(out.summary ?? out.why ?? "").trim();
  if (summaryCandidate) {
    out.summary = summaryCandidate;
  } else if (out.reasons.length) {
    out.summary = out.reasons[0];
  } else {
    out.summary = "Judgement generated.";
  }
  if (!out.reasons.length) {
    out.reasons = [out.summary];
  }
  if (out.reasons.length < 3) {
    const reasonFallbacks = [
      "Your response did not clearly address the scenario's immediate need.",
      "The message gave limited context, so the other person had to guess your intent.",
      "A more specific and structured reply would have improved the interaction."
    ];
    for (const fallback of reasonFallbacks) {
      if (out.reasons.length >= 3) break;
      if (!out.reasons.includes(fallback)) out.reasons.push(fallback);
    }
  }
  if (!out.tips.length) {
    out.tips = [
      "Start with one clear objective, then add one concrete supporting detail.",
      "Use a direct, complete sentence so your intent is easy to act on."
    ];
  } else if (out.tips.length < 2) {
    out.tips.push("Before sending, rewrite once for clarity and specific next action.");
  }

  if (!Array.isArray(out.reason_citations)) {
    out.reason_citations = (out.reasons ?? []).map(() => []);
  } else if (Array.isArray(out.reasons) && out.reason_citations.length !== out.reasons.length) {
    out.reason_citations = (out.reasons ?? []).map(() => []);
  } else {
    out.reason_citations = out.reason_citations.map((arr) => {
      const safeArr = Array.isArray(arr) ? arr : [];
      return safeArr
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 0)
        .slice(0, 3);
    });
  }
  out.flags = {
    unsafe: Boolean(out?.flags?.unsafe),
    rude: Boolean(out?.flags?.rude)
  };
  return out;
}

function buildHeuristicJudge({ messages = [], userProfile, sourceError }) {
  const transcript = normalizeTranscript(messages);
  const userMsgs = transcript.filter((m) => m.role === "user");
  const userName = String(userProfile?.first_name ?? "").trim();
  const userIdx = userMsgs.map((m) => m.idx);
  const shortCount = userMsgs.filter((m) => m.content.split(/\s+/).filter(Boolean).length <= 4).length;
  const avgLen = userMsgs.length
    ? Math.round(userMsgs.reduce((a, m) => a + m.content.length, 0) / userMsgs.length)
    : 0;
  const asksQuestion = userMsgs.some((m) => /\?/.test(m.content));
  const rude = userMsgs.some((m) => /(stupid|idiot|shut up|hate you|dumb|not my problem|who cares|chill out)/i.test(m.content));

  let score = 72;
  if (userMsgs.length <= 1) score -= 22;
  else if (userMsgs.length === 2) score -= 14;
  else if (userMsgs.length >= 6) score += 6;
  if (shortCount >= Math.ceil(Math.max(1, userMsgs.length) * 0.6)) score -= 12;
  if (avgLen >= 35) score += 5;
  if (asksQuestion) score += 4;
  if (rude) score -= 15;
  score = clampNum(score, 40, 92);

  const tier = tierFromScore(score);
  const xp = xpFromTier(tier);

  const reasons = [];
  if (shortCount > 0) {
    reasons.push(
      `${userName || "You"} used very short replies in key moments, which reduced clarity and stalled progress.`
    );
  }
  if (!asksQuestion) {
    reasons.push("You rarely asked clarifying questions, so intent stayed vague and harder to resolve.");
  } else {
    reasons.push("You asked questions, which helped direction, but stronger specificity would improve outcomes.");
  }
  if (avgLen < 24) {
    reasons.push("Your messages often lacked concrete detail, making it harder for the other side to act.");
  } else {
    reasons.push("You stayed engaged, but your framing could be more structured for faster resolution.");
  }

  const tips = [
    "Use a 2-step reply: clear goal first, then one concrete detail.",
    "Ask one focused follow-up question when the situation is ambiguous.",
    "Keep tone calm and direct while avoiding one-word or slang-only replies."
  ];

  const citations = reasons.map((_, i) => {
    if (!userIdx.length) return [];
    const idx = userIdx[Math.min(i, userIdx.length - 1)];
    return Number.isInteger(idx) ? [idx] : [];
  });

  return {
    tier,
    xp,
    xp_awarded: xp,
    score,
    summary: `${userName || "You"} showed effort, but clarity and message structure need improvement for better outcomes.`,
    reasons: reasons.slice(0, 3),
    reason_citations: citations.slice(0, 3),
    tips: tips.slice(0, 3),
    flags: { unsafe: false, rude },
    _fallback: true,
    _error: sourceError ? String(sourceError) : undefined
  };
}

function getJudgeCategories(judgement) {
  const candidates = [
    judgement?.categories,
    judgement?.judge_categories,
    judgement?.category_scores
  ];
  for (const value of candidates) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v !== "number" || Number.isNaN(v)) continue;
      out[k] = Math.round(v);
    }
    if (Object.keys(out).length) return out;
  }
  return null;
}

function clampCategoryValue(value, fallback = 60) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function deriveCategoryScoresFromJudgement(judgement) {
  const score = clampCategoryValue(judgement?.score, 60);
  const rude = Boolean(judgement?.flags?.rude);
  const unsafe = Boolean(judgement?.flags?.unsafe);
  return {
    confidence: clampCategoryValue(score - 6 - (rude ? 10 : 0), score),
    clarity: clampCategoryValue(score - 3, score),
    composure: clampCategoryValue(score + 2 - (rude ? 14 : 0) - (unsafe ? 20 : 0), score),
    social_calibration: clampCategoryValue(score - 4 - (rude ? 8 : 0), score)
  };
}

function getOrBuildJudgeCategories(judgement) {
  return getJudgeCategories(judgement) || deriveCategoryScoresFromJudgement(judgement);
}

function judgeSystemPrompt() {
  return buildBridgeJudgeSystemPrompt();
}

function judgeUserPrompt({ scenario, character, compactMessages, userProfile }) {
  return buildBridgeJudgeUserPrompt({ scenario, character, compactMessages, userProfile });
}

async function callJudgeLLM({ scenario, character, messages, userProfile }) {
  const totalMessages = normalizeTranscript(messages).length;
  const primaryProfile = buildJudgeCompactionProfile(totalMessages, false);
  const retryProfile = buildJudgeCompactionProfile(totalMessages, true);
  const attempts = [
    {
      compaction: primaryProfile,
      options: {
        temperature: 0,
        top_p: 0.9,
        num_predict: computeJudgeNumPredict(totalMessages, false)
      },
      responseFormat: { type: "json_object" }
    },
    {
      compaction: retryProfile,
      options: {
        temperature: 0,
        top_p: 0.9,
        num_predict: computeJudgeNumPredict(totalMessages, true)
      },
      responseFormat: undefined
    }
  ];

  let lastError = null;

  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    const compactMessages = compactJudgeMessages(messages, attempt.compaction);
    const judgeMessages = [
      { role: "system", content: judgeSystemPrompt() },
      {
        role: "user",
        content: judgeUserPrompt({ scenario, character, compactMessages, userProfile })
      }
    ];

    const response = await groqChatCompletions({
      model: DEFAULT_GROQ_JUDGE_MODEL,
      messages: judgeMessages,
      options: attempt.options,
      stream: false,
      responseFormat: attempt.responseFormat
    });

    const text = await response.text().catch(() => "");
    if (!response.ok) {
      const err = new Error(`groq_error:${response.status} ${text}`);
      // Always retry once without response_format on any non-OK response.
      // Some Groq models reject response_format even if JSON is otherwise fine.
      const retriable = i < attempts.length - 1;
      if (retriable) {
        lastError = err;
        continue;
      }
      throw err;
    }

    try {
      const data = JSON.parse(text);
      const out = data?.choices?.[0]?.message?.content ?? "";
      return safeParseModelJson(out);
    } catch (parseErr) {
      const retriable = i < attempts.length - 1;
      if (retriable) {
        lastError = parseErr;
        continue;
      }
      throw parseErr;
    }
  }

  throw lastError || new Error("Judge model failed after retries");
}

function chatSystemPrompt({ scenario, character, difficultyCtx, userProfile }) {
  return buildCharacterPrompt(character, scenario, { ...(difficultyCtx || {}), userProfile });
}

function must(v, msg) {
  if (v === null || v === undefined) throw new Error(msg);
  return v;
}

async function completeOnboardingIfNeeded({ userId, sessionId, scenarioSlug, token }) {
  if (String(scenarioSlug || "") !== "say-something-onboarding") return;
  if (!sessionId) return;

  if (!hasSupabaseAdminConfig()) {
    await supabaseRest({
      path: "/rest/v1/rpc/complete_onboarding",
      method: "POST",
      token,
      body: { p_session_id: sessionId }
    });
    return;
  }

  await supabaseAdminRest({
    path: `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
    method: "PATCH",
    body: {
      onboarding_done: true,
      onboarding_step: 1,
      onboarding_last_session_id: sessionId
    },
    prefer: "return=minimal"
  });
}

function sseWrite(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function avg(nums = []) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function round(n) {
  return Math.round(n);
}

function isoDateOnly(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isoDateOnlyUtc(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 10);
}

function endOfUtcDay(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  return new Date(Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    23, 59, 59, 999
  ));
}

function normalizeTimeZone(value) {
  const tz = typeof value === "string" ? value.trim() : "";
  if (!tz) return "UTC";
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return "UTC";
  }
}

function isoDateOnlyInTimeZone(value = new Date(), timeZone = "UTC") {
  const d = value instanceof Date ? value : new Date(value);
  const tz = normalizeTimeZone(timeZone);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d);
}

function endOfDayInTimeZone(value = new Date(), timeZone = "UTC") {
  const d = value instanceof Date ? value : new Date(value);
  const tz = normalizeTimeZone(timeZone);
  const zoned = new Date(d.toLocaleString("en-US", { timeZone: tz }));
  zoned.setHours(23, 59, 59, 999);
  return zoned;
}

function weekStartIso(value = new Date()) {
  // Local week starting Sunday 00:00:00, matching client-side logic.
  const d = value instanceof Date ? new Date(value) : new Date(value);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return isoDateOnly(d);
}

function legacyWeekStartIso(value = new Date()) {
  // Previous behaviour: ISO week (Monday) in UTC, kept for compatibility with existing rows.
  const d = value instanceof Date ? new Date(value) : new Date(value);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return isoDateOnlyUtc(d);
}

function challengeExpiresAt(periodType, periodStart) {
  const base = new Date(`${periodStart}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return new Date().toISOString();

  if (periodType === "weekly") {
    base.setUTCDate(base.getUTCDate() + 7);
  } else {
    base.setUTCDate(base.getUTCDate() + 1);
  }

  return base.toISOString();
}

function challengeTypeFromCategory(category) {
  const key = String(category ?? "").trim().toLowerCase();
  if (key === "xp") return "xp";
  if (key === "tier") return "tier";
  if (key === "difficulty") return "difficulty";
  if (key === "streak") return "streak";
  if (key === "new_scenario") return "new_scenario";
  if (key === "scenario_variety") return "scenario_variety";
  if (key === "confidence") return "sessions";
  if (key === "clarity") return "difficulty";
  if (key === "composure") return "streak";
  if (key === "social_calibration") return "scenario_variety";
  return "sessions";
}

function challengeXpReward(periodType, difficulty) {
  const diff = String(difficulty ?? "Medium").trim().toLowerCase();

  if (periodType === "weekly") {
    if (diff === "hard") return 120;
    if (diff === "easy") return 80;
    return 100;
  }

  if (diff === "hard") return 50;
  if (diff === "easy") return 30;
  return 40;
}

function stddev(nums = []) {
  if (!Array.isArray(nums) || nums.length < 2) return 0;
  const mean = avg(nums);
  const variance = avg(nums.map((n) => (n - mean) ** 2));
  return Math.sqrt(variance);
}

function suggestFocus(averages = {}) {
  const entries = Object.entries(averages);
  if (!entries.length) return null;

  const [weakestKey, weakestVal] = entries.reduce((min, cur) =>
    cur[1] < min[1] ? cur : min
  );

  const library = {
    confidence:
      "Confidence: Speak early with one clear sentence. No apology opener. Start with your point, then add one example.",
    clarity:
      "Clarity: Use a 2-step structure: (1) claim, (2) quick reason/example. Keep it under 15 seconds.",
    composure:
      "Composure: Slow your pace. One breath before speaking. Keep your tone steady even if unsure.",
    social_calibration:
      "Social calibration: Acknowledge others first (\"Building on that...\") then add your point. Keep eye contact simple."
  };

  return {
    focus_key: weakestKey,
    focus_score: weakestVal,
    suggestion:
      library[weakestKey] ||
      `Focus: Improve "${weakestKey}" by simplifying your response and staying calm.`
  };
}

app.get("/insights/pattern", async (req, res) => {
  try {
    const token = String(req.headers?.authorization ?? "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    const userId = await getUserIdFromRequest(req);
    const parsed = parseInt(String(req.query.limit ?? "5"), 10);
    const limit = Math.min(Number.isFinite(parsed) ? parsed : 5, 20);

    const path =
      `/rest/v1/simulation_history?` +
      `user_id=eq.${encodeURIComponent(userId)}` +
      `&select=${encodeURIComponent("id,created_at,judge_categories,judgement,ai_feedback,tier,scenario_id")}` +
      `&order=created_at.desc` +
      `&limit=${encodeURIComponent(String(limit * 3))}`;

    let rows = null;
    if (hasSupabaseAdminConfig()) {
      try {
        rows = await supabaseAdminRest({ path });
      } catch (adminErr) {
        console.warn("insights/pattern admin query failed, trying user-token fallback:", adminErr?.message ?? adminErr);
        rows = await supabaseRest({ path, token });
      }
    } else {
      rows = await supabaseRest({ path, token });
    }

    const safeRows = Array.isArray(rows) ? rows : [];

    if (!safeRows.length) {
      return res.json({
        has_data: false,
        limit,
        averages: {},
        strongest: null,
        weakest: null,
        focus: null,
        stability_index: null,
        volatility: null,
        volatility_label: null
      });
    }

    const rowsWithCategories = safeRows
      .map((r) => {
        const existing =
          r?.judge_categories && typeof r.judge_categories === "object" && !Array.isArray(r.judge_categories)
            ? r.judge_categories
            : null;
        if (existing) return { ...r, _cats: existing };
        const judged = r?.judgement && typeof r.judgement === "object" ? r.judgement : r?.ai_feedback;
        if (!judged || typeof judged !== "object") return null;
        return { ...r, _cats: getOrBuildJudgeCategories(judged) };
      })
      .filter(Boolean)
      .slice(0, limit);

    if (!rowsWithCategories.length) {
      return res.json({
        has_data: false,
        limit,
        averages: {},
        strongest: null,
        weakest: null,
        focus: null,
        stability_index: null,
        volatility: null,
        volatility_label: null
      });
    }

    const buckets = {};
    const sessionCompositeScores = [];
    for (const r of rowsWithCategories) {
      const cats = r?._cats && typeof r._cats === "object" ? r._cats : {};
      const rowValues = [];

      for (const [k, v] of Object.entries(cats)) {
        if (typeof v !== "number" || Number.isNaN(v)) continue;
        if (!buckets[k]) buckets[k] = [];
        buckets[k].push(v);
        rowValues.push(v);
      }
      if (rowValues.length) sessionCompositeScores.push(avg(rowValues));
    }

    const averages = {};
    for (const [k, arr] of Object.entries(buckets)) {
      averages[k] = round(avg(arr));
    }

    const entries = Object.entries(averages);
    const strongest = entries.length
      ? entries.reduce((max, cur) => (cur[1] > max[1] ? cur : max))
      : null;
    const weakest = entries.length
      ? entries.reduce((min, cur) => (cur[1] < min[1] ? cur : min))
      : null;
    const focus = entries.length ? suggestFocus(averages) : null;
    const volatilityRaw = stddev(sessionCompositeScores);
    const volatility = round(volatilityRaw);
    const stabilityIndex = Math.max(0, Math.min(100, round(100 - volatilityRaw * 2.5)));
    const volatilityLabel =
      sessionCompositeScores.length < 2
        ? "Calibrating"
        : volatilityRaw <= 8
          ? "Low"
          : volatilityRaw <= 15
            ? "Moderate"
            : "High";

    return res.json({
      has_data: true,
      limit,
      sample_count: rowsWithCategories.length,
      averages,
      strongest: strongest ? { key: strongest[0], score: strongest[1] } : null,
      weakest: weakest ? { key: weakest[0], score: weakest[1] } : null,
      focus,
      stability_index: stabilityIndex,
      volatility,
      volatility_label: volatilityLabel,
      sessions: rowsWithCategories.map((r) => ({
        id: r.id,
        created_at: r.created_at,
        tier: r.tier ?? null,
        scenario_id: r.scenario_id
      }))
    });
  } catch (e) {
    return res.status(400).send(e?.message ?? "Unknown error");
  }
});

app.post("/simulation/start", async (req, res) => {
  try {
    const userId = await getUserIdFromRequest(req);
    const body = req.body ?? {};
    const scenarioSlug = String(body?.scenario_slug ?? "").trim();
    const characterSlug = String(body?.character_slug ?? "").trim();
    const isOnboarding = Boolean(body?.is_onboarding);

    if (!scenarioSlug) throw new Error("Missing scenario_slug");
    if (!characterSlug) throw new Error("Missing character_slug");

    const profileRows = await supabaseAdminRest({
      path: `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=${encodeURIComponent("id,onboarding_done,onboarding_step,onboarding_last_session_id")}&limit=1`
    });
    const prof = Array.isArray(profileRows) ? profileRows[0] : null;
    if (!prof) throw new Error("Profile not found");

    let scenarioRows;
    try {
      scenarioRows = await supabaseAdminRest({
        path: `/rest/v1/scenarios?slug=ilike.${encodeURIComponent(scenarioSlug)}&select=${encodeURIComponent("id,slug,title,is_onboarding_only,onboarding_order,user_visible_description,ai_behavior_framing,start_prompt")}&limit=1`
      });
    } catch (e) {
      throw new Error(`Scenario query error: ${e?.message ?? String(e)}`);
    }
    const sc = Array.isArray(scenarioRows) ? scenarioRows[0] : null;
    if (!sc) throw new Error(`Scenario row missing for slug="${scenarioSlug}"`);

    // Temporary debug: verify slug/table visibility for onboarding character.
    const wanted = characterSlug;
    let debugChars;
    try {
      debugChars = await supabaseAdminRest({
        path:
          `/rest/v1/characters?` +
          `select=${encodeURIComponent("id,slug,name,is_onboarding_locked,locked_to_scenario_id,is_active")}` +
          `&slug=ilike.${encodeURIComponent(`*${wanted}*`)}` +
          `&limit=10`
      });
    } catch (e) {
      throw new Error(`Character debug query error: ${e?.message ?? String(e)}`);
    }
    console.log("Wanted character_slug:", wanted);
    console.log("Similar characters in DB:", debugChars);

    let characterRows;
    try {
      characterRows = await supabaseAdminRest({
        path: `/rest/v1/characters?slug=ilike.${encodeURIComponent(characterSlug)}&select=${encodeURIComponent("id,slug,name,description,is_onboarding_locked,locked_to_scenario_id,is_active")}&limit=1`
      });
    } catch (e) {
      throw new Error(`Character query error: ${e?.message ?? String(e)}`);
    }
    const ch = Array.isArray(characterRows) ? characterRows[0] : null;
    if (!ch) throw new Error(`Character row missing for slug="${characterSlug}"`);

    if (!ch.is_active) throw new Error("Character disabled");

    if (sc.is_onboarding_only) {
      if (prof.onboarding_done) {
        throw new Error("Onboarding scenario is locked (already completed).");
      }
      if (!isOnboarding) {
        throw new Error("Onboarding scenario requires onboarding mode.");
      }
    }

    if (ch.is_onboarding_locked) {
      const lockedTo = must(ch.locked_to_scenario_id, "Character lock missing scenario");
      if (String(lockedTo) !== String(sc.id)) {
        throw new Error(
          `Character locked_to_scenario_id mismatch: got ${lockedTo}, expected ${sc.id}`
        );
      }
      if (prof.onboarding_done) {
        throw new Error("Onboarding character is locked (already completed).");
      }
    }

    const difficulty = String(body?.difficulty ?? "medium").trim().toLowerCase() || "medium";
    const constraintsBlock = buildSessionConstraintsPrompt(difficulty);

    const systemContext = [
      sc.ai_behavior_framing ? `SCENARIO_FRAMING:\n${sc.ai_behavior_framing}` : "",
      body?.difficulty ? `DIFFICULTY: ${body.difficulty}` : "",
      body?.hint_level ? `HINT_LEVEL: ${body.hint_level}` : "",
      body?.coach_style ? `COACH_STYLE: ${body.coach_style}` : "",
      constraintsBlock,
      `CHARACTER: ${ch.name}\n${ch.description ?? ""}`.trim()
    ]
      .filter(Boolean)
      .join("\n\n");

    const firstAssistant = isOnboarding
      ? ""
      : must(sc.start_prompt, "Scenario start_prompt missing");
    const initialMessages = [{ role: "system", content: systemContext }];
    if (firstAssistant) {
      initialMessages.push({ role: "assistant", content: firstAssistant });
    }

    const inserted = await supabaseAdminRest({
      path: "/rest/v1/simulation_history",
      method: "POST",
      body: {
        user_id: userId,
        scenario_id: sc.id,
        character_id: ch.id,
        meta: {
          scenario_slug: sc.slug,
          character_slug: ch.slug,
          difficulty: body?.difficulty ?? null,
          hint_level: body?.hint_level ?? null,
          coach_style: body?.coach_style ?? null,
          is_onboarding: !!body?.is_onboarding
        },
        messages: initialMessages
      },
      prefer: "return=representation"
    });
    const sessionRow = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!sessionRow?.id) throw new Error("Failed to create session");

    return res.json({
      session_id: sessionRow.id,
      first_assistant_message: firstAssistant || undefined,
      scenario_id: sc.id,
      character_id: ch.id
    });
  } catch (e) {
    return res.status(400).send(e?.message ?? "Unknown error");
  }
});

registerJudgeRoute(app, {
  callJudgeLLM,
  normalizeJudgeResult,
  applyDeterministicJudgeRules,
  applyJudgeConsistencyClamps,
  judgeRulesEnabled: JUDGE_RULES_ENABLED,
  buildHeuristicJudge
});

app.post("/model-response", async (req, res) => {
  const { scenario, character, conversation, judgeResult } = req.body ?? {};

  if (!scenario || !character || !conversation || !judgeResult) {
    return res.status(400).json({
      error: "Missing required fields: scenario, character, conversation, judgeResult"
    });
  }

  try {
    const systemPrompt = buildModelResponsePrompt(
      scenario,
      character,
      Array.isArray(conversation) ? conversation : [],
      judgeResult
    );

    const response = await groqChatCompletions({
      model: DEFAULT_GROQ_CHAT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Generate the rewrite and ideal exchange now." }
      ],
      options: {
        temperature: 0.7,
        num_predict: 1200
      },
      responseFormat: { type: "json_object" }
    });

    const text = await response.text().catch(() => "");
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      throw new Error(data?.error?.message || data?.error || text || "Model response request failed");
    }

    const raw = data?.choices?.[0]?.message?.content || "";
    const parsed = safeParseModelJson(raw);

    if (!parsed?.rewrite || !Array.isArray(parsed?.ideal_exchange)) {
      throw new Error("Model response missing required fields");
    }

    return res.json({
      rewrite: parsed.rewrite,
      ideal_exchange: parsed.ideal_exchange
    });
  } catch (err) {
    console.error("[/model-response] error:", err?.message ?? String(err));
    return res.status(500).json({
      error: "Failed to generate model response",
      detail: err?.message ?? String(err)
    });
  }
});


app.post("/detect-weak-spots", async (req, res) => {
  const userId = String(req.body?.user_id ?? "").trim();

  if (!userId) {
    return res.status(400).json({ error: "Missing required field: user_id" });
  }

  try {
    if (!hasSupabaseAdminConfig()) {
      throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY in bridge env");
    }

    const historyRows = await supabaseAdminRest({
      path:
        `/rest/v1/simulation_history?` +
        `user_id=eq.${encodeURIComponent(userId)}` +
        `&select=${encodeURIComponent("created_at,ai_score,tier,judge_categories,judgement,ai_feedback,scenario:scenarios(title)")}` +
        `&order=created_at.desc`
    });

    const history = (Array.isArray(historyRows) ? historyRows : []).map((row) => ({
      score:
        Number(row?.ai_score) ||
        Number(row?.judgement?.score) ||
        Number(row?.ai_feedback?.score) ||
        0,
      tier: row?.tier || row?.judgement?.tier || row?.ai_feedback?.tier || null,
      judge_categories:
        row?.judge_categories && typeof row.judge_categories === "object" && !Array.isArray(row.judge_categories)
          ? row.judge_categories
          : null,
      judgement: row?.judgement && typeof row.judgement === "object" ? row.judgement : null,
      feedback_summary:
        typeof row?.ai_feedback?.summary === "string"
          ? row.ai_feedback.summary
          : typeof row?.judgement?.summary === "string"
            ? row.judgement.summary
            : null,
      scenario_title: row?.scenario?.title || "Unknown scenario"
    }));

    if (history.length < 2) {
      return res.json({ weak_spots: [] });
    }

    const systemPrompt = buildWeakSpotPrompt(history);
    const response = await groqChatCompletions({
      model: DEFAULT_GROQ_CHAT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: "Analyse this user's session history and return their weak spots."
        }
      ],
      options: {
        temperature: 0.4,
        num_predict: 800
      },
      responseFormat: { type: "json_object" }
    });

    const text = await response.text().catch(() => "");
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      throw new Error(data?.error?.message || data?.error || text || "Weak spot request failed");
    }

    const raw = data?.choices?.[0]?.message?.content || "";
    const parsed = safeParseModelJson(raw);
    const weakSpots = Array.isArray(parsed?.weak_spots)
      ? parsed.weak_spots.filter(
          (spot) =>
            spot &&
            typeof spot === "object" &&
            typeof spot.tag === "string" &&
            typeof spot.description === "string"
        )
      : null;

    if (!weakSpots) {
      throw new Error("Invalid weak_spots shape from model");
    }

    await supabaseAdminRest({
      path: `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
      method: "PATCH",
      body: { weak_spots: weakSpots },
      prefer: "return=minimal"
    });

    return res.json({ weak_spots: weakSpots });
  } catch (err) {
    console.error("[/detect-weak-spots] error:", err?.message ?? String(err));
    return res.status(500).json({
      error: "Failed to detect weak spots",
      detail: err?.message ?? String(err)
    });
  }
});

app.post("/generate-challenges", async (req, res) => {
  try {
    const token = String(req.headers?.authorization ?? "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    const devUserOverride = process.env.NODE_ENV !== "production"
      ? (process.env.DEV_USER_ID || req.headers["x-dev-user-id"] || req.query?.dev_user_id)
      : null;
    const effectiveToken = token || (devUserOverride ? SUPABASE_SERVICE_ROLE_KEY : "");
    if (!effectiveToken) return res.status(401).json({ ok: false, error: "Missing auth token" });
    const authToken = effectiveToken;

    const userId = devUserOverride
      ? String(devUserOverride).trim()
      : await getUserIdFromRequest(req);
    const now = new Date();
    let tzRows = [];
    try {
      tzRows = await supabaseRest({
        path: `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=timezone&limit=1`,
        token: authToken
      });
    } catch {}
    const tzProfile = Array.isArray(tzRows) ? tzRows[0] : null;
    const userTimeZone = normalizeTimeZone(tzProfile?.timezone);
    const today = isoDateOnlyInTimeZone(now, userTimeZone);
    const todayEnd = endOfDayInTimeZone(now, userTimeZone);
    const weekStart = weekStartIso();
    const legacyWeekStart = legacyWeekStartIso();
    const forceToday = process.env.NODE_ENV !== "production" && (
      String(req.query?.force_today ?? "").toLowerCase() === "1" ||
      String(req.headers["x-dev-force-today"] ?? "").toLowerCase() === "1"
    );

    // ── 1. Skip if active challenges already exist ────────────────────────────
    const existingRows = await supabaseRest({
      path:
        `/rest/v1/user_challenges?` +
        `user_id=eq.${encodeURIComponent(userId)}` +
        `&or=${encodeURIComponent(`(and(period_type.eq.daily,period_start.eq.${today}),and(period_type.eq.weekly,period_start.eq.${weekStart}),and(period_type.eq.weekly,period_start.eq.${legacyWeekStart}))`)}` +
        `&order=period_type.asc,slot.asc`,
      token: authToken
    }).catch(() => []);

    const existing = Array.isArray(existingRows) ? existingRows : [];
    const existingDaily  = existing.filter((r) => r?.period_type === "daily");
    const existingWeekly = existing.filter((r) => r?.period_type === "weekly");

    if (!forceToday && existingDaily.length >= 3 && existingWeekly.length >= 1) {
      return res.json({ ok: true, skipped: true, daily: existingDaily, weekly: existingWeekly });
    }

    // ── 2. Fetch user context + templates in parallel ─────────────────────────
    let profileRows;
    try {
      profileRows = await supabaseRest({
        path: `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=weak_spots,level,exp,timezone&limit=1`,
        token: authToken
      });
    } catch {
      profileRows = await supabaseRest({
        path: `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=weak_spots,level,exp&limit=1`,
        token: authToken
      });
    }

    const [statsRows, historyRows, allHistoryRows, templatesRaw] = await Promise.all([
      supabaseRest({
        path: `/rest/v1/user_stats?user_id=eq.${encodeURIComponent(userId)}&select=streak_days,total_sessions&limit=1`,
        token: authToken
      }),
      supabaseRest({
        path:
          `/rest/v1/simulation_history?user_id=eq.${encodeURIComponent(userId)}` +
          `&completed_at=not.is.null&order=completed_at.desc&limit=10` +
          `&select=tier,earned_exp,scenario_id`,
        token: authToken
      }),
      supabaseRest({
        path: `/rest/v1/simulation_history?user_id=eq.${encodeURIComponent(userId)}&completed_at=not.is.null&select=scenario_id`,
        token: authToken
      }),
      supabaseRest({
        path: `/rest/v1/challenge_templates?is_active=eq.true&select=code,title,description,period,type,target_min,target_max,xp_reward_min,xp_reward_max`,
        token: authToken
      })
    ]);

    const profile          = Array.isArray(profileRows)     ? profileRows[0]  : null;
    const stats            = Array.isArray(statsRows)        ? statsRows[0]    : null;
    const recentSessions   = Array.isArray(historyRows)      ? historyRows     : [];
    const completedScenIds = new Set((Array.isArray(allHistoryRows) ? allHistoryRows : []).map((r) => r?.scenario_id).filter(Boolean));
    const templates        = Array.isArray(templatesRaw)     ? templatesRaw    : [];
    const dailyTemplates   = templates.filter((t) => t.period === "daily");
    const weeklyTemplates  = templates.filter((t) => t.period === "weekly");

    const weakSpots    = Array.isArray(profile?.weak_spots) ? profile.weak_spots : [];
    const streakDays   = Number(stats?.streak_days   ?? 0);
    const totalSessions = Number(stats?.total_sessions ?? 0);
    const recentTiers  = recentSessions.map((s) => String(s.tier ?? "").toUpperCase()).filter(Boolean);
    const avgRecentXp  = recentSessions.length
      ? Math.round(recentSessions.reduce((a, s) => a + Number(s.earned_exp ?? 0), 0) / recentSessions.length)
      : 30;
    const hasNewScenarios = completedScenIds.size > 0;

    // ── 3. Compute expiry timestamps ──────────────────────────────────────────
    const weekEnd = new Date(now);
    const daysUntilSunday = (7 - weekEnd.getDay()) % 7;
    weekEnd.setDate(weekEnd.getDate() + daysUntilSunday);
    weekEnd.setHours(23, 59, 59, 999);

    // ── 4. Build Groq prompt ──────────────────────────────────────────────────
    const systemPrompt = `You are the challenge generator for BLUR, a social anxiety training app.
Select and personalise challenges for this user. Output ONLY valid JSON — no markdown, no extra text.`;

    const userPrompt = `USER CONTEXT:
- Level: ${profile?.level ?? 1}, Total sessions: ${totalSessions}, Streak: ${streakDays} days
- Recent tiers (last 10): ${recentTiers.length ? recentTiers.join(", ") : "none yet"}
- Avg XP per session: ${avgRecentXp}
- Weak spots: ${weakSpots.length ? weakSpots.map((w) => (typeof w === "object" ? w.tag : w)).join(", ") : "none identified yet"}
- Has completed scenarios before: ${hasNewScenarios}

DAILY TEMPLATES AVAILABLE:
${JSON.stringify(dailyTemplates, null, 2)}

WEEKLY TEMPLATES AVAILABLE:
${JSON.stringify(weeklyTemplates, null, 2)}

TASK: Select exactly 3 daily and 1 weekly challenge.
Rules:
- Set "target" between template's target_min and target_max, calibrated to the user's history.
- Set "xp_reward" between xp_reward_min and xp_reward_max.
- Replace {{target}} in description with the actual target number.
- Make the three daily challenges meaningfully distinct: use different goal types (novelty vs quantity vs performance vs streak/consistency vs social) and ensure each daily item has a unique "type". Avoid selecting more than one daily that revolves around "new", "different", or "uncharted" scenarios.
- Never repeat a template_code within the same period.
- Bias at least 1 daily challenge toward weak spots if any exist.
- Only use type "new_scenario" if has_completed_scenarios_before is true (${hasNewScenarios}).
- daily expires_at: "${todayEnd.toISOString()}"
- weekly expires_at: "${weekEnd.toISOString()}"

Output format (JSON only — no extra text):
{
  "daily": [
    { "template_code": "...", "title": "...", "description": "...", "type": "...", "target": 2, "xp_reward": 75, "expires_at": "..." }
  ],
  "weekly": [
    { "template_code": "...", "title": "...", "description": "...", "type": "...", "target": 5, "xp_reward": 200, "expires_at": "..." }
  ]
}`;

    const response = await groqChatCompletions({
      model: DEFAULT_GROQ_JUDGE_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   }
      ],
      options: { temperature: 0.4, top_p: 0.9, num_predict: 700 },
      stream: false,
      responseFormat: { type: "json_object" }
    });

    const rawText = await response.text().catch(() => "");
    if (!response.ok) throw new Error(`groq_error:${response.status} ${rawText}`);

    const groqData = JSON.parse(rawText);
    const content  = groqData?.choices?.[0]?.message?.content ?? "";
    const parsed   = safeParseModelJson(content);

    // ── 5. Validate each challenge against template library ───────────────────
    const dedupeChallenges = (list = [], opts = {}) => {
      const seenTemplates = new Set();
      const seenTypes = new Set();
      const unique = [];
      for (const c of Array.isArray(list) ? list : []) {
        const tpl = String(c?.template_code ?? "").trim();
        const type = String(c?.type ?? "").trim().toLowerCase();
        if (tpl && seenTemplates.has(tpl)) continue;
        if (opts.requireUniqueType && type && seenTypes.has(type)) continue;
        if (tpl) seenTemplates.add(tpl);
        if (opts.requireUniqueType && type) seenTypes.add(type);
        unique.push(c);
      }
      return unique;
    };

    const validateAndBuild = (c, period, slot) => {
      if (!c?.template_code || !c?.title || !c?.description || !c?.type) return null;
      const tpl = templates.find((t) => t.code === c.template_code && t.period === period);
      if (!tpl) return null;
      const periodStart = period === "daily" ? today : weekStart;
      const expiresAt   = String(c.expires_at || (period === "daily" ? todayEnd : weekEnd).toISOString());
      const assignedAt  = now.toISOString();
      const normalizedPeriod = String(period || "").trim().toLowerCase() || "daily";
      const challengeType = String(c.type || "").trim() || "sessions";
      return {
        user_id:       userId,
        template_code: String(c.template_code),
        period:        normalizedPeriod,
        period_type:   normalizedPeriod,
        period_start:  periodStart,
        slot,
        title:         String(c.title).trim(),
        description:   String(c.description).trim(),
        type:          challengeType,
        target:        Math.max(1, Math.round(Number(c.target) || tpl.target_min)),
        xp_reward:     Math.max(10, Math.round(Number(c.xp_reward) || tpl.xp_reward_min)),
        progress:      0,
        completed:     false,
        claimed:       false,
        status:        "pending",
        expires_at:    expiresAt,
        difficulty:    normalizedPeriod === "daily" ? "Easy" : "Medium",
        category:      challengeType,
        meta:          { source: "bridge" },
        assigned_at:   assignedAt,
        claimed_at:    null,
        created_at:    assignedAt
      };
    };

    const toInsert = [];
    const dailyList = dedupeChallenges(parsed?.daily ?? [], { requireUniqueType: true });
    const dailyUse  = dailyList.length >= 3 ? dailyList.slice(0, 3) : (parsed?.daily ?? []).slice(0, 3);
    const weeklyUse = Array.isArray(parsed?.weekly) ? parsed.weekly.slice(0, 1) : [];

    dailyUse.forEach((c, i) => { const r = validateAndBuild(c, "daily",  i); if (r) toInsert.push(r); });
    weeklyUse.forEach((c, i) => { const r = validateAndBuild(c, "weekly", i); if (r) toInsert.push(r); });

    if (toInsert.length === 0) throw new Error("AI returned no valid challenges after template validation");

    // ── 6. Delete stale rows, insert fresh ───────────────────────────────────
    await supabaseAdminRest({
      path:
        `/rest/v1/user_challenges?` +
        `user_id=eq.${encodeURIComponent(userId)}` +
        `&or=${encodeURIComponent(`(and(period_type.eq.daily,period_start.eq.${today}),and(period_type.eq.weekly,period_start.eq.${weekStart}),and(period_type.eq.weekly,period_start.eq.${legacyWeekStart}))`)}`,
      method: "DELETE",
      prefer: "return=minimal"
    }).catch(() => {});

    const insertedRows = await supabaseAdminRest({
      path: "/rest/v1/user_challenges",
      method: "POST",
      body: toInsert,
      prefer: "return=representation"
    });

    const inserted = Array.isArray(insertedRows) ? insertedRows : toInsert;
    return res.json({
      ok: true,
      skipped: false,
      inserted: inserted.length,
      daily:  inserted.filter((r) => r.period_type === "daily").sort((a, b) => a.slot - b.slot),
      weekly: inserted.filter((r) => r.period_type === "weekly")
    });

  } catch (err) {
    console.error("[/generate-challenges] error:", err?.message ?? String(err));
    return res.status(500).json({ ok: false, error: "Failed to generate challenges", detail: err?.message ?? String(err) });
  }
});

app.post("/finalize-session", async (req, res) => {
  try {
    const token = String(req.headers?.authorization ?? "")
      .replace(/^Bearer\s+/i, "")
      .trim() || String(req.body?.accessToken ?? "").trim();
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const userProfile = req.body?.userProfile ?? {};
    const profileSnapshot = req.body?.profileSnapshot ?? {};

    if (!sessionId) throw new Error("Missing sessionId");
    if (!token) throw new Error("Missing user token");

    const select = [
      "id",
      "messages",
      "judgement",
      "ai_feedback",
      "judge_categories",
      "earned_exp",
      "xp_awarded",
      "scenario:scenarios(id,slug,title,description,difficulty,tags)",
      "character:characters(id,name,role,description,preset,warmth,directness,patience,humor,strictness)"
    ].join(",");

    const rows = await supabaseRest({
      path: `/rest/v1/simulation_history?id=eq.${encodeURIComponent(sessionId)}&select=${encodeURIComponent(select)}&limit=1`,
      token
    });
    const sessionRow = Array.isArray(rows) ? rows[0] : null;
    if (!sessionRow) throw new Error("Session not found");

    const transcript = (Array.isArray(sessionRow?.messages) ? sessionRow.messages : [])
      .filter((m) => m?.text || m?.content)
      .map((m) => ({
        role: m?.role === "ai" ? "assistant" : m?.role === "assistant" ? "assistant" : "user",
        content: String(m?.text ?? m?.content ?? "")
      }));

    const scenario = sessionRow?.scenario ?? null;
    const character = sessionRow?.character ?? null;
    let judgement = sessionRow?.judgement ?? sessionRow?.ai_feedback ?? null;
    let xpToAward = Number(sessionRow?.xp_awarded ?? sessionRow?.earned_exp ?? 0) || 0;

    const rewardsAlreadyApplied = Boolean(
      sessionRow?.judgement?._meta?.rewards_applied_at ||
      sessionRow?.ai_feedback?._meta?.rewards_applied_at
    );

    if (!judgement) {
      let normalized;
      try {
        const raw = await callJudgeLLM({ scenario, character, messages: transcript, userProfile });
        normalized = normalizeJudgeResult(raw);
      } catch (judgeErr) {
        normalized = buildHeuristicJudge({
          messages: transcript,
          userProfile,
          sourceError: judgeErr?.message ?? String(judgeErr)
        });
      }

      // Apply the same deterministic post-processing rules as the /judge endpoint.
      const ruled = applyDeterministicJudgeRules({
        result: normalized,
        scenario,
        messages: transcript,
        rulesEnabled: JUDGE_RULES_ENABLED
      });
      const clamped = applyJudgeConsistencyClamps({
        result: ruled,
        scenario,
        messages: transcript
      });

      xpToAward = Number(clamped?.xp_awarded ?? clamped?.xp ?? 0) || 0;
      judgement = {
        ...clamped,
        _meta: {
          ...(clamped?._meta || {}),
          judged_at: new Date().toISOString()
        }
      };
      const judgeCategories = getOrBuildJudgeCategories(judgement);

      await supabaseRest({
        path: `/rest/v1/simulation_history?id=eq.${encodeURIComponent(sessionId)}`,
        method: "PATCH",
        token,
        body: {
          judgement,
          ai_feedback: judgement,
          tier: judgement?.tier,
          ai_tier: judgement?.tier,
          ai_score: judgement?.score,
          earned_exp: xpToAward,
          xp_awarded: xpToAward,
          judge_categories: judgeCategories
        },
        prefer: "return=minimal"
      });
    }

    if (!sessionRow?.judge_categories) {
      const judgeCategories = getOrBuildJudgeCategories(judgement);
      if (judgeCategories) {
        await supabaseRest({
          path: `/rest/v1/simulation_history?id=eq.${encodeURIComponent(sessionId)}`,
          method: "PATCH",
          token,
          body: { judge_categories: judgeCategories },
          prefer: "return=minimal"
        });
      }
    }

    let rewardsRow = null;
    if (!rewardsAlreadyApplied) {
      let rpcOut;
      try {
        rpcOut = await supabaseRest({
          path: "/rest/v1/rpc/apply_session_rewards",
          method: "POST",
          token,
          body: { p_session_id: sessionId, p_exp: xpToAward }
        });
      } catch (_sigErr) {
        // Backward compatibility for DBs still exposing single-arg apply_session_rewards(p_exp int).
        rpcOut = await supabaseRest({
          path: "/rest/v1/rpc/apply_session_rewards",
          method: "POST",
          token,
          body: { p_exp: xpToAward }
        });
      }
      rewardsRow = Array.isArray(rpcOut) ? rpcOut[0] : rpcOut;

      const marked = {
        ...(judgement || {}),
        _meta: {
          ...((judgement && judgement._meta) || {}),
          rewards_applied_at: new Date().toISOString()
        }
      };
      judgement = marked;
      await supabaseRest({
        path: `/rest/v1/simulation_history?id=eq.${encodeURIComponent(sessionId)}`,
        method: "PATCH",
        token,
        body: {
          judgement: marked,
          ai_feedback: marked
        },
        prefer: "return=minimal"
      });
    }

    const userId = await getUserIdFromRequest(req);

    // ── Evaluate challenge progress (fire-and-forget — never blocks finalize) ──
    try {
      await supabaseAdminRest({
        path: "/rest/v1/rpc/evaluate_challenges",
        method: "POST",
        body: {
          p_user_id:     userId,
          p_session_id:  sessionId,
          p_xp_earned:   xpToAward,
          p_tier:        String(judgement?.tier ?? ""),
          p_scenario_id: String(scenario?.id ?? ""),
          p_difficulty:  String(scenario?.difficulty ?? "")
        }
      });
    } catch (evalErr) {
      // Non-fatal — log and continue
      console.warn("[finalize-session] evaluate_challenges failed:", evalErr?.message ?? evalErr);
    }

    let profileRow = null;
    try {
      const profileRows = await supabaseRest({
        path:
          `/rest/v1/profiles?` +
          `id=eq.${encodeURIComponent(userId)}` +
          `&select=${encodeURIComponent("id,exp,level,rank")}` +
          `&limit=1`,
        token
      });
      profileRow = Array.isArray(profileRows) ? profileRows[0] : null;
    } catch {}

    const fallbackExp = Number(profileRow?.exp ?? profileSnapshot?.exp ?? 0) || 0;
    const fallbackLevel = Number(profileRow?.level ?? profileSnapshot?.level ?? 1) || 1;
    const fallbackRank = String(profileRow?.rank ?? profileSnapshot?.rank ?? "Newbie");

    await completeOnboardingIfNeeded({
      userId,
      sessionId,
      scenarioSlug: scenario?.slug,
      token
    });

    return res.json({
      ok: true,
      judgement,
      xp_awarded: xpToAward,
      rewards_applied: !rewardsAlreadyApplied,
      new_exp_total: Number(rewardsRow?.new_exp_total ?? rewardsRow?.exp_total ?? fallbackExp) || fallbackExp,
      new_level: Number(rewardsRow?.new_level ?? rewardsRow?.level ?? fallbackLevel) || fallbackLevel,
      new_rank: String(rewardsRow?.new_rank ?? rewardsRow?.rank ?? fallbackRank)
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      _error: e?.message ?? String(e)
    });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { scenario, character, difficultyCtx, userProfile, messages, options, stream } = req.body ?? {};

    const modResult = moderateMessage(lastUserText(messages));
    if (modResult.blocked) {
      console.warn(`[/api/chat] blocked message reason=${modResult.reason}`);
      if (stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
        sseWrite(res, { delta: modResult.softReply });
        sseWrite(res, { done: true, ended: true, _moderated: true });
        return res.end();
      }
      return res.json({
        message: { role: "assistant", content: modResult.softReply },
        done: true,
        _moderated: true
      });
    }

    const merged = mergedOptions(options);
    const payloadMessages = toGroqMessages([
      { role: "system", content: chatSystemPrompt({ scenario, character, difficultyCtx, userProfile }) },
      ...(messages ?? [])
    ]);

    if (!stream) {
      const response = await groqChatCompletions({
        model: DEFAULT_GROQ_CHAT_MODEL,
        messages: payloadMessages,
        options: merged,
        stream: false
      });

      const text = await response.text().catch(() => "");
      if (!response.ok) return res.status(response.status).json({ error: `groq_error:${response.status}`, detail: text });

      const data = JSON.parse(text);
      const content = data?.choices?.[0]?.message?.content ?? "";
      return res.json({
        message: { role: "assistant", content },
        done: true
      });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.flushHeaders?.();

    const response = await groqChatCompletions({
      model: DEFAULT_GROQ_CHAT_MODEL,
      messages: payloadMessages,
      options: merged,
      stream: true
    });

    if (!response.ok || !response.body) {
      const t = await response.text().catch(() => "");
      sseWrite(res, { type: "error", error: `groq_error:${response.status}`, detail: t });
      sseWrite(res, { type: "done", done: true });
      return res.end();
    }

    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const raw = trimmed.replace(/^data:\s*/, "");
        if (!raw || raw === "[DONE]") {
          sseWrite(res, { type: "done", done: true });
          return res.end();
        }

        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          continue;
        }

        const delta = payload?.choices?.[0]?.delta?.content ?? "";
        if (!delta) continue;

        if (delta.includes(END_TOKEN)) {
          const cleaned = delta.replaceAll(END_TOKEN, "");
          if (cleaned) sseWrite(res, { delta: cleaned });
          sseWrite(res, { done: true, ended: true });
          return res.end();
        }

        sseWrite(res, { delta });
      }
    }

    sseWrite(res, { type: "done", done: true });
    return res.end();
  } catch (e) {
    try {
      sseWrite(res, { type: "error", error: e?.message ?? String(e) });
      sseWrite(res, { type: "done", done: true });
      return res.end();
    } catch {
      return res.status(500).json({ error: e?.message ?? String(e) });
    }
  }
});

app.post("/reply", async (req, res) => {
  try {
    const { scenario, character, messages, difficultyCtx, userProfile, options } = req.body ?? {};

    const modResult = moderateMessage(lastUserText(messages));
    if (modResult.blocked) {
      console.warn(`[/reply] blocked message reason=${modResult.reason}`);
      return res.json({ text: modResult.softReply, _moderated: true });
    }

    const payloadMessages = toGroqMessages([
      { role: "system", content: chatSystemPrompt({ scenario, character, difficultyCtx, userProfile }) },
      ...(messages ?? [])
    ]);

    const response = await groqChatCompletions({
      model: DEFAULT_GROQ_CHAT_MODEL,
      messages: payloadMessages,
      options: mergedOptions(options),
      stream: false
    });

    const text = await response.text().catch(() => "");
    if (!response.ok) throw new Error(`groq_error:${response.status} ${text}`);
    const data = JSON.parse(text);
    return res.json({ text: data?.choices?.[0]?.message?.content ?? "" });
  } catch (e) {
    return res.status(500).json({ text: "...", _error: e?.message ?? String(e) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Blur AI bridge running on http://0.0.0.0:${PORT}`);
});
