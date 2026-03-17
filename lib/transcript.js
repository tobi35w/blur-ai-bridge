export function normalizeText(value) {
  return String(value ?? "").trim();
}

export function normalizeTranscript(messages = []) {
  return messages
    .filter(Boolean)
    .map((m, i) => ({
      idx: Number.isInteger(m?.idx) ? m.idx : Number.isInteger(m?.i) ? m.i : i,
      role:
        m.role === "assistant" || m.role === "ai"
          ? "assistant"
          : m.role === "system"
            ? "system"
            : "user",
      content: normalizeText(m.content ?? m.text)
    }))
    .filter((m) => m.content.length > 0);
}

export function toGroqMessages(messages = []) {
  return normalizeTranscript(messages).map((m) => ({
    role: m.role,
    content: m.content
  }));
}
