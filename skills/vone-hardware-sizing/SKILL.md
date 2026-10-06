---
name: vone-hardware-sizing
description: "Estimates whether a local LLM (by parameter count and quantization) fits in a given amount of VRAM, with an explicit, labeled placeholder GPU for use before real hardware specs are known. Use before recommending or downloading a larger local model for the owned worker."
version: "1.0.0"
triggers: ["vram", "gpu sizing", "does it fit", "hardware sizing", "quantization size"]
implemented-by: ["src/core/vone_hardware_sizing.ts"]
---

# V-ONE Hardware Sizing

Call estimateVram({ paramsBillion, bitsPerWeight, ...optional KV-cache
fields }) to get a weights/kvCache/overhead/total breakdown in GB, then
fitsInVram(estimate, availableVramGb) to check it against the real GPU.

Never treat describeAssumedGpu()'s placeholder values as a measurement -
its `note` field exists specifically to be surfaced to the user, and any
conclusion drawn from it must be labeled as hypothetical until the owner
provides real `nvidia-smi` / `ollama list` output from their own machine.
