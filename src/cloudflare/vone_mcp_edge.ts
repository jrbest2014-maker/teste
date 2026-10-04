const FALLBACK_ORIGIN = 'https://vone-control-plane.vone-technology.workers.dev';

type Env = {
  VONE_MASTER?: {
    fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
  };
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

function allowed(pathname: string): boolean {
  return pathname === '/api/status'
    || pathname === '/api/_healthcheck'
    || pathname === '/api/oauth/approve'
    || pathname === '/mcp'
    || pathname.startsWith('/mcp/')
    || pathname.startsWith('/oauth/')
    || pathname.startsWith('/.well-known/oauth-');
}

function rewriteOAuthJson(pathname: string, payload: any, publicOrigin: string): any {
  if (!payload || typeof payload !== 'object') return payload;

  if (pathname.startsWith('/.well-known/oauth-protected-resource')) {
    return {
      ...payload,
      resource: publicOrigin + '/mcp',
      authorization_servers: [publicOrigin],
    };
  }

  if (pathname === '/.well-known/oauth-authorization-server') {
    return {
      ...payload,
      issuer: publicOrigin,
      authorization_endpoint: publicOrigin + '/oauth/authorize',
      token_endpoint: publicOrigin + '/oauth/token',
      registration_endpoint: publicOrigin + '/oauth/register',
    };
  }

  if (pathname === '/oauth/token' && payload.resource) {
    return { ...payload, resource: publicOrigin + '/mcp' };
  }

  return payload;
}

async function proxy(request: Request, incoming: URL, env: Env): Promise<Response> {
  const target = new URL(FALLBACK_ORIGIN + incoming.pathname + incoming.search);
  const headers = new Headers(request.headers);
  headers.set('host', target.host);
  headers.set('x-vone-edge', 'cloudflare-worker');
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ray');

  const init: RequestInit = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;

  const upstreamRequest = new Request(target.toString(), init);
  const upstream = env.VONE_MASTER?.fetch
    ? await env.VONE_MASTER.fetch(upstreamRequest)
    : await fetch(upstreamRequest);
  const outHeaders = new Headers(upstream.headers);
  outHeaders.set('cache-control', 'no-store');
  outHeaders.set('x-vone-edge', 'cloudflare-worker');
  outHeaders.set('x-content-type-options', 'nosniff');
  outHeaders.delete('server');

  const publicOrigin = incoming.origin;
  const location = outHeaders.get('location');
  if (location) {
    outHeaders.set('location', location.replace(FALLBACK_ORIGIN, publicOrigin));
  }
  const contentType = upstream.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const payload = await upstream.json().catch(() => null);
    if (payload !== null) {
      const rewritten = rewriteOAuthJson(incoming.pathname, payload, publicOrigin);
      const challenge = outHeaders.get('www-authenticate');
      if (challenge) {
        outHeaders.set(
          'www-authenticate',
          challenge.replace(
            /resource_metadata="[^"]+"/,
            'resource_metadata="' + publicOrigin + '/.well-known/oauth-protected-resource"'
          )
        );
      }
      return new Response(JSON.stringify(rewritten), { status: upstream.status, headers: outHeaders });
    }
  }

  const challenge = outHeaders.get('www-authenticate');
  if (challenge) {
    outHeaders.set(
      'www-authenticate',
      challenge.replace(
        /resource_metadata="[^"]+"/,
        'resource_metadata="' + publicOrigin + '/.well-known/oauth-protected-resource"'
      )
    );
  }

  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);

    if (incoming.pathname === '/') {
      return json({
        ok: true,
        service: 'V-ONE MCP Edge',
        version: '1.2.0',
        architecture: 'CLOUDFLARE_EDGE_TO_SERVICE_BINDING_TO_CLOUD_MASTER',
        oauth: '2.1_PKCE',
        mcp: 'AUTHENTICATED',
        origin_exposed: false,
      });
    }

    if (!allowed(incoming.pathname)) return json({ ok: false, error: 'not_found' }, 404);
    return proxy(request, incoming, env);
  },
};