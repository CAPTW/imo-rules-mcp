/**
 * IMO maritime rules MCP server (stdio).
 *
 * Exposes a local corpus of IMO rules & regulations, backed by the SQLite corpus
 * plus an offline semantic-search index, as MCP tools so compatible local clients
 * can search and read the regulations:
 *
 *   imo_semantic_search  meaning-based search (local embeddings, per locale)
 *   imo_keyword_search   substring search over titles + body text
 *   imo_get_document     full normalized text of one regulation + citations
 *   imo_list_instruments top-level instruments (SOLAS, MARPOL, etc.)
 *   imo_browse           navigate the instrument/chapter/regulation tree
 *   imo_get_citations    cross-references out of one document
 *   imo_stats            corpus overview
 *
 * Read-only and offline; it serves a local corpus you provide. The corpus is
 * NOT bundled in this repository; point IMO_DB / IMO_RAG at your own copy (see
 * README), or place it under ./corpus/.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { env, pipeline } from "@huggingface/transformers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DB_PATH = resolve(process.env.IMO_DB ?? join("corpus", "imo-corpus.sqlite"));
const RAG_DIR = resolve(process.env.IMO_RAG ?? join("corpus", "rag"));
const ROOT_KEY = process.env.IMO_ROOT_KEY ?? "0000.00e0";

if (!existsSync(DB_PATH)) {
  process.stderr.write(
    `imo-rules-mcp: corpus DB not found at ${DB_PATH}. Set IMO_DB or run the setup (see README).\n`
  );
  process.exit(1);
}
const db = new Database(DB_PATH, { readonly: true });

// Genericize source-specific labels in any human-facing title/breadcrumb.
function label(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/KR-?CON/gi, "IMO Rules")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- DB statements (document text + citations only) ---------------------
const findVersion = db.prepare(
  `SELECT dlv.document_version_id AS vid, d.title AS title,
          COALESCE(NULLIF(d.source_tree_key, ''), d.external_id) AS key, dlv.source_url AS sourceUrl
   FROM documents d
   JOIN document_locale_variants dlv ON dlv.document_id = d.id
   WHERE (d.external_id = @key OR d.source_tree_key = @key OR dlv.source_tree_key = @key)
     AND dlv.locale = @locale AND dlv.document_version_id IS NOT NULL
   LIMIT 1`
);
const versionText = db.prepare(
  `SELECT text_norm AS t FROM document_nodes
   WHERE document_version_id = ? AND TRIM(COALESCE(text_norm, '')) <> ''
   ORDER BY path_key, ord`
);
const versionCitations = db.prepare(
  `SELECT text_raw AS text, href, target_text AS target FROM citations
   WHERE document_version_id = ? ORDER BY ord`
);

// ---- final tree comes from the exported toc.json ------------------------
const TOC_PATH = resolve(process.env.IMO_TOC ?? join(RAG_DIR, "..", "toc.json"));
interface TocItem {
  sourceTreeKey: string;
  parentSourceTreeKey: string | null;
  titles?: Record<string, string | undefined>;
  pages?: Record<string, string | undefined>;
}
interface TocModel {
  byKey: Map<string, TocItem>;
  childrenByParent: Map<string, TocItem[]>;
  pageToKey: Map<string, string>;
}
let tocModel: TocModel | null = null;
function loadToc(): TocModel {
  if (tocModel !== null) {
    return tocModel;
  }
  const byKey = new Map<string, TocItem>();
  const childrenByParent = new Map<string, TocItem[]>();
  const pageToKey = new Map<string, string>();
  try {
    const toc = JSON.parse(readFileSync(TOC_PATH, "utf8")) as { items?: TocItem[] };
    for (const item of toc.items ?? []) {
      byKey.set(item.sourceTreeKey, item);
      const parent = item.parentSourceTreeKey ?? "";
      const bucket = childrenByParent.get(parent);
      if (bucket === undefined) {
        childrenByParent.set(parent, [item]);
      } else {
        bucket.push(item);
      }
      for (const locale of ["en", "ko"]) {
        const pagePath = item.pages?.[locale];
        if (pagePath !== undefined) {
          pageToKey.set(pagePath, item.sourceTreeKey);
        }
      }
    }
  } catch {
    /* toc.json optional; tree tools then return empty */
  }
  tocModel = { byKey, childrenByParent, pageToKey };
  return tocModel;
}
function titleFor(item: TocItem, locale: string): string {
  const other = locale === "en" ? "ko" : "en";
  return label(item.titles?.[locale] ?? item.titles?.[other] ?? item.sourceTreeKey);
}
function breadcrumbs(key: string, locale: string): string[] {
  const { byKey } = loadToc();
  const trail: string[] = [];
  let cursor: string | null = key;
  let guard = 0;
  while (cursor !== null && guard < 32) {
    const item = byKey.get(cursor);
    if (item === undefined) {
      break;
    }
    trail.unshift(titleFor(item, locale));
    cursor = item.parentSourceTreeKey;
    guard += 1;
  }
  return trail;
}
function childrenOf(parentKey: string, locale: string): Array<{ key: string; title: string; isDocument: boolean }> {
  const { childrenByParent } = loadToc();
  return (childrenByParent.get(parentKey) ?? []).map((item) => ({
    key: item.sourceTreeKey,
    title: titleFor(item, locale),
    isDocument: item.pages?.[locale] !== undefined
  }));
}

// ---- lazy semantic-search index + embedding model -----------------------
interface RagIndex {
  cfg: { count: number; dim: number; dtype: string; model: string; queryPrefix: string };
  meta: Array<{ breadcrumbs: string[]; locale: string; pagePath: string; snippet: string; title: string }>;
  vectors: Float32Array;
}
let ragIndex: RagIndex | null = null;
function loadRag(): RagIndex {
  if (ragIndex !== null) {
    return ragIndex;
  }
  const cfgPath = join(RAG_DIR, "config.json");
  if (!existsSync(cfgPath)) {
    throw new Error(`Semantic-search index not found at ${RAG_DIR}. See README to build/point it.`);
  }
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const meta = JSON.parse(readFileSync(join(RAG_DIR, "meta.json"), "utf8"));
  const buf = readFileSync(join(RAG_DIR, "vectors.f32"));
  const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  ragIndex = { cfg, meta, vectors };
  return ragIndex;
}
let extractorPromise: Promise<unknown> | null = null;
async function embedQuery(text: string): Promise<number[]> {
  const rag = loadRag();
  if (extractorPromise === null) {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = resolve(RAG_DIR, "models") + "/";
    extractorPromise = pipeline("feature-extraction", rag.cfg.model, { dtype: rag.cfg.dtype as "q8" });
  }
  const extractor = (await extractorPromise) as (
    input: string[],
    opts: { pooling: string; normalize: boolean }
  ) => Promise<{ tolist: () => number[][] }>;
  const out = await extractor([rag.cfg.queryPrefix + text], { pooling: "mean", normalize: true });
  return out.tolist()[0] ?? [];
}

function asText(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

// ---- server + tools -----------------------------------------------------
const server = new McpServer({ name: "imo-rules", version: "1.0.0" });

server.registerTool(
  "imo_semantic_search",
  {
    description:
      "Meaning-based search over the IMO rules & regulations corpus (SOLAS, MARPOL, STCW, the codes, etc.). Returns the most relevant regulations for the query in the chosen locale, ranked by semantic similarity, each with its instrument/chapter breadcrumb, a snippet, and a docKey usable with imo_get_document.",
    inputSchema: {
      query: z.string().describe("natural-language query, e.g. 'oil discharge limits from tankers'"),
      locale: z.enum(["en", "ko"]).default("en"),
      limit: z.number().int().min(1).max(30).default(8)
    }
  },
  async ({ query, locale, limit }) => {
    const rag = loadRag();
    const qv = await embedQuery(query);
    const dim = rag.cfg.dim;
    const scored: Array<{ score: number; m: RagIndex["meta"][number] }> = [];
    for (let i = 0; i < rag.meta.length; i += 1) {
      const m = rag.meta[i];
      if (m === undefined || m.locale !== locale) {
        continue;
      }
      let dot = 0;
      const off = i * dim;
      for (let d = 0; d < dim; d += 1) {
        dot += (qv[d] ?? 0) * (rag.vectors[off + d] ?? 0);
      }
      scored.push({ score: dot, m });
    }
    scored.sort((a, b) => b.score - a.score);
    const keyMap = loadToc().pageToKey;
    const results = scored.slice(0, limit).map(({ score, m }) => ({
      score: Math.round(score * 1000) / 1000,
      title: label(m.title),
      breadcrumbs: (m.breadcrumbs ?? []).map(label),
      snippet: m.snippet,
      docKey: keyMap.get(m.pagePath) ?? m.pagePath
    }));
    return asText(results);
  }
);

server.registerTool(
  "imo_keyword_search",
  {
    description:
      "Substring keyword search over document titles (and optionally body text). Use for exact terms, regulation numbers, or instrument names. Prefer imo_semantic_search for conceptual questions.",
    inputSchema: {
      query: z.string(),
      locale: z.enum(["en", "ko"]).default("en"),
      searchBody: z.boolean().default(false).describe("also match inside document body text (slower)"),
      limit: z.number().int().min(1).max(50).default(15)
    }
  },
  ({ query, locale, searchBody, limit }) => {
    const like = `%${query}%`;
    const sql = searchBody
      ? `SELECT DISTINCT COALESCE(NULLIF(d.source_tree_key,''),d.external_id) AS key, d.title AS title
         FROM documents d
         JOIN document_locale_variants dlv ON dlv.document_id = d.id AND dlv.locale = @locale AND dlv.document_version_id IS NOT NULL
         LEFT JOIN document_nodes n ON n.document_version_id = dlv.document_version_id
         WHERE d.title LIKE @like OR n.text_norm LIKE @like LIMIT @limit`
      : `SELECT COALESCE(NULLIF(d.source_tree_key,''),d.external_id) AS key, d.title AS title
         FROM documents d
         JOIN document_locale_variants dlv ON dlv.document_id = d.id AND dlv.locale = @locale AND dlv.document_version_id IS NOT NULL
         WHERE d.title LIKE @like LIMIT @limit`;
    const rows = db.prepare(sql).all({ locale, like, limit }) as Array<{ key: string; title: string }>;
    return asText(rows.map((r) => ({ docKey: r.key, title: r.title })));
  }
);

server.registerTool(
  "imo_get_document",
  {
    description:
      "Get the full normalized text of one regulation/document by its docKey (from a search result) in the chosen locale, with its instrument/chapter breadcrumb and outbound citations.",
    inputSchema: { docKey: z.string(), locale: z.enum(["en", "ko"]).default("en") }
  },
  ({ docKey, locale }) => {
    const ver = findVersion.get({ key: docKey, locale }) as
      | { vid: number; title: string; key: string; sourceUrl: string | null }
      | undefined;
    if (ver === undefined) {
      return asText(`No ${locale} document found for key "${docKey}".`);
    }
    const text = (versionText.all(ver.vid) as Array<{ t: string }>).map((r) => r.t).join("\n");
    const citations = (versionCitations.all(ver.vid) as Array<{ text: string; target: string | null }>)
      .map((c) => c.target ?? c.text)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .slice(0, 60);
    return asText({
      docKey: ver.key,
      title: ver.title,
      breadcrumbs: breadcrumbs(ver.key, locale),
      sourceUrl: ver.sourceUrl,
      citations,
      text: text.length > 60000 ? text.slice(0, 60000) + "\n…(truncated)" : text
    });
  }
);

server.registerTool(
  "imo_list_instruments",
  {
    description: "List the top-level instruments in the corpus (SOLAS, MARPOL, STCW, the codes, etc.) for the given locale.",
    inputSchema: { locale: z.enum(["en", "ko"]).default("en") }
  },
  ({ locale }) => asText(childrenOf(ROOT_KEY, locale))
);

server.registerTool(
  "imo_browse",
  {
    description:
      "List the child nodes (sub-folders and documents) of a tree node, to navigate the instrument → chapter → regulation hierarchy. Omit parentKey to start at the root.",
    inputSchema: { parentKey: z.string().default(ROOT_KEY), locale: z.enum(["en", "ko"]).default("en") }
  },
  ({ parentKey, locale }) => asText(childrenOf(parentKey, locale))
);

server.registerTool(
  "imo_get_citations",
  {
    description: "List the outbound cross-references (citations) from one document.",
    inputSchema: { docKey: z.string(), locale: z.enum(["en", "ko"]).default("en") }
  },
  ({ docKey, locale }) => {
    const ver = findVersion.get({ key: docKey, locale }) as { vid: number } | undefined;
    if (ver === undefined) {
      return asText(`No ${locale} document found for key "${docKey}".`);
    }
    const cites = (versionCitations.all(ver.vid) as Array<{ text: string; href: string | null; target: string | null }>).map(
      (c) => ({ text: c.target ?? c.text, href: c.href })
    );
    return asText(cites);
  }
);

server.registerTool(
  "imo_stats",
  { description: "Corpus overview: locale document counts and top-level instrument count.", inputSchema: {} },
  () => {
    const variant = (locale: string): number =>
      (db.prepare(`SELECT COUNT(*) c FROM document_locale_variants WHERE locale=? AND document_version_id IS NOT NULL`).get(locale) as { c: number }).c;
    return asText({
      enDocuments: variant("en"),
      koDocuments: variant("ko"),
      topLevelInstruments: childrenOf(ROOT_KEY, "en").length
    });
  }
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  process.stderr.write(`imo-rules-mcp ready (db=${DB_PATH})\n`);
}
main().catch((error) => {
  process.stderr.write(`imo-rules-mcp failed: ${String(error)}\n`);
  process.exit(1);
});
