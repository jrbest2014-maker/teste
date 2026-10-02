import assert from 'node:assert/strict';
import { redactSecrets } from './vone_secret_redaction';

function main(): void {
    assert.equal(
        redactSecrets('my key is sk-abcdefghijklmnopqrstuvwx and it works'),
        'my key is [REDACTED] and it works',
    );

    assert.equal(redactSecrets('AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP'), 'AWS_ACCESS_KEY_ID=[REDACTED]');

    assert.equal(redactSecrets('Authorization: Bearer abc123.def456-ghi789'), 'Authorization: [REDACTED]');

    assert.equal(redactSecrets('api_key: "abcdefgh12345678"'), '[REDACTED]');

    assert.equal(redactSecrets('nothing sensitive here, just plain text'), 'nothing sensitive here, just plain text');

    console.log('vone_secret_redaction: all assertions passed');
}

main();
