function normalizeText(value) {
  return String(value ?? '').trim()
}

function normalizeTranscript(messages = []) {
  return messages
    .filter(Boolean)
    .map((m, i) => ({
      idx: Number.isInteger(m?.idx) ? m.idx : Number.isInteger(m?.i) ? m.i : i,
      role:
        m.role === 'assistant' || m.role === 'ai'
          ? 'assistant'
          : m.role === 'system'
            ? 'system'
            : 'user',
      content: normalizeText(m.content ?? m.text),
    }))
    .filter((m) => m.content.length > 0)
}

export function clampNum(n, min, max) {
  const v = Number(n)
  if (!Number.isFinite(v)) return min
  return Math.max(min, Math.min(max, v))
}

export function tierFromScore(score) {
  const s = clampNum(score, 0, 100)
  if (s >= 85) return 'A'
  if (s >= 70) return 'B'
  if (s >= 50) return 'C'
  if (s >= 35) return 'D'
  if (s >= 15) return 'E'
  return 'F'
}

export function xpFromTier(tier) {
  if (tier === 'A') return 60
  if (tier === 'B') return 50
  if (tier === 'C') return 40
  if (tier === 'D') return 30
  if (tier === 'E') return 20
  return 0
}

export function recomputeTierAndXp(result) {
  const score = clampNum(result?.score ?? 0, 0, 100)
  const tier = tierFromScore(score)
  const xp = xpFromTier(tier)
  return { ...result, score, tier, xp, xp_awarded: xp }
}

export function getScenarioType(scenario) {
  const title = String(scenario?.title ?? '').toLowerCase()
  const desc = String(scenario?.description ?? '').toLowerCase()
  const text = `${title} ${desc}`
  if (/apolog|sorry|late/.test(text)) return 'apology'
  if (/boundar|decline|say no|refus/.test(text)) return 'boundary'
  if (/romantic|approach|flirt|ask out|coffee shop|stranger/.test(text)) return 'approach'
  return 'generic'
}

export function extractUserSignals(messages = []) {
  const transcript = normalizeTranscript(messages)
  const userMsgs = transcript.filter((m) => m.role === 'user')
  const userTexts = userMsgs.map((m) => String(m.content ?? '').trim())
  const combined = userTexts.join(' ')
  const lower = combined.toLowerCase()
  const hasApology = /\b(sorry|apologiz|apology|my bad)\b/.test(lower)
  const hasOwnership = /\b(my fault|i was late|i should|i shouldn't|i should have|i didn't|i messed up|i forgot)\b/.test(lower)
  const hasRepair = /\b(won't happen|make it right|make up|fix this|can we still|let's still)\b/.test(lower)
  const hasEmpathy = /\b(i understand|i get that|i see why|i know that|i appreciate)\b/.test(lower)

  const hasBoundaryNo = /\b(i can't|i cannot|i won't|i'm not able|i am not able|i can't do|i won't be able)\b/.test(lower)
  const hasBoundarySoftener = /\b(appreciate|thanks|thank you|sorry|wish i could|i wish)\b/.test(lower)
  const overApologyCount = (lower.match(/\bsorry\b/g) || []).length

  const hasGreeting = /\b(hi|hello|hey)\b/.test(lower)
  const hasIntro = /\b(i'm|i am)\s+[a-z]{2,}/i.test(combined)
  const hasInterest = /\b(noticed you|thought i'd|wanted to say|you look|you seem|caught my eye)\b/.test(lower)
  const asksQuestion = /\?/.test(combined)

  const deflection = /\b(not my fault|whatever|fine|who cares|doesn't matter|what do you want)\b/.test(lower)
  const rude = /\b(stupid|idiot|shut up|hate you|dumb|not my problem|chill out|who cares)\b/.test(lower)

  return {
    userMsgs,
    userTexts,
    hasApology,
    hasOwnership,
    hasRepair,
    hasEmpathy,
    hasBoundaryNo,
    hasBoundarySoftener,
    overApologyCount,
    hasGreeting,
    hasIntro,
    hasInterest,
    asksQuestion,
    deflection,
    rude,
  }
}

export function applyDeterministicJudgeRules({ result, scenario, messages, rulesEnabled = true }) {
  if (!rulesEnabled) return result
  const type = getScenarioType(scenario)
  const signals = extractUserSignals(messages)
  let score = clampNum(result?.score ?? 60, 0, 100)

  if (signals.rude) {
    score = Math.min(score, 30)
  }

  if (type === 'apology') {
    if (!signals.hasApology) score = Math.min(score, 60)
    if (signals.deflection) score = Math.min(score, 55)
    if (signals.hasApology && signals.hasOwnership && (signals.hasRepair || signals.hasEmpathy)) {
      score = Math.max(score, 75)
    }
  } else if (type === 'boundary') {
    if (!signals.hasBoundaryNo) score = Math.min(score, 60)
    if (signals.hasBoundaryNo) score = Math.max(score, 65)
    if (signals.hasBoundaryNo && signals.hasBoundarySoftener) score = Math.max(score, 70)
    if (signals.overApologyCount >= 3) score = Math.min(score, 60)
  } else if (type === 'approach') {
    if (signals.hasGreeting && signals.asksQuestion) score = Math.max(score, 70)
    if (signals.hasGreeting && signals.hasIntro && signals.asksQuestion) score = Math.max(score, 75)
    if (signals.hasInterest && signals.asksQuestion) score = Math.max(score, 75)
  }

  const merged = { ...result, score, flags: { ...result?.flags, rude: result?.flags?.rude || signals.rude } }
  return recomputeTierAndXp(merged)
}

export function applyJudgeConsistencyClamps({ result, scenario, messages }) {
  const safeMessages = Array.isArray(messages) ? messages : []
  const userMsgs = safeMessages.filter((m) => m?.role === 'user' || m?.role === 'client')
  const userWordCount = userMsgs.reduce(
    (n, m) => n + String(m?.content ?? m?.text ?? '').trim().split(/\s+/).filter(Boolean).length,
    0
  )
  const userTexts = userMsgs.map((m) => String(m?.content ?? m?.text ?? ''))
  const userTextLower = userTexts.map((t) => t.toLowerCase())
  const signals = extractUserSignals(safeMessages)
  const scenarioType = getScenarioType(scenario)

  let score = clampNum(result?.score ?? 0, 0, 100)
  let flags = { ...(result?.flags || {}) }

  // CLAMP 1: Gave up - 1 user message total, or <=2 messages with <=6 words combined
  const gaveUp = userMsgs.length <= 1 || (userMsgs.length <= 2 && userWordCount <= 6)

  // CLAMP 2: Tone severity bands (severe rude -> F/E, mild dismissive -> D)
  const severeRudePattern = /\b(shut up|idiot|stupid|hate you|not my problem|who cares)\b/
  const mildRudePattern = /\b(chill out|whatever|fine|don.?t care|none of your)\b/
  const severeCount = userTextLower.filter((t) => severeRudePattern.test(t)).length
  const mildCount = userTextLower.filter((t) => mildRudePattern.test(t)).length
  const totalUser = userMsgs.length || 1
  const severeAll = severeCount > 0 && severeCount === totalUser
  const severeMajority = severeCount > 0 && severeCount / totalUser >= 0.5
  const mildMajority = (mildCount > 0 && mildCount / totalUser >= 0.5) || (signals.rude && mildCount > 0)

  if (gaveUp && score > 14) {
    score = 10
    flags = { ...flags, rude: flags?.rude || signals.rude }
  } else if (severeAll) {
    score = Math.min(score, 10)
    flags = { ...flags, rude: true }
  } else if (severeMajority && score > 30) {
    score = 30
    flags = { ...flags, rude: true }
  } else if (mildMajority && score > 40) {
    score = 40
    flags = { ...flags, rude: flags?.rude || signals.rude }
  }

  // CLAMP 3: Apology deflection floor (avoid over-penalizing to F/E when not rude)
  if (
    scenarioType === 'apology' &&
    !signals.rude &&
    !gaveUp &&
    (signals.deflection || !signals.hasApology) &&
    score < 40
  ) {
    score = 40
  }

  if (
    scenarioType === 'apology' &&
    mildMajority &&
    !severeMajority &&
    score < 40
  ) {
    score = 40
  }

  // CLAMP 4: If model flagged rude but scored too high, keep within E band
  if (flags?.rude && score > 25) {
    score = 25
  }

  const merged = { ...result, score, flags }
  return recomputeTierAndXp(merged)
}
