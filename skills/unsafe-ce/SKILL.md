---
name: unsafe-ce
description: Unlock the Cheat Engine tools that can crash the game or CE (Lua, code injection, breakpoints, DLL injection, .CT tables, Mono heap access).
disable-model-invocation: true
---

# Unlock the crash-prone Cheat Engine tools

The user has explicitly authorized the crash-prone tools.

Call the `ce_safety_enable_writes` tool with `confirm="USER_CONFIRMED"`.

Then confirm: "Crash-prone Cheat Engine tools are now UNLOCKED until `/safe-ce`, or until Claude Code or CE restarts."

## What is now allowed
- `ce_lua` - arbitrary Lua in CE
- `ce_asm_inject`, `ce_asm_script`, `ce_code_entry` - change the game's code
- `ce_breakpoint` - debugger watchpoints (some games detect debuggers)
- `ce_speedhack`, `ce_d3d_init`, `ce_mono_init` - inject CE's DLLs into the game
- `ce_table_load` - .CT tables can run Lua and auto assembler scripts
- `ce_mono_find_instances`, `ce_mono_static` (and Mono static reads) - crashed some Unity games in the past

Reading, scanning, writing values, freezing and watching are always allowed (unless the plugin's read-only option is on).

## Reminder
- Only use on processes the user owns or controls
- Save the game first: these tools can crash it
