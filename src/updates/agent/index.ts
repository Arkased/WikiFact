// The public surface of the update agent folder (technical/updates.md, "Pipeline").
export { processRequest } from "./process.js";
export { prepareMember, writeMember, type GroupMember } from "./group.js";
export type { AgentDeps, PipelineConfig, ProcessResult } from "./types.js";
