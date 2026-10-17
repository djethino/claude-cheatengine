-- Fake memscan (createMemScan / createFoundList) over the fake memory (0x400000-0x402000).
-- Supports the options the scan tools set: integer and float types, exact/between/bigger/smaller,
-- unknown, changed/unchanged/increased/decreased(+by), saved results, byte arrays with ??.

local LOW, HIGH = 0x400000, 0x402000
local SIZES = { vtByte = 1, vtWord = 2, vtDword = 4, vtQword = 8, vtSingle = 4, vtDouble = 8 }

local function readAs(vt, a)
  if vt == 'vtByte' then return readBytes(a, 1) end
  if vt == 'vtWord' then return readSmallInteger(a, true) end
  if vt == 'vtDword' then return readInteger(a, true) end
  if vt == 'vtQword' then return readQword(a) end
  if vt == 'vtSingle' then return readFloat(a) end
  if vt == 'vtDouble' then return readDouble(a) end
end

local function parse(ms, text)
  if ms.Hexadecimal then return tonumber(text, 16) end
  return tonumber(text)
end

local function matchesAob(a, tokens)
  for i, t in ipairs(tokens) do
    local b = readBytes(a + i - 1, 1)
    if b == nil then return false end
    if t ~= '??' and b ~= tonumber(t, 16) then return false end
  end
  return true
end

local function test(ms, option, v, old)
  local x, y = ms.x, ms.y
  if option == 'soExactValue' then return v == x end
  if option == 'soValueBetween' then return v >= x and v <= y end
  if option == 'soBiggerThan' then return v > x end
  if option == 'soSmallerThan' then return v < x end
  if option == 'soUnknownValue' then return true end
  if option == 'soChanged' then return v ~= old end
  if option == 'soUnchanged' then return v == old end
  if option == 'soIncreasedValue' then return v > old end
  if option == 'soDecreasedValue' then return v < old end
  if option == 'soIncreasedValueBy' then return v == old + x end
  if option == 'soDecreasedValueBy' then return v == old - x end
  error('fake memscan: unsupported option ' .. tostring(option))
end

local function scan(ms, previous)
  ms.ErrorString = ''
  local results, values = {}, {}
  if ms.VarType == 'vtByteArray' then
    local tokens = {}
    for t in ms.Scanvalue1:gmatch('%S+') do tokens[#tokens + 1] = t end
    for a = math.max(LOW, ms.Startaddress), math.min(HIGH, ms.Stopaddress) - #tokens do
      if matchesAob(a, tokens) then results[#results + 1] = a values[a] = ms.Scanvalue1 end
    end
  else
    local needsValue = ms.ScanOption ~= 'soUnknownValue' and ms.ScanOption ~= 'soChanged' and ms.ScanOption ~= 'soUnchanged'
      and ms.ScanOption ~= 'soIncreasedValue' and ms.ScanOption ~= 'soDecreasedValue'
    if needsValue then
      ms.x, ms.y = parse(ms, ms.Scanvalue1), parse(ms, ms.Scanvalue2 ~= '' and ms.Scanvalue2 or '0')
      if ms.x == nil then ms.ErrorString = ms.Scanvalue1 .. ' is an invalid value' return end
    end
    local step = ms.Fastscanmethod == 'fsmAligned' and tonumber(ms.Fastscanparameter) or 1
    local candidates = {}
    if previous then
      for _, a in ipairs(previous.results) do candidates[#candidates + 1] = a end
    else
      for a = math.max(LOW, ms.Startaddress), math.min(HIGH, ms.Stopaddress) - SIZES[ms.VarType], step do candidates[#candidates + 1] = a end
    end
    for _, a in ipairs(candidates) do
      local v = readAs(ms.VarType, a)
      if v ~= nil and test(ms, ms.ScanOption, v, previous and previous.values[a]) then
        results[#results + 1] = a
        values[a] = v
      end
    end
  end
  ms.results, ms.values = results, values
  ms.FoundCount = #results
  ms.Results = results
end

function createMemScan()
  local ms = { FoundCount = 0, ErrorString = '', saved = {}, results = {}, values = {}, Hexadecimal = false,
               Startaddress = 0, Stopaddress = 0x7FFFFFFFFFFFFFFF, Scanvalue1 = '', Scanvalue2 = '' }
  ms.firstScan = function() scan(ms, nil) end
  ms.nextScan = function()
    local previous = { results = ms.results, values = ms.values }
    if ms.CompareToSavedScan then previous.values = ms.saved[ms.SavedScanName] end
    scan(ms, previous)
  end
  ms.waitTillDone = function() return true end
  ms.getProgress = function() return { TotalAddressesToScan = 100, CurrentlyScanned = 100, ResultsFound = ms.FoundCount } end
  ms.saveCurrentResults = function(name)
    local copy = {}
    for a, v in pairs(ms.values) do copy[a] = v end
    ms.saved[name] = copy
  end
  ms.getSavedResultList = function()
    local names = {}
    for name in pairs(ms.saved) do names[#names + 1] = name end
    return names
  end
  ms.destroy = function() ms.destroyed = true end
  return ms
end

function createFoundList(ms)
  local fl = { Count = 0, Address = {}, Value = {} }
  fl.initialize = function()
    fl.Count = #ms.results
    for i, a in ipairs(ms.results) do
      fl.Address[i - 1] = string.format('%08X', a)
      local v = ms.values[a]
      fl.Value[i - 1] = math.type(v) == 'float' and string.format('%g', v) or tostring(v)
    end
  end
  fl.deinitialize = function() end
  fl.destroy = function() end
  return fl
end
