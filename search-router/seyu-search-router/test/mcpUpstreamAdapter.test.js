import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runMcpUpstreamEngine, _resetMcpClientCache } from '../src/engines/mcpUpstreamAdapter.js';

/**
 * Spins up a REAL McpServer (same class production code uses) in-process,
 * exposing a fake search tool, and connects a REAL Client to it via a linked
 * in-memory transport pair — no network involved, but genuinely exercising
 * the SDK's protocol/serialization logic rather than a hand-rolled mock.
 *
 * This is what lets us say the *client code* is solid even though we can't
 * reach the real search.parallel.ai / api.you.com from this sandbox.
 */
async function startFakeUpstreamServer(toolName, handler) {
  const server = new McpServer({ name: 'fake-upstream', version: '0.0.1' });
  server.registerTool(
    toolName,
    { description: 'fake', inputSchema: { query: z.string() } },
    handler,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { server, clientTransport };
}

async function clientFactoryFor(clientTransport) {
  const client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

test('parses a well-formed JSON search result from a real MCP round-trip', async () => {
  _resetMcpClientCache();
  const { clientTransport } = await startFakeUpstreamServer('web_search', async ({ query }) => ({
    content: [{ type: 'text', text: JSON.stringify({ results: [{ url: 'https://x.com/1', title: `hit for ${query}` }] }) }],
  }));

  const spec = {
    id: 'parallel',
    serverUrl: 'inmemory://parallel',
    toolName: 'web_search',
    timeoutMs: 5000,
    buildArgs: (query) => ({ query }),
    parseResult: (text) => {
      const data = JSON.parse(text);
      return data.results.map((r, i) => ({ url: r.url, title: r.title, snippet: '', engine: 'parallel', rank: i + 1, timestamp: null, extra: {} }));
    },
  };

  const outcome = await runMcpUpstreamEngine(spec, 'test query', {}, { clientFactory: () => clientFactoryFor(clientTransport) });
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].url, 'https://x.com/1');
  assert.equal(outcome.results[0].title, 'hit for test query');
  assert.equal(outcome.parseWarning, null);
});

test('flags schema drift instead of silently reporting zero results', async () => {
  _resetMcpClientCache();
  const { clientTransport } = await startFakeUpstreamServer('web_search', async () => ({
    content: [{ type: 'text', text: 'Here are some results about your topic, in a shape nobody expected: item one, item two, item three, keep reading for more unexpected prose that is clearly not JSON.' }],
  }));

  const spec = {
    id: 'parallel',
    serverUrl: 'inmemory://parallel2',
    toolName: 'web_search',
    timeoutMs: 5000,
    buildArgs: (query) => ({ query }),
    parseResult: (text) => {
      const data = JSON.parse(text); // throws on the plain-text response above
      return data.results;
    },
  };

  const outcome = await runMcpUpstreamEngine(spec, 'q', {}, { clientFactory: () => clientFactoryFor(clientTransport) });
  assert.equal(outcome.results.length, 0);
  assert.match(outcome.parseWarning, /parseResult threw|schema drift/);
});

test('a tool-level error result is surfaced as a thrown error, not swallowed', async () => {
  _resetMcpClientCache();
  const { clientTransport } = await startFakeUpstreamServer('web_search', async () => ({
    isError: true,
    content: [{ type: 'text', text: 'upstream quota exceeded' }],
  }));

  const spec = {
    id: 'youcom',
    serverUrl: 'inmemory://youcom',
    toolName: 'web_search',
    timeoutMs: 5000,
    buildArgs: (query) => ({ query }),
    parseResult: () => [],
  };

  await assert.rejects(
    () => runMcpUpstreamEngine(spec, 'q', {}, { clientFactory: () => clientFactoryFor(clientTransport) }),
    /quota exceeded/,
  );
});
