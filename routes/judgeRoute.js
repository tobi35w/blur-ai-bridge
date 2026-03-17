export function registerJudgeRoute(app, deps) {
  const {
    callJudgeLLM,
    normalizeJudgeResult,
    applyDeterministicJudgeRules,
    applyJudgeConsistencyClamps,
    judgeRulesEnabled,
    buildHeuristicJudge
  } = deps;

  app.post("/judge", async (req, res) => {
    try {
      const { scenario, character, messages, userProfile } = req.body ?? {};
      const safeMessages = Array.isArray(messages) ? messages : [];

      // Pre-LLM short-circuit: 1 user message = gave up = automatic F
      const _uMsgs = safeMessages.filter((m) => m?.role === "user" || m?.role === "client");
      if (_uMsgs.length <= 1) {
        return res.json(normalizeJudgeResult({
          score: 8, tier: "F", xp: 0, xp_awarded: 0,
          summary: "You didn't give this one a real shot. One message isn't a conversation -- it's a door you opened and immediately closed.",
          reasons: ["No genuine attempt was made.", "A single message means the scenario was abandoned before it started.", "Even an awkward first attempt beats giving up."],
          reason_citations: [[0], [0], []],
          tips: ["Start with something small -- even a simple greeting gets the ball rolling.", "The discomfort is the point. Lean into it."],
          flags: { unsafe: false, rude: false }
        }));
      }

      const raw = await callJudgeLLM({ scenario, character, messages: safeMessages, userProfile });
      const normalized = normalizeJudgeResult(raw);
      const ruled = applyDeterministicJudgeRules({
        result: normalized,
        scenario,
        messages: safeMessages,
        rulesEnabled: judgeRulesEnabled !== false
      });
      const clamped = applyJudgeConsistencyClamps({
        result: ruled,
        scenario,
        messages: safeMessages
      });

      return res.json(clamped);
    } catch (e) {
      const { messages, userProfile } = req.body ?? {};
      const heuristic = buildHeuristicJudge({
        messages: Array.isArray(messages) ? messages : [],
        userProfile: userProfile ?? {},
        sourceError: e?.message ?? String(e)
      });
      const ruled = applyDeterministicJudgeRules({
        result: heuristic,
        scenario: (req.body ?? {}).scenario,
        messages: Array.isArray(messages) ? messages : [],
        rulesEnabled: judgeRulesEnabled !== false
      });
      const clamped = applyJudgeConsistencyClamps({
        result: ruled,
        scenario: (req.body ?? {}).scenario,
        messages: Array.isArray(messages) ? messages : []
      });
      return res.status(200).json(clamped);
    }
  });
}
