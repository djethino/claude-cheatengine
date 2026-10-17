/**
 * Static pointers to an address: CE's native memory scan finds every pointer-sized value in
 * [target - max_offset, target] (a pointer to the start of the structure holding the target),
 * then only those stored inside a module are kept (static addresses survive a game restart).
 * The Python version read every 8 bytes of each module from Lua in one blocking call (and read 8
 * bytes on 32-bit targets).
 */

import { z } from 'zod';
import { lua } from '../lua/lit.js';
import { defineTool } from './registry.js';
import { resolveAddress } from './memory.js';
import { runJob, waitSchema } from './jobs.js';

export const pointerTools = [
  defineTool({
    name: 'ce_pointer_scan',
    description: `Find static pointers to an address (one level): module addresses holding a pointer to the address or to a structure containing it, e.g. "[game.exe+1A2B0] + 0x48 = target". Static addresses stay valid across game restarts, unlike the target.

Runs in the background with a progress window. For deeper chains, use the result as the new target.`,
    schema: {
      address: z.string().describe('Target address (a value found by a scan)'),
      max_offset: z.number().int().min(0).max(0x100000).default(0x1000).describe('Largest offset from the pointer to the target (default 0x1000)'),
      max_results: z.number().int().min(1).max(1000).default(50).describe('Maximum number of pointers listed'),
      ...waitSchema,
    },
    writes: false,
    requiresProcess: true,
    async run({ address, max_offset, max_results, wait }, ctx) {
      const kind = 'pointer scan';
      return runJob(
        ctx,
        kind,
        lua`(function()
          ${resolveAddress(address, 'target')}
          local is64 = targetIs64Bit()
          local low = math.max(0, target - ${max_offset})
          local ms = createMemScan()
          ms.VarType = is64 and 'vtQword' or 'vtDword'
          ms.ScanOption = 'soValueBetween'
          ms.Hexadecimal = true
          ms.Scanvalue1 = string.format('%X', low)
          ms.Scanvalue2 = string.format('%X', target)
          ms.Startaddress = 0
          ms.Stopaddress = is64 and 0x7FFFFFFFFFFFFFFF or 0xFFFFFFFF
          ms.ScanWritable = 'scanDontCare'
          ms.ScanExecutable = 'scanDontCare'
          ms.ScanCopyOnWrite = 'scanDontCare'
          ms.Fastscanmethod = 'fsmAligned'
          ms.Fastscanparameter = is64 and '8' or '4'
          ms.firstScan()
          return {
            kind = ${kind}, window = true,
            run = function(job) ms.waitTillDone() end,
            update = function(job)
              local p = ms.getProgress()
              if p and p.TotalAddressesToScan and p.TotalAddressesToScan > 0 then
                job.total, job.done = p.TotalAddressesToScan, p.CurrentlyScanned
                job.message = string.format('pointer scan: %d candidates', p.ResultsFound or 0)
              end
            end,
            finish = function(job)
              local err = ms.ErrorString
              if err and err ~= '' then ms.destroy() error('scan error: ' .. err, 0) end
              local candidates = ms.Results or {}
              ms.destroy()
              local found = {}
              for _, a in ipairs(candidates) do
                if inModule(a) then
                  local ptr = readPointer(a)
                  if ptr and ptr <= target and target - ptr <= ${max_offset} then found[#found + 1] = { a = a, off = target - ptr } end
                end
              end
              -- Smallest offsets first: they most likely point to the structure that holds the value
              table.sort(found, function(x, y) if x.off ~= y.off then return x.off < y.off end return x.a < y.a end)
              local out = { string.format('%d static pointer(s) to 0x%X (%d candidates outside modules ignored)', #found, target, #candidates - #found) }
              for i = 1, math.min(#found, ${max_results}) do
                local f = found[i]
                out[#out + 1] = string.format('  [%s] + 0x%X = target', getNameFromAddress(f.a), f.off)
              end
              if #found > ${max_results} then out[#out + 1] = string.format('  ... %d more (raise max_results)', #found - ${max_results}) end
              if #found == 0 then out[#out + 1] = 'None at one level: scan for pointers to a structure further up (larger max_offset), or use CE\'s pointer scanner for deep chains' end
              return table.concat(out, '\n')
            end,
          }
        end)()`,
        wait,
      );
    },
  }),
];
