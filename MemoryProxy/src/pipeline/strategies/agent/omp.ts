/**
 * omp AgentStrategy.
 *
 * omp is a header-only agent (HEADER_ONLY_AGENTS): on a preset failure the
 * request is always bypassed and no form is shown.
 */

import { ompAdapter } from "../../../agent-adapters/omp.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const ompStrategy: AgentStrategy = {
  ...ompAdapter,
  supportsSessionForm: false, // header-only 客户端不认 ask_followup_question tool
  bypassOnPresetFail: true,
  stageGates: STAGE_PRESETS.full,
};
