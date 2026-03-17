export function buildGenerateChallengesPrompt({
  profile = {},
  weakSpots = [],
  recentSessions = [],
}) {
  const safeWeakSpots = Array.isArray(weakSpots) ? weakSpots.slice(0, 4) : []
  const safeSessions = Array.isArray(recentSessions) ? recentSessions.slice(0, 6) : []

  const sessionSummary = safeSessions
    .map((session, index) => {
      const categories =
        session?.judge_categories && typeof session.judge_categories === 'object'
          ? Object.entries(session.judge_categories)
              .map(([key, value]) => `${key}:${value}`)
              .join(', ')
          : 'none'

      return [
        `Session ${index + 1}`,
        `scenario=${session?.scenario_title || 'Unknown'}`,
        `tier=${session?.tier || 'N/A'}`,
        `score=${session?.score ?? 'N/A'}`,
        `categories=${categories}`,
      ].join(' | ')
    })
    .join('\n')

  const weakSpotSummary = safeWeakSpots.length
    ? safeWeakSpots
        .map(
          (spot) =>
            `${spot?.tag || 'Unknown'}: ${spot?.description || 'No description'} (${spot?.sessions_detected || 0} sessions)`,
        )
        .join('\n')
    : 'none'

  return `
You are generating social-skills practice challenges for a BLUR user.

Goal:
- Return exactly 3 daily challenges and exactly 1 weekly challenge.
- Challenges should be specific, achievable, and tied to the user's weak spots or recent performance patterns.
- Keep them practical and behavior-based, not vague self-help advice.
- Daily challenges should be small enough to attempt today.
- Weekly challenge should be broader and slightly harder.

User profile:
- Rank: ${profile?.rank || 'Unknown'}
- Level: ${profile?.level ?? 'Unknown'}

Weak spots:
${weakSpotSummary}

Recent sessions:
${sessionSummary || 'none'}

Rules:
- Each challenge must include:
  - title: short and clear
  - description: one or two sentences max
  - difficulty: Easy | Medium | Hard
  - category: one of confidence, clarity, composure, social_calibration, consistency
- Avoid duplicates or overlapping phrasing.
- If weak spots are missing, infer from recent sessions.
- Do not mention BLUR, AI, or the database.

Return ONLY valid JSON with this exact shape:
{
  "daily": [
    {
      "title": "string",
      "description": "string",
      "difficulty": "Easy" | "Medium" | "Hard",
      "category": "confidence" | "clarity" | "composure" | "social_calibration" | "consistency"
    }
  ],
  "weekly": [
    {
      "title": "string",
      "description": "string",
      "difficulty": "Easy" | "Medium" | "Hard",
      "category": "confidence" | "clarity" | "composure" | "social_calibration" | "consistency"
    }
  ]
}`.trim()
}
