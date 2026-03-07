import pg from "pg";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { encodeToToon } from "./toon.js";
import { log } from "./log.js";

const EXCLUDED_TABLES = new Set(["messages", "compactions"]);
const TEXT_LIKE_TYPES = new Set(["text", "varchar", "character", "character varying"]);
const LIMIT_DEFAULT = 10;
const LIMIT_MAX = 20;

interface ColumnRow {
  table_name: string;
  column_name: string;
  has_created_at: boolean;
}

interface TableResult {
  tableName: string;
  matchCount: number;
  rows: Record<string, unknown>[];
}

export function createSearchTool(pool: pg.Pool): AgentTool {
  return {
    name: "db_search",
    label: "Search",
    description: "Search all database tables for a text string. Searches across all text columns in all tables.",
    parameters: Type.Object({
      query: Type.String({ description: "The text to search for" }),
      limit: Type.Optional(
        Type.Integer({
          description: `Maximum number of rows to return per table. Default: ${LIMIT_DEFAULT}, max: ${LIMIT_MAX}.`,
          default: LIMIT_DEFAULT,
        }),
      ),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { query, limit: rawLimit } = params as { query: string; limit?: number };
      const limit = Math.min(LIMIT_MAX, Math.max(1, rawLimit ?? LIMIT_DEFAULT));

      const columnsResult = await pool.query<ColumnRow>(
        `SELECT
           c.table_name,
           c.column_name,
           EXISTS (
             SELECT 1
             FROM information_schema.columns c2
             WHERE c2.table_schema = 'public'
               AND c2.table_name = c.table_name
               AND c2.column_name = 'created_at'
           ) AS has_created_at
         FROM information_schema.columns c
         WHERE c.table_schema = 'public'
           AND c.data_type = ANY($1)
         ORDER BY c.table_name, c.column_name`,
        [Array.from(TEXT_LIKE_TYPES)],
      );

      // Group text-like columns by table, skipping excluded tables.
      const tableColumns = new Map<string, string[]>();
      const tableHasCreatedAt = new Map<string, boolean>();
      for (const row of columnsResult.rows) {
        if (EXCLUDED_TABLES.has(row.table_name)) {
          continue;
        }
        const columns = tableColumns.get(row.table_name) ?? [];
        columns.push(row.column_name);
        tableColumns.set(row.table_name, columns);
        tableHasCreatedAt.set(row.table_name, row.has_created_at);
      }

      const tableResults: TableResult[] = [];

      for (const [tableName, columns] of tableColumns) {
        // Build a tsvector expression that concatenates all text columns.
        const tsvectorExpr = columns
          .map((column) => `coalesce("${column}", '')`)
          .join(" || ' ' || ");

        const orderClause = tableHasCreatedAt.get(tableName) === true
          ? `ORDER BY "created_at" DESC`
          : "";

        const searchQuery = `
          SELECT *
          FROM "${tableName}"
          WHERE to_tsvector('english', ${tsvectorExpr}) @@ plainto_tsquery('english', $1)
          ${orderClause}
          LIMIT ${limit}
        `;

        const searchResult = await pool.query(searchQuery, [query]);

        if (searchResult.rows.length > 0) {
          tableResults.push({
            tableName,
            matchCount: searchResult.rows.length,
            rows: searchResult.rows as Record<string, unknown>[],
          });
          log.debug(`[stavrobot] search: table "${tableName}" returned ${searchResult.rows.length} match(es)`);
        }
      }

      if (tableResults.length === 0) {
        const noResultsMessage = `No results found for "${query}".`;
        log.debug("[stavrobot] search: no results found");
        return {
          content: [{ type: "text" as const, text: noResultsMessage }],
          details: { result: noResultsMessage },
        };
      }

      const parts: string[] = [];
      for (const tableResult of tableResults) {
        parts.push(`Table: ${tableResult.tableName} (${tableResult.matchCount} match(es))`);
        parts.push(encodeToToon(tableResult.rows));
      }
      const result = parts.join("\n\n");

      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}
