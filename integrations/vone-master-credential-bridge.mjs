import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const MASTER = 'https://vone-control-plane.vone-technology.workers.dev';
const SECURE_MCP = MASTER + '/mcp';
const PUBLIC_MCP = MASTER + '/mcp-public';
const BUNDLE = process.env.VONE_MASTER_OAUTH_BUNDLE || path.join(os.homedir(), '.vone', 'auth', 'vone-master-oauth.json');
const CACHE_MS = 30000;

let cache = { at: 0, tools: [], mode: 'unknown' };

function safeError(error) {
  const text = String(error?.message || error || 'unknown error');
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<REDACTED>')
    .replace(/Bearer\s+[A-Za-z0-9._~-]{8,}/gi, 'Bearer <REDACTED>')
    .slice(0, 600);
}

function readBundle() {
  if (!fs.existsSync(BUNDLE)) return null;
  try {
    const b = JSON.parse(fs.readFileSync(BUNDLE, 'utf8'));
    return b && typeof b === 'object' ? b : null;
  } catch {
    return null;
  }
}

function writeBundle(bundle) {
  const tmp = BUNDLE + '.tmp';
  fs.mkdirSync(path.dirname(BUNDLE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, BUNDLE);
}

async function refreshBundle(bundle) {
  if (!bundle?.refresh_token || !bundle?.client_id || !bundle?.token_endpoint) {
    throw new Error('V-ONE OAuth bundle cannot refresh');
  }
  const response = await fetch(bundle.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: bundle.client_id,
      refresh_token: bundle.refresh_token
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error('V-ONE OAuth refresh failed HTTP ' + response.status);
  }
  const next = {
    ...bundle,
    access_token: data.access_token,
    refresh_token: data.refresh_token || bundle.refresh_token,
    expires_at: new Date(Date.now() + Number(data.expires_in || 3600) * 1000).toISOString(),
    scope: data.scope || bundle.scope
  };
  writeBundle(next);
  return next;
}

async function secureBundle() {
  let bundle = readBundle();
  if (!bundle?.access_token) throw new Error('V-ONE OAuth bundle missing');
  const expires = Date.parse(bundle.expires_at || 0);
  if (!Number.isFinite(expires) || expires <= Date.now() + 60000) {
    bundle = await refreshBundle(bundle);
  }
  return bundle;
}

async function postMcp(url, body, bearer) {
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream'
  };
  if (bearer) headers.authorization = 'Bearer ' + bearer;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch { data = { error: { code: -32099, message: 'Non-JSON MCP response HTTP ' + response.status } }; }
  return { response, data };
}

async function secureRpc(method, params) {
  let bundle = await secureBundle();
  let out = await postMcp(SECURE_MCP, {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method,
    params: params || {}
  }, bundle.access_token);

  if (out.response.status === 401) {
    bundle = await refreshBundle(bundle);
    out = await postMcp(SECURE_MCP, {
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method,
      params: params || {}
    }, bundle.access_token);
  }
  return out;
}

async function publicRpc(method, params) {
  return postMcp(PUBLIC_MCP, {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method,
    params: params || {}
  });
}

async function listRemoteTools(force = false) {
  if (!force && cache.tools.length && Date.now() - cache.at < CACHE_MS) return cache;
  try {
    const out = await secureRpc('tools/list', {});
    if (!out.response.ok || out.data?.error) throw new Error(out.data?.error?.message || ('HTTP ' + out.response.status));
    cache = { at: Date.now(), tools: out.data?.result?.tools || [], mode: 'secure' };
    return cache;
  } catch (secureError) {
    const out = await publicRpc('tools/list', {});
    if (!out.response.ok || out.data?.error) {
      throw new Error('secure=' + safeError(secureError) + '; public=' + (out.data?.error?.message || ('HTTP ' + out.response.status)));
    }
    cache = { at: Date.now(), tools: out.data?.result?.tools || [], mode: 'public-readonly-fallback' };
    return cache;
  }
}

async function callRemoteTool(name, args) {
  try {
    const out = await secureRpc('tools/call', { name, arguments: args || {} });
    if (!out.response.ok) throw new Error('HTTP ' + out.response.status);
    if (out.data?.error) throw new Error(out.data.error.message || 'V-ONE MCP error');
    cache.mode = 'secure';
    return out.data?.result || { content: [{ type: 'text', text: 'No result' }] };
  } catch (secureError) {
    const out = await publicRpc('tools/call', { name, arguments: args || {} });
    if (out.response.ok && !out.data?.error && out.data?.result) {
      cache.mode = 'public-readonly-fallback';
      return out.data.result;
    }
    throw new Error('V-ONE secure unavailable and public fallback denied: ' + safeError(secureError));
  }
}

const server = new Server(
  { name: 'V-ONE Master Credential Bridge', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const listed = await listRemoteTools();
  return { tools: listed.tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = String(request.params?.name || '');
  const args = request.params?.arguments || {};
  if (!name) throw new Error('tool name required');
  return callRemoteTool(name, args);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('V-ONE Master Credential Bridge ready');
