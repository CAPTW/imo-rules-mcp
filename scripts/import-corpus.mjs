#!/usr/bin/env node
/**
 * Populate ./corpus/ from a built KRcrawl package so the MCP server can serve it.
 *
 * Usage:
 *   node scripts/import-corpus.mjs <path-to-KRcrawl-repo>
 *   IMO_SOURCE=<path-to-KRcrawl-repo> node scripts/import-corpus.mjs
 *
 * Copies (nothing is fetched from the network):
 *   <src>/data/krcon.sqlite                    -> corpus/imo-corpus.sqlite
 *   <src>/dist/help/full-clone/toc.json        -> corpus/toc.json
 *   <src>/dist/help/full-clone/assets/rag/**   -> corpus/rag/**   (vectors, meta, config, model)
 *
 * The corpus is your own licensed data; it stays local (corpus/ is gitignored).
 */
import { cpSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const src = resolve(process.argv[2] ?? process.env.IMO_SOURCE ?? "");

if (src === "" || !existsSync(src)) {
  console.error("Pass the path to your built KRcrawl repo:\n  node scripts/import-corpus.mjs <path-to-KRcrawl-repo>");
  process.exit(1);
}

const dbSrc = join(src, "data", "krcon.sqlite");
const tocSrc = join(src, "dist", "help", "full-clone", "toc.json");
const ragSrc = join(src, "dist", "help", "full-clone", "assets", "rag");
for (const [p, name] of [[dbSrc, "DB"], [tocSrc, "toc.json"], [ragSrc, "rag index"]]) {
  if (!existsSync(p)) {
    console.error(`Missing ${name} at ${p}. Build the KRcrawl package first (export:full-help + rag:index).`);
    process.exit(1);
  }
}

const corpus = join(repo, "corpus");
mkdirSync(corpus, { recursive: true });
console.log("Copying corpus (this includes a ~266 MB model and the SQLite DB; may take a moment)…");
copyFileSync(dbSrc, join(corpus, "imo-corpus.sqlite"));
copyFileSync(tocSrc, join(corpus, "toc.json"));
cpSync(ragSrc, join(corpus, "rag"), { recursive: true });
console.log(`Done. corpus/ populated under ${corpus}.`);
console.log("Start the server with:  npm start   (or wire it into your MCP client — see README)");
