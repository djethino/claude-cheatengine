/**
 * Lists built, filtered and paginated inside CE, so only the requested page crosses the pipe.
 */

import { z } from 'zod';
import { lua, type LuaCode } from '../lua/lit.js';

export const pageSchema = (defaultLimit: number) => ({
  filter: z.string().default('').describe('Optional case-insensitive substring an entry must contain'),
  offset: z.number().int().min(0).default(0).describe('Number of matching entries to skip (use the offset given in "next page")'),
  limit: z.number().int().min(1).max(1000).default(defaultLimit).describe('Maximum number of entries to return'),
});

export interface Page {
  filter: string;
  offset: number;
  limit: number;
}

/**
 * Body that runs `collect` (which appends one display line per entry to the local table `items`,
 * or sets _mcp_str and returns to report a precondition failure), then keeps the requested page.
 */
export function listBody(collect: LuaCode, noun: string, { filter, offset, limit }: Page): LuaCode {
  return lua`
    local items = {}
    local collected = (function()
      ${collect}
      return true
    end)()
    if not collected then return end
    local noun = ${noun}
    local needle = string.lower(${filter})
    local suffix = needle ~= '' and (' matching ' .. string.format('%q', ${filter})) or ''
    local matched = {}
    for _, line in ipairs(items) do
      if needle == '' or string.find(string.lower(line), needle, 1, true) then
        matched[#matched + 1] = line
      end
    end
    local total, first = #matched, ${offset} + 1
    local last = math.min(total, ${offset} + ${limit})
    local out = {}
    if total == 0 then
      out[1] = 'No ' .. noun .. suffix
    elseif first > total then
      out[1] = string.format('offset=%d is past the end: %d %s%s', ${offset}, total, noun, suffix)
    else
      out[1] = string.format('%s %d-%d of %d%s', noun, first, last, total, suffix)
      for i = first, last do out[#out + 1] = matched[i] end
      if last < total then
        out[#out + 1] = string.format('... %d more, next page: offset=%d', total - last, last)
      end
    end
    _mcp_str = table.concat(out, '\n')`;
}
