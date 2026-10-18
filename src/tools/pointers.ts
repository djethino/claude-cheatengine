/**
 * Static pointer chains to an address, searched backwards one level at a time with CE's native
 * memory scan (the Python version read every 8 bytes of each module from Lua in one blocking call).
 *
 * Level 1 finds every pointer-sized value in [target - max_offset, target] (a pointer to the start
 * of the structure holding the target). Those stored inside a module are static: they survive a
 * game restart. The others (heap) become the targets of the next level, the closest ones first, so
 * "[[game.exe+1A2B0] + 0x10] + 0x48 = target" is found by two levels. The candidates of a level
 * are merged into address ranges, each range being one scan job (scans start on CE's main thread
 * and are waited for in the job's thread, like every other scan).
 */

import { z } from 'zod';
import { lua } from '../lua/lit.js';
import { defineTool } from './registry.js';
import { resolveAddress } from './memory.js';
import { runJob } from './jobs.js';

/** Lua: the state of pointer scan `id` into local `ps`, or report and return. */
function scanState(id: number) {
  return lua`
    local ps = (_mcp.pointerScans or {})[${id}]
    if not ps then _mcp_str = 'Error: pointer scan state lost (Cheat Engine restarted?)' return end`;
}

export const pointerTools = [
  defineTool({
    name: 'ce_pointer_scan',
    description: `Find static pointer chains to an address: module addresses from which the address can be reached through pointers, e.g. "[game.exe+1A2B0] + 0x48 = target" (1 level) or "[[game.exe+5F00] + 0x10] + 0x48 = target" (2 levels). Static addresses stay valid across game restarts, unlike the target; the offsets go as is to ce_watch_add.

A chain can also hold by chance: check it once the game has moved its objects (restart, new level, the game's own "change pointer"), and keep the ones that still lead to the value.

Each level runs memory scans in the background with a progress window: level 1 is one scan, each deeper level one scan per group of nearby candidates (max_candidates), so deep searches take longer.`,
    schema: {
      address: z.string().describe('Target address (a value found by a scan)'),
      max_offset: z.number().int().min(0).max(0x100000).default(0x1000).describe('Largest offset from a pointer to what it points into (default 0x1000)'),
      max_level: z.number().int().min(1).max(5).default(2).describe('Longest chain searched (pointer levels)'),
      max_candidates: z.number().int().min(1).max(100).default(50).describe('Heap pointers followed to the next level, closest offsets first (too few can miss the real chain)'),
      max_results: z.number().int().min(1).max(1000).default(50).describe('Maximum number of chains listed'),
    },
    writes: false,
    requiresProcess: true,
    async run({ address, max_offset, max_level, max_candidates, max_results }, ctx) {
      const started = await ctx.run(lua`
        ${resolveAddress(address, 'target')}
        _mcp.pointerScans = _mcp.pointerScans or {}
        _mcp.nextPointerScan = (_mcp.nextPointerScan or 0) + 1
        _mcp.pointerScans[_mcp.nextPointerScan] = { target = target, maxOffset = ${max_offset}, statics = {}, visited = {},
          next = { { address = target } }, notes = {}, scans = 0 }
        _mcp_str = tostring(_mcp.nextPointerScan)`);
      const id = Number(started);
      if (!started || !Number.isInteger(id)) return started ?? 'Error: no answer from Cheat Engine';
      let stopped = '';
      for (let level = 1; level <= max_level && !stopped; level++) {
        // The closest candidates of the previous level, merged into ranges to scan
        const prepared = await ctx.run(lua`
          ${scanState(id)}
          table.sort(ps.next, function(x, y) if (x.offset or 0) ~= (y.offset or 0) then return (x.offset or 0) < (y.offset or 0) end return x.address < y.address end)
          if #ps.next > ${max_candidates} then
            ps.notes[#ps.notes + 1] = string.format('level %d: followed the %d closest of %d heap pointers (raise max_candidates)', ${level}, ${max_candidates}, #ps.next)
          end
          ps.frontier = {}
          for i = 1, math.min(#ps.next, ${max_candidates}) do ps.frontier[i] = ps.next[i] end
          ps.next = {}
          if #ps.frontier > 0 then ps.level = ${level} end
          table.sort(ps.frontier, function(x, y) return x.address < y.address end)
          ps.ranges = {}
          for _, n in ipairs(ps.frontier) do
            local low, last = math.max(0, n.address - ps.maxOffset), ps.ranges[#ps.ranges]
            if last and low <= last.high + 1 then last.high = math.max(last.high, n.address)
            else ps.ranges[#ps.ranges + 1] = { low = low, high = n.address } end
          end
          _mcp_str = tostring(#ps.ranges)`);
        const ranges = Number(prepared);
        if (!prepared || !Number.isInteger(ranges)) return prepared ?? 'Error: no answer from Cheat Engine';
        if (ranges === 0) break;
        for (let range = 1; range <= ranges; range++) {
          const kind = `pointer scan level ${level}/${max_level}, scan ${range}/${ranges}`;
          const result = await runJob(
            ctx,
            kind,
            lua`(function()
              ${scanState(id)}
              local r = ps.ranges[${range}]
              local is64 = targetIs64Bit()
              local ms = createMemScan()
              ms.VarType = is64 and 'vtQword' or 'vtDword'
              ms.ScanOption = 'soValueBetween'
              ms.Hexadecimal = true
              ms.Scanvalue1 = string.format('%X', r.low)
              ms.Scanvalue2 = string.format('%X', r.high)
              ms.Startaddress = 0
              ms.Stopaddress = is64 and 0x7FFFFFFFFFFFFFFF or 0xFFFFFFFF
              ms.ScanWritable = 'scanDontCare'
              ms.ScanExecutable = 'scanDontCare'
              ms.ScanCopyOnWrite = 'scanDontCare'
              ms.Fastscanmethod = 'fsmAligned'
              ms.Fastscanparameter = is64 and '8' or '4'
              ms.firstScan()
              ps.scans = ps.scans + 1
              return {
                kind = ${kind}, window = true,
                run = function(job) ms.waitTillDone() end,
                update = function(job)
                  local p = ms.getProgress()
                  if p and p.TotalAddressesToScan and p.TotalAddressesToScan > 0 then
                    job.total, job.done = p.TotalAddressesToScan, p.CurrentlyScanned
                    job.message = string.format('%s: %d candidates', ${kind}, p.ResultsFound or 0)
                  end
                end,
                finish = function(job)
                  local err = ms.ErrorString
                  if err and err ~= '' then ms.destroy() error('scan error: ' .. err, 0) end
                  local results = ms.Results or {}
                  ms.destroy()
                  local frontier = ps.frontier
                  for _, a in ipairs(results) do
                    local p = not ps.visited[a] and readPointer(a)
                    if p then
                      -- The closest candidate at or above the pointed address
                      local lo, hi = 1, #frontier
                      while lo < hi do
                        local mid = (lo + hi) // 2
                        if frontier[mid].address < p then lo = mid + 1 else hi = mid end
                      end
                      local n = frontier[lo]
                      if n and n.address >= p and n.address - p <= ps.maxOffset then
                        ps.visited[a] = true
                        local node = { address = a, via = n, offset = n.address - p, level = ps.level }
                        if inModule(a) then ps.statics[#ps.statics + 1] = node else ps.next[#ps.next + 1] = node end
                      end
                    end
                  end
                  return 'ok'
                end,
              }
            end)()`,
            true,
          );
          if (result !== 'ok') {
            stopped = result;
            break;
          }
        }
      }
      const report = await ctx.run(lua`
        ${scanState(id)}
        _mcp.pointerScans[${id}] = nil
        local function offsets(node)
          local list, n = {}, node
          while n.via do list[#list + 1] = n.offset n = n.via end
          return list
        end
        local function total(node) local t = 0 for _, o in ipairs(offsets(node)) do t = t + o end return t end
        table.sort(ps.statics, function(x, y)
          if x.level ~= y.level then return x.level < y.level end
          local tx, ty = total(x), total(y)
          if tx ~= ty then return tx < ty end
          return x.address < y.address
        end)
        local out = { string.format('%d static pointer chain(s) to 0x%X (%d level(s) searched, %d memory scans)', #ps.statics, ps.target, ps.level or 0, ps.scans) }
        for i = 1, math.min(#ps.statics, ${max_results}) do
          local node = ps.statics[i]
          local expr, hex = '[' .. getNameFromAddress(node.address) .. ']', {}
          for j, o in ipairs(offsets(node)) do
            if j > 1 then expr = '[' .. expr .. ']' end
            expr = expr .. string.format(' + 0x%X', o)
            hex[j] = string.format('%X', o)
          end
          out[#out + 1] = string.format('  %s = target   (offsets: %s)', expr, table.concat(hex, ', '))
        end
        if #ps.statics > ${max_results} then out[#out + 1] = string.format('  ... %d more (raise max_results)', #ps.statics - ${max_results}) end
        if #ps.statics == 0 then out[#out + 1] = 'None found: raise max_level, max_offset or max_candidates' end
        for _, note in ipairs(ps.notes) do out[#out + 1] = 'Note: ' .. note end
        _mcp_str = table.concat(out, '\n')`);
      if (!report) return 'Error: no answer from Cheat Engine';
      return stopped ? `${report}\nStopped early: ${stopped}` : report;
    },
  }),
];
