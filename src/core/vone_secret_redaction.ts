const SECRET_PATTERNS: readonly RegExp[] = [
    /sk-[A-Za-z0-9_-]{16,}/g,
    /AKIA[0-9A-Z]{16}/g,
    /Bearer\s+[A-Za-z0-9\-_.]{10,}/g,
    /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9_\-/+=]{8,}["']?/gi,
];

/**
 * Best-effort redaction of common secret shapes (API keys, bearer tokens,
 * key/value credential pairs) before text is persisted to a checkpoint, fed
 * back into a prompt, or emitted as telemetry. This is a regex safety net,
 * not a guarantee - it only catches the shapes above, so it complements
 * rather than replaces not putting real credentials into tool arguments or
 * file content in the first place.
 */
export function redactSecrets(text: string): string {
    let redacted = text;
    for (const pattern of SECRET_PATTERNS) {
        redacted = redacted.replace(pattern, '[REDACTED]');
    }
    return redacted;
}
