# imo-rules-mcp

An **MCP server** that exposes a local corpus of **IMO maritime rules & regulations**
(SOLAS, MARPOL, STCW, the codes, …) to AI clients (Claude Code, Claude Desktop, Cursor, any
MCP host) for **offline semantic search and reading**. No crawler, no network — it serves a
local corpus you provide.

## ⚠️ Bring your own corpus (important)

This repository contains **only the server code**. It does **not** include any regulation
text. The IMO rules & regulations corpus is **copyrighted** by its rights holders and is
licensed to you separately — **do not commit it to a public repository or redistribute it.**
The `corpus/` directory is gitignored for this reason. If you choose to bundle a corpus into
a repo for convenience, **keep that repository private.**

## What you provide

A corpus directory (default `./corpus/`) containing:

```
corpus/
  imo-corpus.sqlite     # the SQLite corpus (documents, nodes, citations)
  toc.json              # the final navigation tree (instruments → chapters → regulations)
  rag/
    config.json
    meta.json
    vectors.f32         # one embedding per page
    models/…            # the local embedding model (q8 ONNX)
```

This layout is produced by the companion **KRcrawl** exporter (`export:full-help` +
`rag:index`). Import it with:

```bash
npm install
node scripts/import-corpus.mjs /path/to/KRcrawl     # copies DB + toc.json + rag/ into ./corpus
```

Or skip the copy and point the server at an existing build with env vars (below).

## Tools

| Tool | What it does |
|---|---|
| `imo_semantic_search` | Meaning-based search → ranked regulations w/ instrument breadcrumb, snippet, `docKey`. |
| `imo_keyword_search` | Substring search over titles (optionally body text). |
| `imo_get_document` | Full normalized text of one regulation by `docKey`, + breadcrumb + citations. |
| `imo_list_instruments` | Top-level instruments (SOLAS, MARPOL, STCW, the codes, …). |
| `imo_browse` | Navigate the instrument → chapter → regulation tree. |
| `imo_get_citations` | Outbound cross-references from one document. |
| `imo_stats` | Corpus overview. |

`imo_semantic_search` lazily loads the bundled q8 embedding model on first call (a few
seconds); other tools are instant. Read-only, offline.

## Use it

### Claude Code
A project-scoped [`.mcp.json`](.mcp.json) is included. Open this directory in Claude Code,
approve the `imo-rules` server when prompted, and the `imo_*` tools become available.
(Restart/reconnect once — a newly-added MCP server is not live in a running session.)

### Claude Desktop / other MCP hosts
Add to the host's MCP config, pointing `cwd` at this repo (so `./corpus` resolves):

```json
{
  "mcpServers": {
    "imo-rules": {
      "command": "npx",
      "args": ["tsx", "src/server.ts"],
      "cwd": "/path/to/imo-rules-mcp"
    }
  }
}
```

Smoke-test standalone: `npm start` (speaks MCP over stdio; Ctrl-C to stop).

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `IMO_DB` | `corpus/imo-corpus.sqlite` | SQLite corpus path |
| `IMO_RAG` | `corpus/rag` | semantic-search index dir |
| `IMO_TOC` | `<IMO_RAG>/../toc.json` | navigation tree (override if it lives elsewhere) |
| `IMO_ROOT_KEY` | `0000.00e0` | top-level tree key for `imo_list_instruments` |

> Tip: to run against an existing KRcrawl build in place (no copy), set
> `IMO_DB=<KRcrawl>/data/krcon.sqlite`, `IMO_RAG=<KRcrawl>/dist/help/full-clone/assets/rag`,
> `IMO_TOC=<KRcrawl>/dist/help/full-clone/toc.json`.

## License

Server code: MIT (see [LICENSE](LICENSE)). The license covers the code only — **not** any
corpus data you supply.
