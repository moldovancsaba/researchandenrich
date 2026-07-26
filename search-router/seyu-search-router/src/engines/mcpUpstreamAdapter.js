import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Parallel and You.com are themselves MCP servers, so calling them means acting
// as an MCP *client* against a remote server, not a plain REST fetch. Connections
// are cached and reused; a failed call drops the cached connection so the next
// attempt reconnects cleanly rather than reusing a possibly-dead session.
const clientCache = new Map(); // serverUrl -> { client, connectedAt }
const CONNECTION_TTL_MS = 10 * 60 * 1000;

async function defaultClientFactory(serverUrl) {
  const client = new Client({ name: 'seyu-search-router', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
  await client.connect(transport);
  return client;
}

async function getClient(serverUrl, clientFactory) {
  const cached = clientCache.get(serverUrl);
  if (cached && Date.now() - cached.connectedAt < CONNECTION_TTL_MS) return cached.client;
  const client = await (clientFactory ? clientFactory(serverUrl) : defaultClientFactory(serverUrl));
  clientCache.set(serverUrl, { client, connectedAt: Date.now() });
  return client;
}

export function _resetMcpClientCache() {
  clientCache.clear();
}

/**
 * Runs an MCP-upstream engine spec (see registry.js: parallel, youcom) and
 * normalizes its output. Same schema-drift detection as runRestEngine.
 */
export async function runMcpUpstreamEngine(spec, query, opts, ctx = {}) {
  let client;
  try {
    client = await getClient(spec.serverUrl, ctx.clientFactory);
  } catch (err) {
    clientCache.delete(spec.serverUrl);
    if (!err.type) err.type = 'mcp_connect_error';
    throw err;
  }

  const args = spec.buildArgs(query, opts);

  let result;
  try {
    result = await client.callTool({ name: spec.toolName, arguments: args }, undefined, { timeout: spec.timeoutMs ?? 10000 });
  } catch (err) {
    // Session may be stale/broken — drop it so the next call reconnects instead of repeating the same failure.
    clientCache.delete(spec.serverUrl);
    if (!err.type) err.type = err.code === 'RequestTimeout' || /timeout/i.test(err.message || '') ? 'timeout' : 'mcp_call_error';
    throw err;
  }

  if (result?.isError) {
    const message = (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ') || 'tool reported an error';
    throw new Error(`${spec.toolName} returned an error result: ${message}`);
  }

  const joinedText = (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

  let parsed;
  let parseWarning = null;
  try {
    parsed = spec.parseResult(joinedText, result);
  } catch (err) {
    parseWarning = `parseResult threw: ${err.message}`;
    parsed = [];
  }

  const looksEmpty = !parsed || parsed.length === 0;
  if (looksEmpty && joinedText.trim().length > 40) {
    parseWarning = parseWarning || 'parser returned 0 results from a non-trivial tool response — possible schema drift, verify manually (see scripts/live-smoke-test.js)';
  }

  return { results: parsed || [], parseWarning, rawLength: joinedText.length };
}
