// The SQLite cache of open + recently-closed issues and merge requests
// across tracked projects. The panel, mentions, and CLI read it; the sync
// and mutations write it.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { CachedItem } from "./items";

export interface ListItemsOptions {
  kind?: "issue" | "mr";
  project?: string;
  query?: string;
  /** "open" → opened only; "closed" → everything else (closed, merged). */
  state?: "open" | "closed";
}

export interface ItemCache {
  list(options: ListItemsOptions): CachedItem[];
  get(kind: "issue" | "mr", project: string, iid: number): CachedItem | null;
  /** Replaces every row of one project with a fresh sync. */
  replaceProject(project: string, items: CachedItem[]): void;
  /** Drops rows of projects no longer tracked. */
  retainProjects(projects: readonly string[]): void;
  /** Patches a row in place after a mutation, ahead of the next sync. */
  patch(
    kind: "issue" | "mr",
    project: string,
    iid: number,
    changes: { state?: string; assignees?: string[]; labels?: string[] },
  ): void;
  /** Cheap change detection, so idle syncs don't wake every panel. */
  fingerprint(): string;
}

export function createItemCache(storage: BbPluginApi["storage"]): ItemCache {
  const db = storage.database();
  storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS items (
       project TEXT NOT NULL,
       iid INTEGER NOT NULL,
       kind TEXT NOT NULL,
       title TEXT NOT NULL,
       state TEXT NOT NULL,
       draft INTEGER NOT NULL DEFAULT 0,
       author TEXT NOT NULL,
       labels TEXT NOT NULL,
       assignees TEXT NOT NULL DEFAULT '[]',
       url TEXT NOT NULL,
       body TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       PRIMARY KEY (project, kind, iid)
     )`,
  ]);

  const cachedStringArraySchema = z.array(z.string()).catch([]);

  function rowToItem(row: Record<string, unknown>): CachedItem {
    return {
      project: String(row.project),
      iid: Number(row.iid),
      kind: row.kind === "mr" ? "mr" : "issue",
      title: String(row.title),
      state: String(row.state),
      draft: Number(row.draft) === 1,
      author: String(row.author),
      // Written by this plugin, but a corrupt row must not fail the list.
      labels: cachedStringArraySchema.parse(JSON.parse(String(row.labels))),
      assignees: cachedStringArraySchema.parse(
        JSON.parse(String(row.assignees)),
      ),
      url: String(row.url),
      body: String(row.body),
      updatedAt: String(row.updated_at),
    };
  }

  function list(options: ListItemsOptions): CachedItem[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.project !== undefined) {
      clauses.push("project = ?");
      params.push(options.project);
    }
    if (options.state === "open") {
      clauses.push("state = 'opened'");
    } else if (options.state === "closed") {
      clauses.push("state != 'opened'");
    }
    const query = options.query?.trim() ?? "";
    if (query.length > 0) {
      clauses.push(
        "(title LIKE ? OR CAST(iid AS TEXT) LIKE ? OR project LIKE ?)",
      );
      const like = `%${query.replace(/^[#!]/, "")}%`;
      params.push(like, like, like);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db
      .prepare(`SELECT * FROM items ${where} ORDER BY updated_at DESC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(rowToItem);
  }

  function get(
    kind: "issue" | "mr",
    project: string,
    iid: number,
  ): CachedItem | null {
    const row = db
      .prepare("SELECT * FROM items WHERE project = ? AND kind = ? AND iid = ?")
      .get(project, kind, iid) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToItem(row);
  }

  function replaceProject(project: string, items: CachedItem[]): void {
    const insert = db.prepare(
      `INSERT INTO items (project, iid, kind, title, state, draft, author, labels, assignees, url, body, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      db.prepare("DELETE FROM items WHERE project = ?").run(project);
      for (const item of items) {
        insert.run(
          item.project,
          item.iid,
          item.kind,
          item.title,
          item.state,
          item.draft ? 1 : 0,
          item.author,
          JSON.stringify(item.labels),
          JSON.stringify(item.assignees),
          item.url,
          item.body,
          item.updatedAt,
        );
      }
    })();
  }

  function patch(
    kind: "issue" | "mr",
    project: string,
    iid: number,
    changes: { state?: string; assignees?: string[]; labels?: string[] },
  ): void {
    if (changes.state !== undefined) {
      db.prepare(
        "UPDATE items SET state = ? WHERE project = ? AND kind = ? AND iid = ?",
      ).run(changes.state, project, kind, iid);
    }
    if (changes.assignees !== undefined) {
      db.prepare(
        "UPDATE items SET assignees = ? WHERE project = ? AND kind = ? AND iid = ?",
      ).run(JSON.stringify(changes.assignees), project, kind, iid);
    }
    if (changes.labels !== undefined) {
      db.prepare(
        "UPDATE items SET labels = ? WHERE project = ? AND kind = ? AND iid = ?",
      ).run(JSON.stringify(changes.labels), project, kind, iid);
    }
  }

  function retainProjects(projects: readonly string[]): void {
    if (projects.length === 0) {
      db.prepare("DELETE FROM items").run();
    } else {
      db.prepare(
        `DELETE FROM items WHERE project NOT IN (${projects.map(() => "?").join(",")})`,
      ).run(...projects);
    }
  }

  const fingerprintQuery = db.prepare(
    "SELECT project, kind, iid, state, updated_at FROM items ORDER BY project, kind, iid",
  );

  return {
    list,
    get,
    replaceProject,
    retainProjects,
    patch,
    fingerprint: () => JSON.stringify(fingerprintQuery.all()),
  };
}
