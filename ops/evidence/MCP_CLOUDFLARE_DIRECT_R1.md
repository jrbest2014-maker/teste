# V-ONE MCP Cloudflare Direct R1 — Evidence

Date: 2026-10-04
Baseline commit: a43283e8be7eab51e9307bfc497c1cdfcb023f68

## Objective

Remove AppDeploy from the critical path of the public V-ONE MCP endpoint without changing the public URL used by ChatGPT, Claude, Codex or other MCP clients.

## Change

Public endpoint remains:
https://mcp.vone-technology.workers.dev/mcp

The mcp Worker now proxies to V-ONE Master through the Cloudflare Service Binding:

VONE_MASTER -> vone-control-plane

Fallback origin is also Cloudflare direct:
https://vone-control-plane.vone-technology.workers.dev

AppDeploy is not used by the mcp Worker critical path.

OAuth responses and redirects are rewritten back to the stable public mcp origin.

## Validation

- Wrangler dry-run: PASS
- Service Binding visible in dry-run: PASS
- mcp deploy: PASS
- deployed Worker version: 596d1313-760a-4a59-9594-27e0a4ca808d
- public root: HTTP 200
- public root version: 1.2.0
- architecture: CLOUDFLARE_EDGE_TO_SERVICE_BINDING_TO_CLOUD_MASTER
- OAuth authorization-server metadata: HTTP 200
- OAuth protected-resource metadata: HTTP 200
- dynamic registration advertised at /oauth/register
- PKCE S256 advertised
- scope mcp:tools advertised
- previous AppDeploy 402: eliminated
- ChatGPT V-ONE MCP status after cutover: PASS
- capacity plan after cutover: PASS
- owned Ollama route remains FREE_AVAILABLE
- Cloudflare Workers AI route remains FREE_AVAILABLE
- paid fallback remains PAID_BLOCKED

## Codex

- Codex CLI authenticated using ChatGPT.
- Local V-ONE stdio proxy remains enabled as fallback.
- Remote v-one-master was added.
- Before cutover, OAuth DCR failed with HTTP 404 behind AppDeploy.
- After cutover, DCR succeeded far enough to generate a valid authorization URL and local callback listener.
- Final user consent is pending in the browser; this is a client OAuth consent step, not an infrastructure failure.

## Claude

- Local V-ONE MCP proxy remains Connected.
- Direct V-ONE_MASTER and V-ONE_MASTER_SECURE remain configured.
- Direct OAuth is infrastructure-ready; Claude CLI requires an interactive terminal to complete browser callback.

## Rollback

Pre-change copies:
C:\Users\User\V-ONE-MASTER-INTEGRATION-R1\src\cloudflare\vone_mcp_edge.ts.bak-cloudflare-direct-r1
C:\Users\User\V-ONE-MASTER-INTEGRATION-R1\wrangler.mcp.jsonc.bak-cloudflare-direct-r1

## Verdict

MCP_CLOUDFLARE_DIRECT_R1 = PASS
CLIENT_OAUTH_CONSENT = PENDING where required by each client.
