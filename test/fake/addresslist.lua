-- Fake address list (getAddressList, memory records) over the fake memory.
-- A record's Value reads and writes the fake memory according to its VarType; scripts
-- (vtAutoAssembler) are "enabled" by setting Active, after autoAssembleCheck accepted them.

local records, nextId = {}, 0

local READ = {
  vtByte = function(a) return readBytes(a, 1) end, vtWord = function(a) return readSmallInteger(a, true) end,
  vtDword = function(a) return readInteger(a, true) end, vtQword = readQword, vtSingle = readFloat, vtDouble = readDouble,
}
local WRITE = {
  vtByte = function(a, v) return writeBytes(a, { v }) end, vtWord = writeSmallInteger, vtDword = writeInteger,
  vtQword = writeQword, vtSingle = writeFloat, vtDouble = writeDouble,
}

local function newRecord()
  local data = { ID = nextId, Description = '', Address = '', VarType = 'vtDword', Active = false, OffsetCount = 0,
                 OffsetText = {}, String = { Size = 32 }, hotkeys = {} }
  nextId = nextId + 1
  local mr = setmetatable({}, {
    __index = function(_, k)
      if k == 'Value' then
        if data.VarType == 'vtAutoAssembler' then return '' end
        local a = getAddressSafe(data.Address)
        local v = a and READ[data.VarType] and READ[data.VarType](a)
        if v == nil then return '??' end
        return math.type(v) == 'float' and string.format('%g', v) or tostring(v)
      end
      if k == 'Script' then return data.VarType == 'vtAutoAssembler' and data.Script or nil end
      if k == 'destroy' then return function() for i, r in ipairs(records) do if r.data == data then table.remove(records, i) end end end end
      if k == 'createHotkey' then
        return function(keys, action, value, description)
          local names = {}
          for _, code in ipairs(keys) do names[#names + 1] = code == 17 and 'Ctrl' or code == 18 and 'Alt' or code == 16 and 'Shift'
            or (code >= 112 and code <= 135) and ('F' .. (code - 111)) or string.char(code) end
          local hk = { Keys = keys, action = action, value = value, Description = description, HotkeyString = table.concat(names, '+') }
          data.hotkeys[#data.hotkeys + 1] = hk
          return hk
        end
      end
      return data[k]
    end,
    __newindex = function(_, k, v)
      if k == 'Value' then
        local a = getAddressSafe(data.Address)
        if a and WRITE[data.VarType] then WRITE[data.VarType](a, tonumber(v)) end
      elseif k == 'Active' and v and data.VarType == 'vtAutoAssembler' then
        data.Active = __fake.scriptsFail ~= true
      else
        data[k] = v
      end
    end,
  })
  records[#records + 1] = { data = data, mr = mr }
  return mr
end

local al = {}
setmetatable(al, { __index = function(_, k) if k == 'Count' then return #records end end })
al.createMemoryRecord = newRecord
al.getMemoryRecord = function(i) return records[i + 1] and records[i + 1].mr end
al.getMemoryRecordByID = function(id) for _, r in ipairs(records) do if r.data.ID == id then return r.mr end end end
al.clear = function() records = {} end
function getAddressList() return al end
AddressList = al

-- Auto assembler: a script "compiles" unless it contains the word INVALID
function autoAssembleCheck(script, enable)
  if script:find('INVALID') then return false, 'Error in line 2 (INVALID) :This instruction can\'t be compiled' end
  return true
end
