-- Fake Mono data collector: one assembly with class Game.Player (class handle 0x10, vtable 0x777).
-- Objects in the fake memory: a real Player at 0x401000, and a metadata-like match of the vtable
-- at 0x401100 (non-null word after it) that find_instances must discard.
-- __fake.il2cpp switches to IL2CPP behaviour (vtable = class, statics read per field).

__fake.monoValid = false
function LaunchMonoDataCollector() __fake.monoValid = true end
function mono_isValid() return __fake.monoValid end
function mono_isil2cpp() return __fake.il2cpp == true end
function mono_enumAssemblies() return { 1 } end
function mono_getImageFromAssembly(a) return 100 + a end
function mono_image_get_name(img) return 'Assembly-CSharp.dll' end
function mono_image_enumClasses(img) return { { classname = 'Player', namespace = 'Game', class = 0x10 }, { classname = 'Enemy', namespace = '', class = 0x20 } } end
function mono_findClass(ns, name) if ns == 'Game' and name == 'Player' then return 0x10 end end
function mono_class_getVTable(k) return 0x777 end

local FIELDS = {
  { name = 'hp', offset = 0x10, typename = 'System.Int32', monotype = 0x08, isStatic = false, field = 1 },
  { name = 'target', offset = 0x18, typename = 'Game.Enemy', monotype = 0x12, isStatic = false, field = 2 },
  { name = 'Instance', offset = 0x0, typename = 'Game.Player', monotype = 0x12, isStatic = true, field = 3 },
  { name = 'count', offset = 0x8, typename = 'System.Int32', monotype = 0x08, isStatic = true, field = 4 },
  { name = 'MAX', offset = 0x0, typename = 'System.Int32', monotype = 0x08, isStatic = true, isConst = true, field = 5 },
  { name = 'coins', offset = 0x20, typename = 'CodeStage.AntiCheat.ObscuredTypes.ObscuredInt', monotype = 0x11, isStatic = false, field = 6 },
  { name = 'speed', offset = 0x40, typename = 'CodeStage.AntiCheat.ObscuredTypes.ObscuredFloat', monotype = 0x11, isStatic = false, field = 7 },
  { name = 'spawn', offset = 0x10, typename = 'UnityEngine.Vector3', monotype = 0x11, isStatic = true, field = 8 },
}
-- ACTk structs (classes 0x30, 0x31): offsets count the 0x10 object header of the boxed form
local function obscured(fakeType)
  return { { name = 'currentCryptoKey', offset = 0x10, typename = 'System.Int32', isStatic = false },
    { name = 'hiddenValue', offset = 0x14, typename = 'System.Int32', isStatic = false },
    { name = 'inited', offset = 0x18, typename = 'System.Boolean', isStatic = false },
    { name = 'fakeValue', offset = 0x1C, typename = fakeType, isStatic = false },
    { name = 'fakeValueActive', offset = 0x20, typename = 'System.Boolean', isStatic = false },
    { name = 'cryptoKey', offset = 0x0, typename = 'System.Int32', isStatic = true } }
end
local STRUCTS = { [0x30] = obscured('System.Int32'), [0x31] = obscured('System.Single') }
function mono_field_getClass(field) return field == 6 and 0x30 or field == 7 and 0x31 or 0 end
function mono_class_enumFields(k) return k == 0x10 and FIELDS or STRUCTS[k] or {} end
function mono_class_enumMethods(k) return { { name = 'Hit', method = 7 }, { name = 'Heal', method = 8 } } end
function mono_method_getSignature(m) return m == 7 and 'System.Int32' or '' end
-- Mono static data at 0x401800; IL2CPP per-field values
function mono_class_getStaticFieldAddress(domain, k) if not __fake.il2cpp then return 0x401800 end end
__fake.il2cppStatics = { [3] = 0x401000, [4] = 0xFFFFFFFE }
function mono_getStaticFieldValue(vtable, field)
  if field == 8 then error('the collector would overflow its 8 bytes with a Vector3') end
  return __fake.il2cppStatics[field]
end
function mono_setStaticFieldValue(vtable, field, value) __fake.il2cppStatics[field] = value end
function getDotNetValueReader(monotype) if monotype == 0x08 then return function(a) return readInteger(a, true) end end end

function __fake.monoObjects()
  writeQword(0x401000, 0x777) writeQword(0x401008, 0) writeInteger(0x401010, 75) writeQword(0x401018, 0)
  writeQword(0x401100, 0x777) writeQword(0x401108, 0x401200)
  writeQword(0x401800, 0x401000) writeInteger(0x401808, 3)
  -- coins = 100 (key 0x5A5A, honeypot active); speed = 2.5 (key 0x1234, honeypot inactive)
  writeInteger(0x401020, 0x5A5A) writeInteger(0x401024, 100 ~ 0x5A5A) writeBytes(0x401028, { 1 })
  writeInteger(0x40102C, 100) writeBytes(0x401030, { 1 })
  local bits = string.unpack('<i4', string.pack('<f', 2.5))
  writeInteger(0x401040, 0x1234) writeInteger(0x401044, bits ~ 0x1234) writeBytes(0x401048, { 1 })
  writeFloat(0x40104C, 0) writeBytes(0x401050, { 0 })
end
