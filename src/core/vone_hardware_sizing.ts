/**
 * Rough VRAM sizing for running a local LLM via an Ollama/llama.cpp-style
 * runtime. This is deliberately conservative and documented, not a precise
 * simulator - real runtimes differ in quantization layout, allocator
 * fragmentation and CUDA context overhead. Use it to decide "does this
 * model plausibly fit before downloading tens of gigabytes", not as a
 * guarantee down to the megabyte. All inputs come from the owner's own
 * hardware (see describeOwnedDesktop below for the measured profile of
 * their actual desktop).
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

export interface OwnedDesktopProfile {
    readonly gpuLabel: string;
    readonly hasDedicatedGpu: boolean;
    /** GB of dedicated VRAM, or null when there is none (integrated/shared graphics). */
    readonly dedicatedVramGb: number | null;
    readonly systemRamGb: number;
    readonly inferenceMode: 'cpu' | 'gpu';
    readonly cpuLabel: string;
    readonly physicalCores: number;
    readonly logicalProcessors: number;
    readonly caveats: readonly string[];
}

/**
 * The owner's actual desktop, as measured from `Get-CimInstance
 * Win32_VideoController` / `Win32_ComputerSystem` / `Win32_Processor`
 * output (2026-10-06): Intel UHD Graphics 620 (integrated - no CUDA/ROCm),
 * ~31.8GB RAM, Intel Core i7-8650U (4C/8T, Kaby Lake-R mobile, 15W TDP,
 * AVX2 but no AVX-512). Ollama therefore runs CPU-only here, backed by
 * system RAM, not VRAM - fitsInVram() can still be used against
 * `systemRamGb` for a memory-FIT check (the weights+overhead math is the
 * same), but a RAM fit says nothing about tokens/sec: CPU inference is
 * typically far slower than a mid-range discrete GPU for the same model,
 * and a 15W mobile part throttles under sustained load. Update this when
 * the owner's hardware changes or a second machine joins.
 */
export function describeOwnedDesktop(): OwnedDesktopProfile {
    return Object.freeze({
        gpuLabel: 'Intel(R) UHD Graphics 620 (integrated)',
        hasDedicatedGpu: false,
        dedicatedVramGb: null,
        systemRamGb: 31.84, // 34185502720 bytes / 1024^3, from Win32_ComputerSystem
        inferenceMode: 'cpu',
        cpuLabel: 'Intel(R) Core(TM) i7-8650U CPU @ 1.90GHz',
        physicalCores: 4,
        logicalProcessors: 8,
        caveats: [
            'Windows reported AdapterRAM=1GiB for this integrated GPU - a well-known-unreliable ' +
                'WMI value for iGPUs (the field is a 32-bit DWORD that misreports for large shared-memory ' +
                'adapters). Not treated as real dedicated VRAM; dedicatedVramGb is null, not 1.',
            'No NVIDIA/AMD discrete GPU detected: Ollama runs CPU-only here. Fitting in RAM means the ' +
                'model will load and run, not that it will run fast - prefer small, aggressively ' +
                'quantized models (<=7-8B, Q4) for usable latency on CPU.',
            'i7-8650U is a 15W mobile part (4C/8T, AVX2, no AVX-512): expect sustained-load thermal ' +
                'throttling on long jobs, and token/sec estimates here are informed ranges, not ' +
                'measurements - benchmark with `ollama run <model> --verbose` for a real number.',
        ],
    });
}

export interface InstalledOllamaModel {
    readonly tag: string;
    readonly sizeGb: number;
}

/**
 * Snapshot of `ollama list` on the owned desktop (2026-10-06). This is
 * inventory, not a live query - re-paste `ollama list` output and update
 * this array when models are pulled or removed.
 */
export const INSTALLED_OLLAMA_MODELS: readonly InstalledOllamaModel[] = [
    { tag: 'v-one-coder:fast', sizeGb: 0.986 },
    { tag: 'qwen2.5-coder:1.5b', sizeGb: 0.986 },
    { tag: 'qwen2.5-coder:3b', sizeGb: 1.9 },
    { tag: 'qwen2.5-coder:7b-instruct-q3_K_M', sizeGb: 3.8 },
    { tag: 'qwen3:4b', sizeGb: 2.5 },
    { tag: 'qwen3-coder:latest', sizeGb: 18 },
];

export interface ModelRecommendation {
    readonly tag: string;
    readonly reason: string;
}

/**
 * On CPU-only hardware the smallest installed model minimizes latency per
 * token, which is why it's the default recommendation - not because larger
 * models don't fit (several do, comfortably, in ~32GB RAM). This never
 * claims a tokens/sec number: that must come from `ollama run <tag>
 * --verbose` on the real machine.
 */
export function recommendDefaultModel(
    profile: OwnedDesktopProfile,
    installed: readonly InstalledOllamaModel[],
): ModelRecommendation {
    if (installed.length === 0) {
        throw new Error('no installed models to recommend from - run `ollama list` and populate it');
    }
    const smallest = installed.reduce((a, b) => (b.sizeGb < a.sizeGb ? b : a));
    return {
        tag: smallest.tag,
        reason:
            `CPU-only hardware (${profile.cpuLabel}, ${profile.physicalCores}C/${profile.logicalProcessors}T): ` +
            `the smallest installed model (${smallest.sizeGb}GB) minimizes latency per token. Benchmark with ` +
            `\`ollama run ${smallest.tag} --verbose\` to confirm real tokens/sec before relying on it for the FAST route.`,
    };
}
