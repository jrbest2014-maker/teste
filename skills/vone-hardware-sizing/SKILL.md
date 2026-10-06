---
name: vone-hardware-sizing
description: "Estimates whether a local LLM (by parameter count and quantization) fits in available VRAM or RAM, against the owned desktop's measured profile (CPU-only, Intel UHD 620, ~32GB RAM, no dedicated GPU). Use before recommending or downloading a larger local model for the owned worker."
version: "1.0.0"
triggers: ["vram", "gpu sizing", "does it fit", "hardware sizing", "quantization size"]
implemented-by: ["src/core/vone_hardware_sizing.ts"]
---

# V-ONE Hardware Sizing

Call estimateVram({ paramsBillion, bitsPerWeight, ...optional KV-cache
fields }) to get a weights/kvCache/overhead/total breakdown in GB, then
fitsInVram(estimate, availableGb, headroomGb) to check it against real
capacity - describeOwnedDesktop() reports the owner's measured hardware
(no dedicated GPU, CPU-only inference, ~32GB system RAM) and its caveats,
including why the GPU's reported 1GiB "VRAM" is not trusted as real.

A RAM/VRAM fit only means the model loads - it says nothing about
tokens/sec. On CPU-only hardware, prefer small, aggressively quantized
models (<=7-8B, Q4) for usable latency, and re-run describeOwnedDesktop()'s
source if the owner's hardware changes.
