/**
 * PersonaGenerator: generates or updates user persona using the four-layer
 * deep scan model via CleanContextRunner.
 */

import type { MemoryPromptMode } from "../../config.js";
import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import { CheckpointManager } from "../../utils/checkpoint.js";
import { readSceneIndex } from "../scene/scene-index.js";
import { generateSceneNavigation, stripSceneNavigation } from "../scene/scene-navigation.js";
import { buildPersonaPrompt, type PersonaVariant } from "../prompts/persona-generation.js";
import { BackupManager } from "../../utils/backup.js";
import { escapeXmlTags } from "../../utils/sanitize.js";
import { report } from "../report/reporter.js";
import { reportL3LatencyMetrics } from "../report/metric-tracking-l3-latency.js";
import type { LLMRunner, Logger, TraceContext } from "../types.js";
import { buildTraceParams } from "../types.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { isProjectSceneFilename } from "../storage/project-paths.js";
import { StoragePaths } from "../storage/types.js";
import type { ResolvedMemoryPrompt } from "../memory-prompt/types.js";
import { composeMemorySystemPrompt } from "../memory-prompt/composer.js";
import {
  USER_GLOBAL_REJECTED_MARKER,
  USER_GLOBAL_SCOPE_MARKER,
  checkUserGlobalPersona,
  readScopeState,
  stripScopeMarkers,
  type ScopeCheckResult,
} from "./user-global-scope.js";

const TAG = "[memory-tdai] [persona]";

export class PersonaGenerator {
  private dataDir: string;
  private runner: LLMRunner;
  private logger: Logger | undefined;
  private backupCount: number;
  private promptMode: MemoryPromptMode;
  private memoryPrompt: ResolvedMemoryPrompt | undefined;
  private instanceId: string | undefined;
  private storage: StorageAdapter | undefined;
  private traceContext: TraceContext | undefined;
  private scopeJudge: LLMRunner | undefined;
  private variant: PersonaVariant;

  constructor(opts: {
    dataDir: string;
    config: unknown;
    model?: string;
    /** Prompt family for L3 generation (default: chat). */
    promptMode?: MemoryPromptMode;
    /** Resolved custom strategy. Undefined preserves the current system prompt exactly. */
    memoryPrompt?: ResolvedMemoryPrompt;
    backupCount?: number;
    logger?: Logger;
    /** Plugin instance ID for metric reporting (optional) */
    instanceId?: string;
    /**
     * Host-neutral LLM runner. When provided, used instead of creating
     * a CleanContextRunner (decouples from OpenClaw runtime).
     * Must be configured with `enableTools: true`.
     */
    llmRunner?: LLMRunner;
    /** StorageAdapter for file operations (COS/local). Falls back to fs when absent. */
    storage?: StorageAdapter;
    /** langfuse 上报身份四元组（team/user/agent/session），填充 trace 顶级字段。 */
    traceContext?: TraceContext;
    /**
     * Text-only runner (enableTools=false) that checks the persona for project
     * facts. Falls back to a CleanContextRunner on the same model.
     */
    scopeJudge?: LLMRunner;
    /**
     * L3 document to generate (default: user-global). The project variant
     * writes a project memory document through a project-scoped storage view:
     * it needs no user-global scope check, so no judge is built or called,
     * and the file carries no scope marker.
     */
    variant?: PersonaVariant;
  }) {
    this.dataDir = opts.dataDir;
    this.logger = opts.logger;
    this.promptMode = opts.promptMode ?? "chat";
    this.memoryPrompt = opts.memoryPrompt;
    this.backupCount = opts.backupCount ?? 3;
    this.instanceId = opts.instanceId;
    this.storage = opts.storage;
    this.traceContext = opts.traceContext;
    this.variant = opts.variant ?? "user-global";
    // Use injected LLMRunner if available, otherwise fall back to CleanContextRunner
    this.runner = opts.llmRunner ?? new CleanContextRunner({
      config: opts.config,
      modelRef: opts.model,
      enableTools: true,
      logger: opts.logger,
    });
    this.scopeJudge = this.variant === "project"
      ? undefined
      : opts.scopeJudge ?? new CleanContextRunner({
          config: opts.config,
          modelRef: opts.model,
          enableTools: false,
          logger: opts.logger,
        });
    this.logger?.debug?.(`${TAG} Generator created: model=${opts.model ?? "(default)"}, promptMode=${this.promptMode}, variant=${this.variant}, dataDir=${opts.dataDir}`);
  }

  /**
   * Execute local persona generation without advancing checkpoint.
   */
  async generateLocalPersona(triggerReason?: string): Promise<"generated" | "unchanged" | "failed"> {
    const startMs = Date.now();
    this.logger?.debug?.(`${TAG} Starting generation: reason="${triggerReason ?? "none"}"`);

    const cpManager = new CheckpointManager(this.dataDir, this.logger, this.storage);
    const cp = await cpManager.read();
    this.logger?.debug?.(`${TAG} Checkpoint: total_processed=${cp.total_processed}, last_persona_at=${cp.last_persona_at}`);

    const isProject = this.variant === "project";
    const targetFile = StoragePaths.persona;
    const targetLabel = isProject ? "project memory" : this.promptMode === "code" ? "team operating doctrine" : "persona";

    // 1. Read existing L3 document (strip navigation). Only a persona that
    // passed the user-global scope check is updated incrementally. Any other
    // persona may hold project facts, so it is not shown to the model and is
    // rewritten from all scenes. A project document has no scope check, so it
    // is always updated incrementally.
    let existingPersona: string | undefined;
    let existingRaw: string | null = null;
    let fullRewrite = false;
    try {
      if (this.storage) {
        existingRaw = await this.storage.readFile(targetFile);
      } else {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        existingRaw = await fs.default.readFile(path.default.join(this.dataDir, targetFile), "utf-8");
      }
      if (existingRaw) {
        const body = stripScopeMarkers(stripSceneNavigation(existingRaw)).trim();
        if (body && (isProject || readScopeState(existingRaw) === "accepted")) {
          existingPersona = body;
        } else if (body) {
          fullRewrite = true;
        }
      }
      this.logger?.debug?.(
        `${TAG} Existing ${targetLabel}: ${existingPersona ? `${existingPersona.length} chars` : "empty"}` +
        (fullRewrite ? " (no accepted scope marker; full rewrite from all scenes)" : ""),
      );
    } catch {
      this.logger?.debug?.(`${TAG} No existing ${targetFile} file`);
    }

    // 2. Load scene index + identify changed scenes
    const index = await readSceneIndex(this.dataDir, this.storage);
    const changedScenes = index.filter((e) => {
      if (fullRewrite || !cp.last_persona_time) return true;
      const updatedMs = new Date(e.updated).getTime();
      const personaMs = new Date(cp.last_persona_time).getTime();
      // If either date is unparseable (NaN), treat as changed (conservative)
      if (Number.isNaN(updatedMs) || Number.isNaN(personaMs)) return true;
      return updatedMs > personaMs;
    });
    this.logger?.debug?.(`${TAG} Scene index: ${index.length} total, ${changedScenes.length} changed since last persona`);

    // 3. Read changed scene contents (full raw content including META, matching Python reference)
    // The user-global run reads the scenes of every project, so a full rewrite
    // can see many scenes. Inline the most recently updated ones up to a size
    // budget and list the rest by name and summary, so the prompt cannot grow
    // past the model's context with the number of projects.
    const changedSceneContents: string[] = [];
    const omittedScenes: Array<{ filename: string; summary: string }> = [];
    let inlinedChars = 0;
    const byRecency = [...changedScenes].sort((a, b) => sceneTime(b.updated) - sceneTime(a.updated));
    for (const entry of byRecency) {
      if (inlinedChars >= MAX_INLINED_SCENE_CHARS) {
        omittedScenes.push({ filename: entry.filename, summary: entry.summary });
        continue;
      }
      try {
        let raw: string | null;
        if (this.storage) {
          raw = await this.storage.readFile(`${StoragePaths.sceneBlocksDir}${entry.filename}`);
        } else {
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          raw = await fs.default.readFile(path.default.join(this.dataDir, "scene_blocks", entry.filename), "utf-8");
        }
        if (!raw) continue;
        inlinedChars += raw.length;
        changedSceneContents.push(
          `### [${changedSceneContents.length + 1}] ${entry.filename}\n\n\`\`\`markdown\n${raw}\n\`\`\``,
        );
      } catch {
        this.logger?.warn(`${TAG} Could not read scene block: ${entry.filename}`);
      }
    }

    if (omittedScenes.length > 0) {
      this.logger?.warn(
        `${TAG} ${omittedScenes.length} changed scenes over the ${MAX_INLINED_SCENE_CHARS}-char budget are listed by summary only`,
      );
      changedSceneContents.push(
        `### 其余 ${omittedScenes.length} 个变化场景（仅摘要，超出单次篇幅上限）\n\n` +
          omittedScenes.map((e) => `- ${e.filename}${e.summary ? ` — ${e.summary}` : ""}`).join("\n"),
      );
    }

    if (changedSceneContents.length === 0 && existingPersona) {
      this.logger?.debug?.(`${TAG} No scene changes and persona exists, skipping generation`);
      return "unchanged";
    }

    // 4. Determine mode
    const mode = existingPersona ? "incremental" : "first";
    this.logger?.debug?.(`${TAG} Generation mode: ${mode}, ${changedSceneContents.length} scene blocks to process`);

    // 5. Build changed scenes section with guidance (matching Python reference format)
    let changedScenesContent: string;
    if (changedSceneContents.length > 0) {
      changedScenesContent =
        `\n\n## 📄 变化场景完整内容\n\n` +
        `*自上次 Persona 更新后，以下 ${changedSceneContents.length} 个场景发生了变化。工程已为你预加载完整内容：*\n\n` +
        changedSceneContents.join("\n\n") +
        `\n\n---\n\n` +
        `⚠️ **重点分析变化场景**：上述场景是自上次更新后的**新增/修改内容**，请**重点分析**这些场景中的新信息。\n`;
    } else {
      changedScenesContent = `\n\n⚠️ **无变化场景**：所有场景均已在上次 Persona 更新中分析过，本次可直接读取所有场景进行全局审视。\n`;
    }

    // 6. Build prompt
    const personaFilePath = this.storage
      ? targetFile
      : await (async () => { const path = await import("node:path"); return path.default.join(this.dataDir, targetFile); })();
    const checkpointPath = this.storage
      ? StoragePaths.checkpoint
      : await (async () => { const path = await import("node:path"); return path.default.join(this.dataDir, ".metadata", "recall_checkpoint.json"); })();

    const { systemPrompt: baseSystemPrompt, userPrompt } = buildPersonaPrompt({
      mode,
      promptMode: this.promptMode,
      variant: this.variant,
      currentTime: new Date().toISOString(),
      totalProcessed: cp.total_processed,
      sceneCount: index.length,
      changedSceneCount: changedScenes.length,
      changedScenesContent,
      existingPersona,
      triggerInfo: triggerReason,
      personaFilePath,
      checkpointPath,
    });
    const systemPrompt = composeMemorySystemPrompt(baseSystemPrompt, this.memoryPrompt);

    // 7. Backup before LLM run (LLM writes persona.md via tools)
    const bm = new BackupManager(this.storage
      ? undefined  // COS mode: BackupManager not used (TODO: adapt BackupManager for StorageAdapter)
      : await (async () => { const path = await import("node:path"); return path.default.join(this.dataDir, ".backup"); })()
    );
    if (!this.storage) {
      const path = await import("node:path");
      await bm.backupFile(path.default.join(this.dataDir, targetFile), "persona", `offset${cp.total_processed}`, this.backupCount);
    } else if (existingRaw) {
      await this.backupToStorage(existingRaw, `offset${cp.total_processed}`);
    }
    const personaWriteMarkerBefore = await readPersonaWriteMarker(
      this.dataDir,
      targetFile,
      this.storage,
    );

    // 8–10. Run the LLM (it writes the L3 file with tools), read and clean the
    // result, and check it for project facts. On a failed check, run once more
    // with the findings; then record the outcome in the scope marker. The
    // project variant skips the check: a project document may hold project
    // facts, and it is valid as written.
    const sceneHints = index.map((e) => ({ filename: e.filename, summary: e.summary }));
    const first = await this.writeAndRead({
      systemPrompt, userPrompt, targetFile, personaFilePath, startMs,
      fileExistedBefore: existingRaw !== null && existingRaw !== "",
      personaWriteMarkerBefore,
    });
    if (first === null) return "failed";
    let personaText = first;
    let scope: ScopeCheckResult = { ok: true, leaks: [] };
    if (!isProject) {
      scope = await checkUserGlobalPersona({ persona: personaText, sceneIndex: sceneHints, judge: this.scopeJudge! });
      if (!scope.ok) {
        this.logger?.warn(`${TAG} ${targetFile} failed the user-global scope check (${describeScopeFailure(scope)}); retrying once`);
        const markerBeforeRetry = await readPersonaWriteMarker(this.dataDir, targetFile, this.storage);
        const retried = await this.writeAndRead({
          systemPrompt,
          userPrompt: `${userPrompt}\n${scopeRetryInstruction(scope)}`,
          targetFile, personaFilePath, startMs,
          fileExistedBefore: true,
          personaWriteMarkerBefore: markerBeforeRetry,
        });
        if (retried !== null) {
          personaText = retried;
          scope = await checkUserGlobalPersona({ persona: personaText, sceneIndex: sceneHints, judge: this.scopeJudge! });
        }
      }
      if (scope.ok) {
        this.logger?.info(`${TAG} ${targetFile} passed the user-global scope check`);
      } else {
        this.logger?.warn(
          `${TAG} ${targetFile} failed the user-global scope check twice (${describeScopeFailure(scope)}); ` +
          `writing it with the rejected marker, so it is not injected`,
        );
      }
    }

    const personaUnchanged =
      scope.ok &&
      existingPersona !== undefined &&
      personaText === escapeXmlTags(existingPersona);

    // 11. Write the final content. The user-global persona gets its scope
    // marker and fresh scene navigation. The project document is written
    // clean: the model may have added a marker or navigation, and
    // writeAndRead already removed both.
    let finalContent: string;
    if (isProject) {
      finalContent = personaText;
    } else {
      const marker = scope.ok ? USER_GLOBAL_SCOPE_MARKER : USER_GLOBAL_REJECTED_MARKER;
      // The navigation is injected into sessions of every project, so it lists
      // user-global scenes only. Project scenes were read above to build the
      // persona, but their paths and summaries must not appear in another
      // project's session.
      const nav = generateSceneNavigation(index.filter((e) => !isProjectSceneFilename(e.filename)), undefined, false);
      const markedPersona = `${marker}\n${personaText}`;
      finalContent = nav ? `${markedPersona}\n\n${nav}\n` : markedPersona;
    }
    if (this.storage) {
      await this.storage.writeFile(targetFile, finalContent);
    } else {
      const fs = await import("node:fs/promises");
      await fs.default.writeFile(personaFilePath, finalContent, "utf-8");
    }

    const elapsedMs = Date.now() - startMs;
    this.logger?.info(`${TAG} ${targetFile} written (${finalContent.length} chars) in ${elapsedMs}ms`);

    // The persona metrics describe the user-global persona. A project document
    // would mix a different kind of text into the same series, so it is left out.
    // ── l3_persona_generation metric ──
    if (!isProject && this.instanceId && this.logger) {
      report("l3_persona_generation", {
        triggerReason: triggerReason ?? "unknown",
        mode: existingPersona ? "incremental" : "initial",
        newPersonaContent: personaText,
        newPersonaLength: personaText.length,
        totalDurationMs: elapsedMs,
        success: true,
        error: null,
      });
    }

    // ── 评测指标：L3 延迟 + 画像变化 ──
    if (!isProject) {
      try {
        reportL3LatencyMetrics({
          instanceId: this.instanceId ?? "",
          generationLatencyMs: elapsedMs,
          personaLengthBefore: existingPersona ? existingPersona.length : 0,
          personaLengthAfter: finalContent.length,
          personaTextBefore: existingPersona ?? "",
          personaTextAfter: personaText,
          hasError: false,
        });
      } catch {
        // 静默忽略
      }
    }

    return personaUnchanged ? "unchanged" : "generated";
  }

  /**
   * Run the tool-enabled LLM that writes the L3 file, then read the file and
   * return its cleaned body (navigation and scope markers removed, XML tags
   * escaped). Returns null when the run fails or writes nothing usable.
   */
  private async writeAndRead(args: {
    systemPrompt: string;
    userPrompt: string;
    targetFile: string;
    personaFilePath: string;
    startMs: number;
    /** The L3 file existed before this run, so an unchanged write marker means the LLM did not write it. */
    fileExistedBefore: boolean;
    personaWriteMarkerBefore: string | undefined;
  }): Promise<string | null> {
    const { systemPrompt, userPrompt, targetFile, personaFilePath, startMs, fileExistedBefore, personaWriteMarkerBefore } = args;
    try {
      this.logger?.debug?.(`${TAG} Calling LLM for ${targetFile} generation (timeout=180s, tools=enabled, workspaceDir=${this.dataDir})...`);
      // langfuse trace 语义：L3 persona 生成有独立 name / 顶级 user/session 列 / 可筛选 tags。
      const traceParams = buildTraceParams("memory.persona-generate", this.traceContext);
      await this.runner.run({
        systemPrompt,
        prompt: userPrompt,
        taskId: "persona-generation",
        timeoutMs: 180_000,
        // maxTokens omitted → core uses the resolved model's maxTokens from catalog
        workspaceDir: this.dataDir,
        // Service mode: LLM tools read/write via StorageAdapter (COS) instead of local FS
        storage: this.storage,
        storagePrefix: this.storage ? "" : undefined,
        ...traceParams,
      });
      this.logger?.debug?.(`${TAG} LLM runner completed`);
    } catch (err) {
      const elapsedMs = Date.now() - startMs;
      this.logger?.error(`${TAG} Persona generation failed after ${elapsedMs}ms: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return null;
    }
    const personaWriteMarkerAfter = await readPersonaWriteMarker(this.dataDir, targetFile, this.storage);

    let raw: string | null;
    try {
      if (this.storage) {
        raw = await this.storage.readFile(targetFile);
      } else {
        const fs = await import("node:fs/promises");
        raw = await fs.default.readFile(personaFilePath, "utf-8");
      }
      if (!raw) throw new Error(`${targetFile} not found`);
    } catch {
      // LLM failed to write persona.md — treat as failure
      this.logger?.error(`${TAG} LLM did not write ${targetFile} — file not found after runner completed`);
      return null;
    }
    if (fileExistedBefore && personaWriteMarkerBefore && personaWriteMarkerAfter === personaWriteMarkerBefore) {
      this.logger?.error(`${TAG} LLM completed without writing ${targetFile}; preserving checkpoint for retry`);
      return null;
    }

    // Strip any navigation or scope marker the LLM might have added + sanitize for safe injection
    const personaText = escapeXmlTags(stripScopeMarkers(stripSceneNavigation(raw)).trim());
    if (!personaText) {
      this.logger?.error(`${TAG} LLM wrote empty ${targetFile} — skipping`);
      return null;
    }
    return personaText;
  }

  /**
   * Keep a copy of the current L3 file before the LLM overwrites it, in storage
   * mode (COS / row view). `.backup/` keys route to the non-profile backend.
   * Keeps the newest `backupCount` copies.
   */
  private async backupToStorage(content: string, tag: string): Promise<void> {
    if (!this.storage) return;
    const dir = ".backup/persona/";
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await this.storage.writeFile(`${dir}${stamp}-${tag}.md`, content);
      const names = (await this.storage.readdirNames(dir, ".md")).sort();
      for (const old of names.slice(0, Math.max(0, names.length - this.backupCount))) {
        await this.storage.unlink(`${dir}${old}`);
      }
    } catch (err) {
      this.logger?.warn(`${TAG} persona backup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Backward-compatible wrapper: local generation + checkpoint advance.
   */
  async generate(triggerReason?: string): Promise<boolean> {
    const result = await this.generateLocalPersona(triggerReason);
    if (result !== "generated") return false;

    const cpManager = new CheckpointManager(this.dataDir, this.logger, this.storage);
    const cp = await cpManager.read();
    await cpManager.markPersonaGenerated(cp.total_processed);
    return true;
  }
}

async function readPersonaWriteMarker(
  dataDir: string,
  targetFile: string,
  storage?: StorageAdapter,
): Promise<string | undefined> {
  try {
    if (storage) {
      const stat = await storage.stat(targetFile);
      return stat ? `${stat.size}:${stat.lastModified}` : undefined;
    }
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const stat = await fs.default.stat(path.default.join(dataDir, targetFile));
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

function describeScopeFailure(scope: ScopeCheckResult): string {
  return scope.leaks.length > 0 ? `${scope.reason}: ${scope.leaks.slice(0, 10).join(", ")}` : String(scope.reason);
}

/** Extra user-prompt section for the second attempt after a failed scope check. */
function scopeRetryInstruction(scope: ScopeCheckResult): string {
  const items = scope.leaks.length > 0
    ? scope.leaks.map((l) => `- ${l}`).join("\n")
    : "- （检查未能完成：请确认全文不含任何项目、产品、工具名、文件、版本或当前任务）";
  return (
    `\n## ⛔ 作用域检查未通过\n\n` +
    `persona.md 会注入到用户所有项目的会话中，因此只能包含跨项目成立的内容。` +
    `当前 persona.md 含有以下项目相关内容，必须删除或改写成不含具体名称的通用描述，其余内容保持不变：\n\n` +
    `${items}\n`
  );
}

/**
 * Character budget for scene text inlined into one persona prompt (about 20k
 * tokens). Scenes past it are listed by summary only.
 */
export const MAX_INLINED_SCENE_CHARS = 80_000;

function sceneTime(updated: string): number {
  const ms = new Date(updated).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}
