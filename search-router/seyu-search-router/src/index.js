#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SearchRouter } from './router.js';
import { ROUTES } from './engines/registry.js';
import { runMcpUpstreamEngine } from './engines/mcpUpstreamAdapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Config file holds things that can't have safe defaults: Fess/YaCy base URLs
// (self-hosted, so there's no universal default) and a contact reference for
// the Wayback/Common Crawl User-Agent. See seyu-search-router.config.example.json.
const configPath = process.env.SEYU_SEARCH_CONFIG || path.join(__dirname, '..', 'seyu-search-router.config.json');
let fileConfig = {};
try {
  fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch {
  // No config yet — Fess/YaCy simply stay disabled (reported as not_configured) until one is added.
}

const persistDir = process.env.SEYU_SEARCH_STATE_DIR || path.join(__dirname, '..', '.state');

const router = new SearchRouter({ config: fileConfig, persistDir });

const server = new McpServer({ name: 'seyu-search-router', version: '1.0.0' });

const queryTypeKeys = Object.keys(ROUTES);

server.registerTool(
  'web_search',
  {
    title: 'Resilient web search',
    description:
      'Multi-engine web search with automatic failover across free/keyless sources ' +
      '(Parallel, You.com, Wiby, GDELT, Common Crawl, Wayback, plus optional self-hosted ' +
      'Fess/YaCy). Always returns a status of "ok", "partial", or "coverage_incomplete" ' +
      `instead of failing silently. queryType options: ${queryTypeKeys.join(', ')}.`,
    inputSchema: {
      query: z.string().describe('Search query text'),
      queryType: z.enum(queryTypeKeys).optional().describe('Which routing policy to use (default: general)'),
      mode: z.enum(['fast', 'thorough']).optional().describe(
        'fast (default) = stop at the first engine that returns results; ' +
        'thorough = query every engine in the route and merge for maximum diversity',
      ),
      maxResultsPerEngine: z.number().int().positive().optional(),
    },
  },
  async ({ query, queryType, mode, maxResultsPerEngine }) => {
    const result = await router.search(query, { queryType, mode, maxResultsPerEngine });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  'media_search',
  {
    title: 'Openly licensed media search',
    description: 'Search Openverse for openly licensed images or audio. Always re-verify the license on the source page before reuse — do not treat this response as a final license confirmation.',
    inputSchema: {
      query: z.string(),
      mediaType: z.enum(['images', 'audio']).default('images'),
    },
  },
  async ({ query, mediaType }) => {
    const result = await router.search(query, { queryType: mediaType === 'audio' ? 'media_audio' : 'media_images' });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  'fetch_page',
  {
    title: 'Fetch a specific page (best-effort)',
    description:
      'Fetch full content from a specific URL via Parallel\u2019s web_fetch tool. ' +
      'This depends specifically on the Parallel MCP server (unverified in this build ' +
      '\u2014 see README) and has no fallback to another engine if Parallel is unavailable.',
    inputSchema: { url: z.string().describe('The URL to fetch') },
  },
  async ({ url }) => {
    const spec = {
      id: 'parallel-fetch',
      serverUrl: 'https://search.parallel.ai/mcp',
      toolName: 'web_fetch',
      timeoutMs: 15000,
      buildArgs: (u) => ({ url: u }),
      parseResult: (text) => text, // pass through raw; this tool intentionally returns text, not search results
    };
    try {
      const outcome = await runMcpUpstreamEngine(spec, url, {}, {});
      return { content: [{ type: 'text', text: typeof outcome.results === 'string' ? outcome.results : JSON.stringify(outcome.results, null, 2) }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `fetch_page failed: ${err.message}. Parallel is the only configured source for this tool; there is no automatic fallback.` }],
      };
    }
  },
);

server.registerTool(
  'engine_health',
  {
    title: 'Engine health / drift check',
    description:
      'Show current circuit-breaker state, rate-limit budget, and configuration status for every ' +
      'search engine in the router. Use this to catch drift (e.g. an engine unexpectedly requiring ' +
      'auth, or returning an unrecognized response shape) before it silently affects a real query.',
    inputSchema: {},
  },
  async () => ({ content: [{ type: 'text', text: JSON.stringify(router.getHealth(), null, 2) }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
