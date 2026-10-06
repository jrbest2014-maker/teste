import type { VOneSkill } from './vone_skill_contract';

/**
 * The source of truth for V-ONE's hard skills. Every entry here must
 * describe code that actually exists and is tested in this repo -
 * vone_skill_catalog.test.ts asserts every `implementedBy` path is a real
 * file, and `npm run export:skills` is the only way skills/<id>/SKILL.md
 * gets written, so there is no hand-maintained copy to drift from this.
 */
export const SKILL_CATALOG: readonly VOneSkill[] = [
    {
        id: 'vone-model-router',
        title: 'V-ONE Model Router',
        version: '1.0.0',
        description:
            'Selects a model route for a job under strict cost gates: PAID_BLOCKED=INVIOLABLE never lets a ' +
            'paid route run unselected by the owner, and UNKNOWN_COST=HOLD stops the job rather than guess at ' +
            'a route whose state is not freshly known. Use whenever a task needs to pick between local ' +
            '(Ollama) and Cloudflare Workers AI free-tier inference.',
        triggers: ['model route', 'select route', 'which model', 'inference backend', 'ollama or cloudflare'],
        implementedBy: ['src/server/vone_model_router.ts'],
        body: `Route selection order:

1. Read the configured routes and their live state (FREE_AVAILABLE, OFFLINE, STALE).
2. Reject any route in OFFLINE or STALE state outright - it never wins.
3. Reject any route tier other than "free" - PAID_BLOCKED=INVIOLABLE means a
   paid route is never auto-selected, only ever a deliberate, separately
   authorized choice by the owner.
4. Among the remaining eligible free routes, pick by the router's configured
   preference (local Ollama first when a fresh heartbeat proves it eligible,
   otherwise the Cloudflare Workers AI free tier).
5. If no route is eligible, return HOLD with the exact reason (no silent
   fallback to a paid or stale route).

This mirrors VONE_MCP_EVAL_R1 rules 2-4 from the control-plane side: COST,
OFFLINE and LOCAL_TRUTH all apply at the router boundary, not just upstream.`,
    },
    {
        id: 'vone-secret-redaction',
        title: 'V-ONE Secret Redaction',
        version: '1.0.0',
        description:
            'Best-effort regex redaction of common secret shapes (API keys, bearer tokens, key/value ' +
            'credential pairs) before text is persisted to a checkpoint, fed back into a prompt, or emitted ' +
            'as telemetry. Use on any text that will be logged, checkpointed, or re-sent to a model.',
        triggers: ['redact secret', 'secret in log', 'secret in checkpoint', 'credential leak'],
        implementedBy: ['src/core/vone_secret_redaction.ts'],
        body: `Call redactSecrets(text) on anything headed for a log line, a checkpoint
file, or a prompt that will be persisted, before it leaves the process.

This is a safety net, not a guarantee: it only catches the shapes it has
patterns for (sk-/AKIA-prefixed keys, Bearer tokens, key=value credential
pairs). It complements, and never replaces, simply not putting real
credentials into tool arguments or file content in the first place - no
token belongs in Git, logs, or test fixtures, redacted or not.`,
    },
    {
        id: 'vone-hardware-sizing',
        title: 'V-ONE Hardware Sizing',
        version: '1.0.0',
        description:
            'Estimates whether a local LLM (by parameter count and quantization) fits in a given amount of ' +
            'VRAM, with an explicit, labeled placeholder GPU for use before real hardware specs are known. ' +
            'Use before recommending or downloading a larger local model for the owned worker.',
        triggers: ['vram', 'gpu sizing', 'does it fit', 'hardware sizing', 'quantization size'],
        implementedBy: ['src/core/vone_hardware_sizing.ts'],
        body: `Call estimateVram({ paramsBillion, bitsPerWeight, ...optional KV-cache
fields }) to get a weights/kvCache/overhead/total breakdown in GB, then
fitsInVram(estimate, availableVramGb) to check it against the real GPU.

Never treat describeAssumedGpu()'s placeholder values as a measurement -
its \`note\` field exists specifically to be surfaced to the user, and any
conclusion drawn from it must be labeled as hypothetical until the owner
provides real \`nvidia-smi\` / \`ollama list\` output from their own machine.`,
    },
];
