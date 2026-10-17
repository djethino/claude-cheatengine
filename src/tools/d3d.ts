/**
 * Text overlays drawn inside the game by CE's D3D hook (DirectX 9/10/11), and window screenshots.
 */

import { writeFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { z } from 'zod';
import { lua } from '../lua/lit.js';
import { defineTool } from './registry.js';
import { captureWindow } from '../capture.js';

/** "RRGGBB" to the Windows BGR integer CE fonts use. */
function bgr(hex: string): number {
  const rgb = parseInt(hex, 16);
  return ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff);
}

const overlayId = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default('mcp_text').describe('Overlay name, to update or remove it later');

export const d3dTools = [
  defineTool({
    name: 'ce_d3d_init',
    description: "Hook the game's Direct3D (9, 10 or 11) so overlays can be drawn in it. Can only be done once per game process.",
    schema: {},
    writes: true,
    dangerous: true,
    requiresProcess: true,
    async run(_args, ctx) {
      const text = await ctx.run(
        lua`
          _mcp.d3d = _mcp.d3d or {}
          if _mcp.d3d.pid ~= getOpenedProcessID() then
            local ok, hook = pcall(createD3DHook)
            if not ok or not hook then _mcp_str = 'Error: D3D hook failed: ' .. tostring(hook) .. ' (DirectX 9/10/11 games only)' return end
            _mcp.d3d = { pid = getOpenedProcessID(), hook = hook, fonts = {}, overlays = {} }
          end
          local h = _mcp.d3d.hook
          _mcp_str = (h.Width or 0) > 0 and string.format('D3D hook ready (%dx%d)', h.Width, h.Height)
            or 'D3D hook ready (the resolution is known once the game renders a frame)'`,
        { timeoutMs: 60_000 },
      );
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_d3d_overlay_text',
    description: `Show text inside the game (D3D hook, see ce_d3d_init). Calling it again with the same id updates that overlay.

Only ASCII characters 32-126 are drawn (CE's font maps).`,
    schema: {
      text: z.string().describe('Text to show'),
      x: z.number().int().default(10).describe('X position in pixels from the left'),
      y: z.number().int().default(10).describe('Y position in pixels from the top'),
      color: z.string().regex(/^[0-9a-fA-F]{6}$/).default('FFFFFF').describe('Color as RRGGBB, e.g. FF0000 for red'),
      font_size: z.number().int().min(6).max(96).default(14).describe('Font size in points'),
      id: overlayId,
    },
    writes: true,
    requiresProcess: true,
    async run({ text, x, y, color, font_size, id }, ctx) {
      const unsupported = [...text].filter((c) => c < ' ' || c > '~');
      const result = await ctx.run(lua`
        local d3d = _mcp.d3d
        if not d3d or d3d.pid ~= getOpenedProcessID() then _mcp_str = 'Error: D3D hook not initialized for this process: run ce_d3d_init first' return end
        local key = ${`${font_size}/${color.toUpperCase()}`}
        local fontmap = d3d.fonts[key]
        local hook = d3d.hook
        hook.beginUpdate()
        if not fontmap then
          local font = createFont()
          font.Name = 'Arial'
          font.Size = ${font_size}
          font.Color = ${bgr(color)}
          fontmap = hook.createFontmap(font)
          d3d.fonts[key] = fontmap
        end
        local overlay = d3d.overlays[${id}]
        if overlay then
          overlay.FontMap = fontmap
          overlay.Text = ${text}
          overlay.X, overlay.Y = ${x}, ${y}
        else
          d3d.overlays[${id}] = hook.createTextContainer(fontmap, ${x}, ${y}, ${text})
        end
        hook.endUpdate()
        _mcp_str = string.format('Overlay %s %s at (%d, %d)', ${id}, overlay and 'updated' or 'created', ${x}, ${y})
        if (hook.Width or 0) == 0 then
          _mcp_str = _mcp_str .. '\nWarning: the D3D hook has not seen any frame of the game yet (resolution 0x0): the overlay will not show if the hook does not work with this game'
        end`);
      if (result && unsupported.length) return `${result}\nNote: ${unsupported.length} character(s) outside ASCII 32-126 are not drawn`;
      return result ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_d3d_overlay_remove',
    description: 'Remove a text overlay (or all of them).',
    schema: { id: overlayId.optional().describe('Overlay name (default: all overlays)') },
    writes: false,
    async run({ id }, ctx) {
      const text = await ctx.run(lua`
        local d3d = _mcp.d3d
        if not d3d then _mcp_str = 'No overlays' return end
        local count = 0
        for name, overlay in pairs(d3d.overlays) do
          if ${id ?? ''} == '' or name == ${id ?? ''} then
            overlay.destroy()
            d3d.overlays[name] = nil
            count = count + 1
          end
        end
        if count == 0 and ${id ?? ''} ~= '' then _mcp_str = 'Error: no overlay named ' .. ${id ?? ''} return end
        _mcp_str = string.format('Removed %d overlay(s)', count)`);
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_screenshot',
    description: `Look at the game: a screenshot of the attached process's window, returned as an image (any graphics API; the window must not be minimized).

By default nothing is written to disk. Give save_path to also keep the PNG file.`,
    schema: {
      max_width: z.number().int().min(320).max(3840).default(1280).describe('Scale the image down to this width (smaller costs less context)'),
      save_path: z.string().default('').describe('Also write the PNG to this file (absolute, or relative to the server working directory)'),
    },
    writes: ({ save_path }) => save_path !== '',
    requiresProcess: true,
    async run({ max_width, save_path }, ctx) {
      const pidText = await ctx.run(lua`_mcp_str = tostring(getOpenedProcessID())`);
      const pid = Number(pidText);
      if (!Number.isInteger(pid) || pid <= 0) return pidText ?? 'Error: no process attached';
      let capture;
      try {
        capture = await captureWindow(pid, max_width);
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
      let saved = '';
      if (save_path) {
        const path = isAbsolute(save_path) ? save_path : resolve(process.cwd(), save_path);
        writeFileSync(path, capture.png);
        saved = `, saved to ${path}`;
      }
      const size =
        capture.image.width === capture.window.width
          ? `${capture.window.width}x${capture.window.height}`
          : `${capture.window.width}x${capture.window.height} window, scaled to ${capture.image.width}x${capture.image.height}`;
      return {
        text: `Screenshot of PID ${pid} (${size}${saved})`,
        image: { data: capture.png.toString('base64'), mimeType: 'image/png' },
      };
    },
  }),
];
