---
name: ce-install
description: Install or repair the Cheat Engine side of the plugin (autorun loader). Use when ce_status reports the loader as missing or outdated.
disable-model-invocation: true
---

# Install the Cheat Engine plugin

The user has explicitly asked to install the CE-side plugin.

Call the `ce_install_plugin` tool with `confirm="USER_CONFIRMED"`. If the user gave a Cheat Engine folder, pass it as `ce_dir`.

Then report its output to the user, and tell them:
- A Windows administrator prompt may have appeared if the Cheat Engine folder is not writable.
- Cheat Engine must be restarted to load the plugin.
- Later plugin updates are applied automatically at the next Claude Code and Cheat Engine restart; `/ce-install` is only needed again if `ce_status` reports the loader as missing or outdated.
- Cheat Engine 7.7 or later is required.
