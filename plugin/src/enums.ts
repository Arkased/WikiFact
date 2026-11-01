/** What the setup did to a file. */
export enum SetupOutcome {
  /** The file did not exist or differed: the setup wrote it. */
  Written = "written",
  /** The file already holds what the setup would write. */
  Unchanged = "unchanged",
  /** The file has other content or cannot be changed: the setup left it untouched. */
  Skipped = "skipped",
}

/** The event that the submit hook tells from the stop of a subagent. */
export enum HookEvent {
  PreToolUse = "PreToolUse",
}

/** The events whose `additionalContext` Claude Code adds to the context. */
export enum ContextEvent {
  SessionStart = "SessionStart",
  SubagentStart = "SubagentStart",
}

/** The `type` of a line of a transcript. */
export enum TranscriptEntryType {
  Assistant = "assistant",
  User = "user",
}

/** The `type` of an item in `message.content` of a transcript line. */
export enum ContentItemType {
  ToolUse = "tool_use",
  Text = "text",
}
