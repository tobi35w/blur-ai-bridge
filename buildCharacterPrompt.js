import { buildCharacterBehaviorPrompt } from "./prompts/aiBehaviorPrompts.js";

export function buildCharacterPrompt(character, scenario, ctx = {}) {
  return buildCharacterBehaviorPrompt(character, scenario, ctx);
}
