---
name: vone-secret-redaction
description: "Best-effort regex redaction of common secret shapes (API keys, bearer tokens, key/value credential pairs) before text is persisted to a checkpoint, fed back into a prompt, or emitted as telemetry. Use on any text that will be logged, checkpointed, or re-sent to a model."
version: "1.0.0"
triggers: ["redact secret", "secret in log", "secret in checkpoint", "credential leak"]
implemented-by: ["src/core/vone_secret_redaction.ts"]
---

# V-ONE Secret Redaction

Call redactSecrets(text) on anything headed for a log line, a checkpoint
file, or a prompt that will be persisted, before it leaves the process.

This is a safety net, not a guarantee: it only catches the shapes it has
patterns for (sk-/AKIA-prefixed keys, Bearer tokens, key=value credential
pairs). It complements, and never replaces, simply not putting real
credentials into tool arguments or file content in the first place - no
token belongs in Git, logs, or test fixtures, redacted or not.
