const MOD_RULES = [
  {
    id: "length",
    test: (t) => t.length > 600,
    reason: "message_too_long",
    softReply: "Let's keep things a bit shorter - say that in one or two sentences."
  },
  {
    id: "prompt_injection",
    test: (t) => /ignore (all |previous |your )?(instructions|rules|prompt|system)|you are now|disregard (your|all)|new (persona|identity|instructions)|forget (everything|your training)|system prompt|\[system\]|<system>/i.test(t),
    reason: "prompt_injection",
    softReply: "I'm not sure what you mean - let's stay focused on the conversation."
  },
  {
    id: "jailbreak",
    test: (t) => /\bDAN\b|do anything now|jailbreak|pretend (you('re| are)|there are no)|roleplay as (an? )?(AI|assistant|model|GPT|Claude)|act as if you have no (restrictions|limits|guidelines)|you('re| are) (not|no longer) an? AI/i.test(t),
    reason: "jailbreak_attempt",
    softReply: "I'm not sure what you mean - let's stay focused on the conversation."
  },
  {
    id: "pii_extraction",
    test: (t) => /tell me (your|the) (api key|secret|password|token|credentials)|reveal (your |the )?(system|prompt|instructions)|what (is|are) your (instructions|rules|system prompt)/i.test(t),
    reason: "pii_extraction",
    softReply: "I'm not sure what you mean - let's stay focused on the conversation."
  },
  {
    id: "self_harm",
    test: (t) => /\b(how to|ways to|help me) (kill (myself|yourself|themselves)|commit suicide|self.harm|cut myself|end my life)\b/i.test(t),
    reason: "self_harm",
    softReply: "That's outside what I can help with here. If you're going through something difficult, please reach out to a crisis line."
  },
  {
    id: "extreme_content",
    test: (t) => /\b(child porn|cp|csam|loli|shotacon|snuff|necrophilia|zoophilia|bestiality)\b/i.test(t),
    reason: "extreme_content",
    softReply: "That's not something I can engage with. Let's get back to the scenario."
  },
  {
    id: "slurs",
    test: (t) => /\b(n[i1]gg[ae]r|f[a4]gg[o0]t|ch[i1]nk|sp[i1]c|k[i1]ke|g[o0]okk?)\b/i.test(t),
    reason: "hate_speech",
    softReply: "Let's keep this respectful - that kind of language isn't okay here."
  }
];

export function moderateMessage(text = "") {
  const t = String(text).trim();
  for (const rule of MOD_RULES) {
    if (rule.test(t)) {
      return { blocked: true, reason: rule.reason, softReply: rule.softReply };
    }
  }
  return { blocked: false };
}

export function lastUserText(messages = []) {
  const msgs = Array.isArray(messages) ? messages : [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m?.role === "user" && (m?.content || m?.text)) {
      return String(m.content ?? m.text ?? "").trim();
    }
  }
  return "";
}
