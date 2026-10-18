---
name: unsafe-ce
description: Unlock the Cheat Engine tools that can crash the game or CE (Lua, code injection, breakpoints, DLL injection, .CT tables, Mono heap access), and the tools on games with an anti-cheat.
disable-model-invocation: true
---

# Unlock the crash-prone Cheat Engine tools

The user has explicitly asked for the unlock.

Call the `ce_safety_enable_writes` tool with `confirm="USER_CONFIRMED"`.

A confirmation dialog then opens in Cheat Engine: tell the user to answer it there (the tool waits up to 3 minutes). If the attached game embeds an anti-cheat, the dialog says so and warns that the account can be banned.

Then report the result:
- Confirmed: "Crash-prone Cheat Engine tools are now UNLOCKED until `/safe-ce`, or until Claude Code or CE restarts."
- Declined or no answer: everything stays locked; say so, and do not try again unless the user asks.

## What is now allowed
- `ce_lua` - arbitrary Lua in CE
- `ce_asm_inject`, `ce_asm_script`, `ce_code_entry` - change the game's code
- `ce_breakpoint` - debugger watchpoints (some games detect debuggers)
- `ce_speedhack`, `ce_d3d_init`, `ce_mono_init` - inject CE's DLLs into the game
- `ce_table_load` - .CT tables can run Lua and auto assembler scripts
- `ce_mono_find_instances`, Mono static fields (`ce_mono_static`, and static reads/writes of the other Mono tools) - crashed some Unity games in the past
- Every tool on a game with an anti-cheat (blocked in SAFE mode, attaching included)

Reading, scanning, writing values, freezing and watching are always allowed on games without an anti-cheat (unless the plugin's read-only option is on).

## Reminder
- Only use on processes the user owns or controls
- Save the game first: these tools can crash it
- On a game with an anti-cheat, stay offline: online play, leaderboards or cloud saves can get the account banned
