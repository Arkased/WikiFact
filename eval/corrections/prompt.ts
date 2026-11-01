import type { Task } from "./data.js";

/**
 * Builds the prompt that a consumer gets for one task.
 *
 * @param t - the task
 * @returns the prompt text: the game, the question, the observation and the request for a short answer
 * @sideEffects none
 */
export function taskPrompt(t: Task): string {
  return [
    "You are playing a Minecraft-style survival game and need to answer a question.",
    "A wiki of game facts is available through the wikifact tools. Use it.",
    "",
    `Question: ${t.question}`,
    "",
    `What you observe in the game: ${t.observation}`,
    "",
    "Give a short final answer.",
  ].join("\n");
}
