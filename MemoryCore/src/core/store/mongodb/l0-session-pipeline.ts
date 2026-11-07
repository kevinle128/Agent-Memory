/**
 * Aggregation pipelines for the L0 session list on MongoDB.
 *
 * The pipelines are pure data so that a test can run them on a plain `mongod`
 * (the full store needs mongot for `$search`, which a plain server lacks).
 */

import type { Document } from "mongodb";
import { L0_SESSION_PREVIEW_CHARS, type L0SessionSummary } from "../types.js";

/** Shape of one `page` row that `buildL0SessionListPipeline` returns. */
export interface L0SessionGroupDoc {
  _id: string;
  first_ts: number;
  last_ts: number;
  message_count: number;
  /** Earliest user message. `$min` skips the missing values of non-user rows. */
  first_user?: { ts: number; text: string };
  /** Latest message that has a project. */
  last_project?: { ts: number; key: string; hash: string; name: string };
}

/**
 * Group the L0 rows that match `match` by session id, sort the groups by
 * last message time (newest first) and return one page plus the total.
 *
 * `$min` / `$max` on a sub-document compare the fields in order, so `ts`
 * decides. Both accumulators ignore missing values, which lets one pass find
 * the first user message and the last project without `$push` of all rows.
 */
export function buildL0SessionListPipeline(match: Document, limit: number, offset: number): Document[] {
  return [
    { $match: match },
    {
      $group: {
        _id: "$session_id",
        first_ts: { $min: "$timestamp" },
        last_ts: { $max: "$timestamp" },
        message_count: { $sum: 1 },
        first_user: {
          $min: {
            $cond: [
              { $eq: ["$role", "user"] },
              {
                ts: "$timestamp",
                text: { $substrCP: [{ $ifNull: ["$message_text", ""] }, 0, L0_SESSION_PREVIEW_CHARS] },
              },
              "$$REMOVE",
            ],
          },
        },
        last_project: {
          $max: {
            $cond: [
              { $gt: [{ $ifNull: ["$project_hash", ""] }, ""] },
              {
                ts: "$timestamp",
                key: { $ifNull: ["$project_key", ""] },
                hash: "$project_hash",
                name: { $ifNull: ["$project_name", ""] },
              },
              "$$REMOVE",
            ],
          },
        },
      },
    },
    { $sort: { last_ts: -1, _id: 1 } },
    {
      $facet: {
        total: [{ $count: "n" }],
        page: [{ $skip: offset }, { $limit: limit }],
      },
    },
  ];
}

/** Count L1 rows per session id inside a scope. `scope` must not hold a time range. */
export function buildL1CountBySessionPipeline(scope: Document, sessionIds: string[]): Document[] {
  return [
    { $match: { ...scope, session_id: { $in: sessionIds } } },
    { $group: { _id: "$session_id", n: { $sum: 1 } } },
  ];
}

/** Map one group row to the public summary. `l1Counts` maps session id to L1 count. */
export function toL0SessionSummary(doc: L0SessionGroupDoc, l1Counts: Map<string, number>): L0SessionSummary {
  const sessionId = String(doc._id ?? "");
  return {
    session_id: sessionId,
    first_ts: Number(doc.first_ts ?? 0),
    last_ts: Number(doc.last_ts ?? 0),
    message_count: Number(doc.message_count ?? 0),
    first_user_message: doc.first_user?.text ?? "",
    project_key: doc.last_project?.key ?? "",
    project_hash: doc.last_project?.hash ?? "",
    project_name: doc.last_project?.name ?? "",
    l1_count: l1Counts.get(sessionId) ?? 0,
  };
}
