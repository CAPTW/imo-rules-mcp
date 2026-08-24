# imo-rules-mcp

An **MCP server** that exposes a local corpus of **IMO maritime rules and
regulations** (SOLAS, MARPOL, STCW, the codes, etc.) to MCP-compatible local
clients for **offline semantic search and reading**. No crawler, no network; it
serves a local corpus you provide.

## Bring Your Own Corpus

This repository contains **only the server code**. It does **not** include any
regulation text. The IMO rules and regulations corpus is **copyrighted** by its
rights holders and is licensed to you separately. **Do not commit it to a public
repository or redistribute it.** The `corpus/` directory is gitignored for this
reason. If you choose to bundle a corpus into a repo for convenience, **keep that
repository private.**

## What You Provide

A corpus directory (default `./corpus/`) containing:

```
corpus/
  imo-corpus.sqlite     # SQLite corpus (documents, nodes, citations)
  toc.json              # navigation tree (instruments, chapters, regulations)
  rag/
    config.json
    meta.json
    vectors.f32         # one embedding per page
    models/             # local embedding model
```

This layout is produced by the companion **KRcrawl** exporter (`export:full-help`
+ `rag:index`). Import it with:

```bash
npm install
node scripts/import-corpus.mjs /path/to/KRcrawl
```

Or skip the copy and point the server at an existing build with env vars.

## Tools

| Tool | What it does |
|---|---|
| `imo_semantic_search` | Meaning-based search: ranked regulations with instrument breadcrumb, snippet, and `docKey`. |
| `imo_keyword_search` | Substring search over titles, optionally body text. |
| `imo_get_document` | Full normalized text of one regulation by `docKey`, plus breadcrumb and citations. |
| `imo_list_instruments` | Top-level instruments such as SOLAS, MARPOL, STCW, and the codes. |
| `imo_browse` | Navigate the instrument, chapter, and regulation tree. |
| `imo_get_citations` | Outbound cross-references from one document. |
| `imo_stats` | Corpus overview. |

`imo_semantic_search` lazily loads the bundled local embedding model on first
call; other tools are instant. The server is read-only and offline.

## Use It

A project-scoped [`.mcp.json`](.mcp.json) is included for MCP hosts that support
repository-local configuration. For hosts that use a global config file, add a
server entry like this and point `cwd` at this repo so `./corpus` resolves:

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

Smoke-test standalone:

```bash
npm start
```

The process speaks MCP over stdio; press Ctrl-C to stop.

## Configuration

| Var | Default | Meaning |
|---|---|---|
| `IMO_DB` | `corpus/imo-corpus.sqlite` | SQLite corpus path |
| `IMO_RAG` | `corpus/rag` | semantic-search index dir |
| `IMO_TOC` | `<IMO_RAG>/../toc.json` | navigation tree; override if it lives elsewhere |
| `IMO_ROOT_KEY` | `0000.00e0` | top-level tree key for `imo_list_instruments` |

To run against an existing KRcrawl build in place, set:

```bash
IMO_DB=<KRcrawl>/data/krcon.sqlite
IMO_RAG=<KRcrawl>/dist/help/full-clone/assets/rag
IMO_TOC=<KRcrawl>/dist/help/full-clone/toc.json
```

## License

Server code: MIT (see [LICENSE](LICENSE)). The license covers the code only,
**not** any corpus data you supply.
