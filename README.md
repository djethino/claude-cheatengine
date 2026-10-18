# asymptomatik-cheatengine

Drive [Cheat Engine](https://www.cheatengine.org) from Claude Code: attach to a game, scan for values, read and write memory, follow pointers, watch what code touches an address, patch code, inspect Mono / IL2CPP (Unity) objects, take screenshots — by asking Claude in plain language.

```
You: find my health in the tutorial, it's 100 and drops when I click "Hit me"
Claude: [unknown scan] → [decreased] → [between 1 and 99] → 0x015887E0 = 85
        [watchpoint] → written by "sub [rbx+00000800],edx" at Tutorial-x86_64.exe+47F6D
        [pointer scan] → ["Tutorial-x86_64.exe"+346C10]+800 (static, survives restarts)
```

Everything runs on your machine: the plugin talks to Cheat Engine through a local named pipe; nothing is sent anywhere else.

> Use it on games and programs you own, single-player or offline. Online games' terms of service usually forbid memory editing, and anti-cheat systems can ban you.

## Requirements

- Windows
- **Cheat Engine 7.7 or later** (the plugin refuses older versions: it relies on 7.7's scan API)
- **Node.js 22.13 or later** on your `PATH` (`node --version`)
- Claude Code

## Installation

1. In Claude Code:
   ```
   /plugin marketplace add djethino/asymptomatik-claude-plugins
   /plugin install asymptomatik-cheatengine@asymptomatik
   ```
   Restart Claude Code.
2. Install the Cheat Engine side, once:
   ```
   /ce-install
   ```
   It finds Cheat Engine (registry or Program Files) and writes a small loader into its `autorun` folder. A Windows administrator prompt appears if that folder is not writable.
3. Restart Cheat Engine. Its main window now has an **MCP** menu and a status label.
4. Ask Claude to check: "ce_status" — it should say `Connected: Lua 5.3 - CE 7.7 ...` and `loader installed`.

Updates of the plugin reach Cheat Engine by themselves: the loader runs a per-user copy of the CE script (`%LOCALAPPDATA%\cheatengine-mcp\`) that the plugin refreshes at every start. A running Cheat Engine keeps the script it started with: `ce_status` says when it runs an older copy, and `ce_restart` restarts it. `/ce-install` is only needed again if `ce_status` reports the loader as missing or outdated.

## Safety

Two independent locks, plus an anti-cheat guard:

| | What it locks | Default | Change it |
|---|---|---|---|
| **SAFE mode** | The tools that can **crash the game or Cheat Engine**: `ce_lua`, code injection (`ce_asm_inject`, `ce_asm_script` except its syntax check `check_only`, `ce_code_entry`), debugger watchpoints (`ce_breakpoint`), DLL injection (`ce_speedhack`, `ce_d3d_init`, `ce_mono_init`), `.CT` tables (they can run scripts), `ce_mono_find_instances`, Mono static fields | **On** at every start | `/unsafe-ce` and `/safe-ce`, or *Mode* in CE's MCP menu. Claude cannot run `/unsafe-ce` itself, and the unlock only happens once **you click Yes in a dialog in Cheat Engine** |
| **Anti-cheat guard** | **Every tool** on a process that embeds an anti-cheat (EasyAntiCheat, BattlEye, Vanguard, XIGNCODE (Wellbia), nProtect GameGuard, ACE, mhyprot, EQU8, FACEIT, Denuvo Anti-Cheat, or Unity's Anti-Cheat Toolkit): even attaching | On, in SAFE mode | Claude must first tell you why (your account can be banned); only `/unsafe-ce` lifts it. Its CE dialog names the anti-cheat when the protected game is already attached in CE; otherwise the warning comes from Claude, when the attach is refused |
| **Read-only option** | Everything that **changes the game or writes a file** (memory writes, freezes, hotkeys, patches, table saves...) | Off | `/plugin configure asymptomatik-cheatengine` → `read_only` |

Reading, scanning, writing values and freezing are what Cheat Engine is for: they stay available in SAFE mode.

Every tool parameter reaches Cheat Engine's Lua as data, never as code, so no input — a process name with a quote, a string read from the game — can run commands of its own.

## What you can ask

| Area | Tools |
|---|---|
| Connection | `ce_status`, `ce_get_logs`, `ce_output_more` (rest of a long output) |
| Cheat Engine itself | `ce_launch`, `ce_restart` (asks you first when something would be lost), `ce_dialogs`, `ce_dialog_close` (information dialogs only) |
| Processes and memory | `ce_attach`, `ce_list_processes`, `ce_list_modules`, `ce_memory_regions`, `ce_process_info`, `ce_read_memory`, `ce_write_memory`, `ce_value_change`, `ce_sample_value` (how a value moves over time), `ce_resolve_address`, `ce_disassemble`, `ce_struct_view` |
| Value scans | `ce_scan_value`, `ce_scan_next`, `ce_aob_scan` (byte patterns), `ce_scan_results`, `ce_scan_list`, `ce_scan_reset`, `ce_scan_add_to_table`, `ce_snapshot_create`, `ce_snapshot_compare` |
| Pointers | `ce_pointer_scan` (static pointer chains, several levels) |
| Address list (cheat table) | `ce_watch_add`, `ce_watch_list`, `ce_watch_modify`, `ce_watch_remove`, `ce_watch_clear`, `ce_freeze`, `ce_unfreeze`, `ce_freeze_list`, `ce_hotkey_add`, `ce_record_activate`, `ce_table_save`, `ce_table_load` |
| Code and debugging | `ce_breakpoint`, `ce_breakpoint_results`, `ce_breakpoint_remove`, `ce_asm_inject`, `ce_asm_script`, `ce_code_entry`, `ce_speedhack`, `ce_lua` |
| Mono / IL2CPP (Unity) | `ce_mono_init`, `ce_mono_assemblies`, `ce_mono_classes`, `ce_mono_fields`, `ce_mono_methods`, `ce_mono_read_field`, `ce_mono_write_field`, `ce_mono_static`, `ce_mono_dump`, `ce_mono_find_instances` |
| Screen | `ce_screenshot`, `ce_d3d_init`, `ce_d3d_overlay_text`, `ce_d3d_overlay_remove` |
| Long operations | `ce_job_status`, `ce_job_cancel`, `ce_job_list` |
| Setup | `ce_install_plugin` (through `/ce-install`), `ce_safety_status`, `ce_safety_enable_writes` / `ce_safety_disable_writes` (through `/unsafe-ce` / `/safe-ce`) |

Some details worth knowing:

- **Dialogs never leave Claude waiting blind.** When a call opens a dialog in Cheat Engine (an auto assembler error, a Mono failure...), the call stops at once and says what the dialog is. Claude may close a dialog that only informs (one button) after reading it; a dialog that asks something (Yes/No) is always yours to answer. Dialogs you open yourself in CE's window do not get in the way.
- **Long operations do not freeze Cheat Engine.** Scans, AOB scans, pointer scans, value sampling and instance searches run in the background with a progress window (with a Cancel button) in CE, and send progress notifications to Claude Code. Most take `wait=false` to get a job id at once and check it later.
- **Scans are Claude's own**: they never touch the scan you run by hand in CE's main window. Several named scans can run side by side (`scan_name`).
- **Code changes go through the address list**: `ce_asm_inject`, `ce_asm_script` and `ce_code_entry` create auto assembler entries you can see and toggle in CE; disabling one restores the original code.
- **Unity fields by name**: `ce_mono_read_field` / `ce_mono_write_field` use the field's real .NET type. Values protected by the Anti-Cheat Toolkit (`ObscuredInt`, `ObscuredFloat`...) are decrypted, and written back encrypted with their honeypot kept in step; a decoding that the honeypot does not confirm is never written. On such a game the anti-cheat guard applies first.
- **Screenshots stay off the disk** by default: the image goes straight to Claude. They show the game's picture without the window frame (`client_only`), and `region` zooms on a part at full resolution. Give `save_path` to keep the PNG. The game window must not be minimized.
- **Lists are paginated** (`offset`, `limit`, `filter`), and long outputs end with a line telling Claude how to read the rest.

## Troubleshooting

**`Not connected: Cannot connect to \\.\pipe\ce-mcp`** — Cheat Engine is not running (Claude can start it with `ce_launch`), or its MCP plugin is not loaded. Check `ce_status` (loader state), run `/ce-install` if needed, restart CE, and check that CE's *MCP* menu shows the server as started.

**Status label `MCP: OFF (other CE)`** — another Cheat Engine already serves Claude Code: only one does, so that an unlock and a lock never land in different Cheat Engines. Work in that one, or close it and use *Start Server* in this one's MCP menu. `ce_status` warns when several Cheat Engines run.

**`Cheat Engine 7.7 or later is required`** — update Cheat Engine.

**`ce_status`: "Cheat Engine runs an older copy of the plugin script"** — the plugin was updated while Cheat Engine was running: restart Cheat Engine to load the new script.

**`BLOCKED: anti-cheat detected in ...`** — the game embeds an anti-cheat (see Safety). Using Cheat Engine on it can get your account banned; if you accept the risk (offline game, no account), run `/unsafe-ce` and confirm in Cheat Engine.

**`Cheat Engine is blocked by a dialog`** — a call opened a dialog in Cheat Engine and waits for it. The message says whether it only informs (Claude closes it after reading it with `ce_dialogs`) or asks you something (answer it in CE). The result of that call is lost: Claude checks the state afterwards.

**`Cheat Engine did not answer within ... s`** — the operation is still running in CE, or CE is stuck. The next call reconnects by itself; `ce_restart` restarts CE.

**`Another Claude Code session is using Cheat Engine`** — two Claude Code sessions cannot drive the same Cheat Engine at once (their calls would mix). The message tells Claude how to take it over if you want this session to.

**Overlays do not show** — CE's D3D hook only supports DirectX 9, 10 and 11, and does not work with every game. The overlay tool warns when the hook has not seen any frame of the game.

**Mono tools fail** — run `ce_mono_init` first (it injects CE's collector DLL, so it needs `/unsafe-ce`, and can take a minute); Mono tools only apply to .NET / Unity games.

## How it works

The MCP server (`dist/index.js`, Node.js, no runtime dependency) connects to the Lua server Cheat Engine opens on a named pipe (`openLuaServer`, started by the CE-side plugin). Each tool call becomes one Lua chunk that also applies the SAFE gate and the anti-cheat guard, so the checks cannot be skipped; results come back through CE's pipe protocol. Calls are serialized: Cheat Engine runs every pipe script on its single Lua state.

Development: `npm run build` (type check + bundle; `dist/` is committed because Claude Code does not build plugins), `npm test` (offline, against a fake Cheat Engine that runs the generated Lua in a real Lua interpreter).

## License

MIT — Copyright (c) 2025 ASymptOmatik
