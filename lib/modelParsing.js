export function safeParseModelJson(text) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new Error("Empty judge response");

  try {
    return JSON.parse(raw);
  } catch {}

  const noFences = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(noFences);
  } catch {}

  const start = noFences.indexOf("{");
  const end = noFences.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return JSON.parse(noFences.slice(start, end + 1));
  }

  throw new Error("Model did not return JSON");
}

export function isJsonValidationErrorText(text = "") {
  const t = String(text ?? "").toLowerCase();
  return (
    t.includes("json_validate_failed") ||
    t.includes("failed to generate json") ||
    t.includes("max completion tokens reached") ||
    t.includes("valid document")
  );
}

