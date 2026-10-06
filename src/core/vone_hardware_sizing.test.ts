import assert from 'node:assert/strict';
import { describeOwnedDesktop, estimateVram, fitsInVram } from './vone_hardware_sizing';

function main(): void {
    // Reference point: a 7B model at 4 bits/weight should land close to the
    // widely-observed ~4-4.5GB a Q4_K_M 7B GGUF actually occupies.
    const sevenB = estimateVram({ paramsBillion: 7, bitsPerWeight: 4 });
    assert.ok(sevenB.weightsGb > 3.4 && sevenB.weightsGb < 3.6, `weightsGb out of range: ${sevenB.weightsGb}`);
    assert.equal(sevenB.kvCacheGb, 0); // no KV fields supplied -> skipped
    assert.ok(sevenB.totalGb > sevenB.weightsGb); // overhead must add something
    assert.ok(Math.abs(sevenB.totalGb - sevenB.weightsGb * 1.15) < 1e-9);

    // KV cache term only applies when all three shape fields are given.
    const withKv = estimateVram({
        paramsBillion: 7,
        bitsPerWeight: 4,
        contextTokens: 4096,
        numLayers: 32,
        numKvHeads: 8,
        headDimBytes: 256, // 128 head_dim * 2 bytes fp16
    });
    assert.ok(withKv.kvCacheGb > 0);
    assert.ok(withKv.totalGb > sevenB.totalGb);

    // Doubling bits roughly doubles weights.
    const fp16 = estimateVram({ paramsBillion: 7, bitsPerWeight: 16 });
    assert.ok(Math.abs(fp16.weightsGb - sevenB.weightsGb * 4) < 1e-6);

    // fitsInVram respects headroom.
    assert.equal(fitsInVram({ weightsGb: 0, kvCacheGb: 0, overheadGb: 0, totalGb: 10 }, 12, 1), true);
    assert.equal(fitsInVram({ weightsGb: 0, kvCacheGb: 0, overheadGb: 0, totalGb: 11.5 }, 12, 1), false);

    // Fail-closed on nonsensical input.
    assert.throws(() => estimateVram({ paramsBillion: 0, bitsPerWeight: 4 }), /paramsBillion/);
    assert.throws(() => estimateVram({ paramsBillion: 7, bitsPerWeight: 0 }), /bitsPerWeight/);
    assert.throws(() => estimateVram({ paramsBillion: 7, bitsPerWeight: 4, overheadFraction: -0.1 }), /overheadFraction/);

    // The owned-desktop profile reflects measured reality: no dedicated GPU,
    // the unreliable 1GiB WMI reading not trusted as real VRAM, and the
    // caveats explaining both must be present.
    const desktop = describeOwnedDesktop();
    assert.equal(desktop.hasDedicatedGpu, false);
    assert.equal(desktop.dedicatedVramGb, null);
    assert.equal(desktop.inferenceMode, 'cpu');
    assert.ok(desktop.systemRamGb > 30 && desktop.systemRamGb < 33);
    assert.ok(desktop.caveats.some((c) => /unreliable/i.test(c)));
    assert.ok(desktop.caveats.some((c) => /CPU-only/i.test(c)));

    // CPU-only reality: a 7B Q4 model's footprint must comfortably fit the
    // real RAM with headroom - this is the actual sizing question now.
    assert.equal(fitsInVram(sevenB, desktop.systemRamGb, 4), true);

    console.log('vone_hardware_sizing: all assertions passed');
}

main();
