import { buildCharacterBehaviorPrompt } from "../src/components/prompts/aiBehaviorPrompts.js";

export function buildCharacterPrompt(character, scenario, ctx = {}) {
  return buildCharacterBehaviorPrompt(character, scenario, ctx);
}
