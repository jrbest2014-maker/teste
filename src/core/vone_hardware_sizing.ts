/**
 * Rough VRAM sizing for running a local LLM via an Ollama/llama.cpp-style
 * runtime. This is deliberately conservative and documented, not a precise
 * simulator - real runtimes differ in quantization layout, allocator
 * fragmentation and CUDA context overhead. Use it to decide "does this
 * model plausibly fit before downloading tens of gigabytes", not as a
 * guarantee down to the megabyte. All inputs come from the owner's own
 * hardware (see describeAssumedGpu below for the explicit placeholder used
 * until real `nvidia-smi` / `ollama list` output is provided).
 *
 * Formula:
 *   weights  = paramsBillion * 1e9 * (bitsPerWeight / 8)                  bytes
 *   kvCache  = 2 (K+V) * contextTokens * numLayers * numKvHeads * headDimBytes
 *              (any of numLayers/numKvHeads/headDimBytes left at 0 skips
 *              this term - useful for a quick weights-only estimate)
 *   overhead = (weights + kvCache) * overheadFraction
 *              (runtime buffers, CUDA context, fragmentation; defaults to
 *              15%, in line with commonly observed llama.cpp overhead)
 */

export interface VramEstimateInput {
    readonly paramsBillion: number;
    /** e.g. 4 for a Q4_K_M GGUF quant, 8 for Q8_0, 16 for fp16. */
    readonly bitsPerWeight: number;
    readonly contextTokens?: number;
    readonly numLayers?: number;
    readonly numKvHeads?: number;
    /** headDim * bytesPerElement - fp16 KV cache is 2 bytes/element. */
    readonly headDimBytes?: number;
    /** Fraction of (weights + kvCache) reserved for runtime overhead. */
    readonly overheadFraction?: number;
}

export interface VramEstimate {
    readonly weightsGb: number;
    readonly kvCacheGb: number;
    readonly overheadGb: number;
    readonly totalGb: number;
}

const DEFAULT_OVERHEAD_FRACTION = 0.15;
const BYTES_PER_GB = 1e9;

export function estimateVram(input: VramEstimateInput): VramEstimate {
    if (!(input.paramsBillion > 0)) {
        throw new Error('paramsBillion must be > 0');
    }
    if (!(input.bitsPerWeight > 0)) {
        throw new Error('bitsPerWeight must be > 0');
    }

    const weightsBytes = input.paramsBillion * 1e9 * (input.bitsPerWeight / 8);

    const contextTokens = input.contextTokens ?? 0;
    const numLayers = input.numLayers ?? 0;
    const numKvHeads = input.numKvHeads ?? 0;
    const headDimBytes = input.headDimBytes ?? 0;
    const kvCacheBytes = 2 * contextTokens * numLayers * numKvHeads * headDimBytes;

    const overheadFraction = input.overheadFraction ?? DEFAULT_OVERHEAD_FRACTION;
    if (overheadFraction < 0) {
        throw new Error('overheadFraction must be >= 0');
    }
    const overheadBytes = (weightsBytes + kvCacheBytes) * overheadFraction;

    const toGb = (bytes: number) => bytes / BYTES_PER_GB;
    return {
        weightsGb: toGb(weightsBytes),
        kvCacheGb: toGb(kvCacheBytes),
        overheadGb: toGb(overheadBytes),
        totalGb: toGb(weightsBytes + kvCacheBytes + overheadBytes),
    };
}

/** True when the estimate fits with at least `headroomGb` free (default 1GB). */
export function fitsInVram(estimate: VramEstimate, availableVramGb: number, headroomGb = 1): boolean {
    return estimate.totalGb + headroomGb <= availableVramGb;
}

export interface AssumedGpu {
    readonly label: string;
    readonly vramGb: number;
    readonly systemRamGb: number;
    readonly note: string;
}

/**
 * Placeholder hardware used ONLY until the owner's desktop reports its real
 * `nvidia-smi` / `ollama list` output. Every caller that uses this MUST
 * surface `note` to the user - estimates against it are hypotheticals, not
 * measurements of real hardware.
 */
export function describeAssumedGpu(): AssumedGpu {
    return Object.freeze({
        label: 'RTX 3090 (assumed placeholder)',
        vramGb: 24,
        systemRamGb: 64,
        note:
            'PLACEHOLDER supplied by the user as a stand-in, not a measurement of real hardware. ' +
            'Replace with real `nvidia-smi --query-gpu=name,memory.total --format=csv` / `free -h` ' +
            'output before trusting any fit/no-fit conclusion.',
    });
}
