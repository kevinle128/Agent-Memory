/**
 * Project of one buffered skill task.
 *
 * A task may only be extracted when all of its rounds belong to one project.
 * The rule is the same as for L1 memories (`resolveUnanimousProject`): any
 * doubt gives "no exactly one project", so a skill is never saved under a
 * wrong project.
 */

import { resolveUnanimousProject } from "../../record/l1-project.js";

/** A project label as carried by a buffered message or an L0 row. */
export interface ProjectLabel {
  projectKey?: string;
  projectHash?: string;
  projectName?: string;
}

/** The one project of a task. */
export interface TaskProject {
  projectKey: string;
  projectHash: string;
  /** Empty when no round carried a name. */
  projectName: string;
}

export type TaskProjectResolution =
  | { kind: "project"; project: TaskProject }
  /** Every round is known to have no project, or there is no round. */
  | { kind: "none" }
  /** Rounds name different projects, or only some of them name one. */
  | { kind: "mixed" }
  /** The task was buffered before project labels existed. */
  | { kind: "unlabeled" };

/** A resolution that does not need the L0 fallback. */
export type PlacedTaskProject = Exclude<TaskProjectResolution, { kind: "unlabeled" }>;

/** Decide "one project", "none" or "mixed" from a list of labels. */
export function classifyProjectLabels(labels: readonly ProjectLabel[]): PlacedTaskProject {
  if (labels.length === 0) return { kind: "none" };
  if (labels.every((l) => !l.projectHash && !l.projectKey)) return { kind: "none" };
  const unanimous = resolveUnanimousProject(labels);
  if (!unanimous.projectHash) return { kind: "mixed" };
  const projectName = labels.find((l) => l.projectName)?.projectName ?? "";
  return { kind: "project", project: { ...unanimous, projectName } };
}

/**
 * Resolve the project of an archived buffer from the labels on its messages.
 *
 * A message written by a current proxy always has a `project_hash` (empty for
 * "no project"). A message without the field was buffered earlier, so the
 * buffer cannot say which project it belongs to: the caller must look at the
 * L0 rows of the session instead.
 */
export function resolveBufferedProject(
  messages: ReadonlyArray<Record<string, unknown>>,
): TaskProjectResolution {
  if (messages.length === 0) return { kind: "none" };
  if (messages.some((m) => typeof m.project_hash !== "string")) return { kind: "unlabeled" };
  return classifyProjectLabels(
    messages.map((m) => ({
      projectKey: typeof m.project_key === "string" ? m.project_key : "",
      projectHash: m.project_hash as string,
      projectName: typeof m.project_name === "string" ? m.project_name : "",
    })),
  );
}
