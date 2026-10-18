---
name: safe-ce
description: Lock the crash-prone Cheat Engine tools again (SAFE mode).
---

# Lock the crash-prone Cheat Engine tools

Call the `ce_safety_disable_writes` tool.

Then confirm: "Crash-prone Cheat Engine tools are LOCKED again (SAFE mode). Reading, scanning, writing values, freezing and watching stay available, except on games with an anti-cheat."

Locked until `/unsafe-ce`: `ce_lua`, `ce_asm_inject`, `ce_asm_script`, `ce_code_entry`, `ce_breakpoint`, `ce_speedhack`, `ce_d3d_init`, `ce_mono_init`, `ce_table_load`, `ce_mono_find_instances`, Mono static fields, and every tool on a game with an anti-cheat.
