/**
 * PersonaTrigger: determines whether to trigger persona generation.
 * Implements the 5 trigger conditions from the legacy system.
 */

import { CheckpointManager } from "../../utils/checkpoint.js";
import { stripSceneNavigation } from "../scene/scene-navigation.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { hasProjectSceneFiles } from "../storage/project-scoped-storage.js";
import { StoragePaths } from "../storage/types.js";
import type { PersonaVariant } from "../prompts/persona-generation.js";

import type { Logger } from "../types.js";
import { readScopeState } from "./user-global-scope.js";

const TAG = "[memory-tdai] [trigger]";

type TriggerLogger = Logger;

export interface TriggerResult {
  should: boolean;
  reason: string;
}

export class PersonaTrigger {
  private dataDir: string;
  private interval: number;
  private logger: TriggerLogger | undefined;
  private storage: StorageAdapter | undefined;
  private variant: PersonaVariant;

  constructor(opts: {
    dataDir: string;
    interval: number;
    logger?: TriggerLogger;
    storage?: StorageAdapter;
    /**
     * Document the trigger serves (default: user-global). A project document
     * carries no user-global scope marker by design, so the scope migration
     * rule does not apply to it.
     */
    variant?: PersonaVariant;
  }) {
    this.dataDir = opts.dataDir;
    this.interval = opts.interval;
    this.logger = opts.logger;
    this.storage = opts.storage;
    this.variant = opts.variant ?? "user-global";
  }

  async shouldGenerate(): Promise<TriggerResult> {
    const cpManager = new CheckpointManager(this.dataDir, undefined, this.storage);
    const cp = await cpManager.read();
    this.logger?.debug?.(`${TAG} Evaluating: total_processed=${cp.total_processed}, last_persona_at=${cp.last_persona_at}, memories_since=${cp.memories_since_last_persona}, scenes=${cp.scenes_processed}`);

    // Priority 1: Agent explicitly requested persona update
    if (cp.request_persona_update) {
      const result: TriggerResult = {
        should: true,
        reason: `主动请求: ${cp.persona_update_reason || "Agent 请求更新"}`,
      };
      this.logger?.debug?.(`${TAG} Trigger P1 (explicit request): ${result.reason}`);
      return result;
    }

    const hasSceneFiles = await this.hasSceneFiles();
    const hasPersonaBody = await this.hasPersonaBody();
    const hasGeneratedPersona = cp.last_persona_at > 0 || cp.last_persona_time !== "" || hasPersonaBody;

    // Priority 2: Cold start — first extraction done, no persona yet, has scene files
    if (
      cp.scenes_processed > 0 &&
      !hasGeneratedPersona &&
      hasSceneFiles
    ) {
      const result: TriggerResult = { should: true, reason: "首次冷启动：首次提取完成且有场景文件" };
      this.logger?.debug?.(`${TAG} Trigger P2 (cold start): scenes_processed=${cp.scenes_processed}, total_processed=${cp.total_processed}`);
      return result;
    }

    // Priority 2.5: Recovery — persona was generated before but persona.md body
    // is now empty (corrupted/missing). Regenerate to restore.
    if (
      hasGeneratedPersona &&
      hasSceneFiles &&
      !hasPersonaBody
    ) {
      const result: TriggerResult = { should: true, reason: "恢复：persona.md 正文丢失或为空，需要重新生成" };
      this.logger?.debug?.(`${TAG} Trigger P2.5 (recovery): last_persona_time=${cp.last_persona_time || "(empty)"}, persona body missing`);
      return result;
    }

    // Priority 2.6: Scope migration — the persona was written before the
    // user-global scope check existed (no scope marker). The proxy does not
    // inject such a persona, so regenerate it from all scenes now instead of
    // waiting for the threshold. A rejected marker does not trigger here, so a
    // persona that fails the check is retried only on the normal triggers.
    if (
      this.variant === "user-global" &&
      hasPersonaBody &&
      hasSceneFiles &&
      (await this.personaScopeState()) === "none"
    ) {
      const result: TriggerResult = { should: true, reason: "迁移：persona 缺少 user-global 作用域标记，需要按全部场景重新生成" };
      this.logger?.debug?.(`${TAG} Trigger P2.6 (scope migration): persona has no user-global scope marker`);
      return result;
    }

    // Priority 3: First scene block extraction
    if (cp.scenes_processed === 1 && cp.memories_since_last_persona > 0) {
      const result: TriggerResult = { should: true, reason: "首次 Scene Block 提取完成" };
      this.logger?.debug?.(`${TAG} Trigger P3 (first scene): scenes_processed=${cp.scenes_processed}`);
      return result;
    }

    // Priority 4: Reached threshold
    if (cp.memories_since_last_persona >= this.interval) {
      const result: TriggerResult = {
        should: true,
        reason: `达到阈值: ${cp.memories_since_last_persona} >= ${this.interval}`,
      };
      this.logger?.debug?.(`${TAG} Trigger P4 (threshold): ${result.reason}`);
      return result;
    }

    this.logger?.debug?.(`${TAG} No trigger conditions met`);
    return { should: false, reason: "" };
  }

  private async hasSceneFiles(): Promise<boolean> {
    try {
      if (this.storage) {
        const files = await this.storage.readdirNames(StoragePaths.sceneBlocksDir, ".md");
        if (files.length > 0) return true;
        // The user-global persona is built from all scenes. A user who works
        // only inside projects has no root scene file, but still needs it.
        // A project document is built from the scenes of its own view only.
        return this.variant === "user-global" && await hasProjectSceneFiles(this.storage);
      }
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const blocksDir = path.default.join(this.dataDir, "scene_blocks");
      const files = await fs.default.readdir(blocksDir);
      return files.some((f) => f.endsWith(".md"));
    } catch {
      return false;
    }
  }

  /** Scope state recorded on the first line of persona.md ("none" when unreadable). */
  private async personaScopeState(): Promise<ReturnType<typeof readScopeState>> {
    const raw = await this.readPersona();
    return raw ? readScopeState(raw) : "none";
  }

  private async readPersona(): Promise<string | null> {
    try {
      if (this.storage) return await this.storage.readFile(StoragePaths.persona);
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      return await fs.default.readFile(path.default.join(this.dataDir, "persona.md"), "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Check whether persona.md has a non-empty body (excluding scene navigation).
   * Returns false if the file doesn't exist, is empty, or only contains
   * scene navigation (no actual persona content).
   */
  private async hasPersonaBody(): Promise<boolean> {
    const raw = await this.readPersona();
    if (!raw) return false;
    return stripSceneNavigation(raw).trim().length > 0;
  }
}
