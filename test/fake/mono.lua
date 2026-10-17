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
}
function mono_class_enumFields(k) return k == 0x10 and FIELDS or {} end
function mono_class_enumMethods(k) return { { name = 'Hit', method = 7 }, { name = 'Heal', method = 8 } } end
function mono_method_getSignature(m) return m == 7 and 'System.Int32' or '' end
-- Mono static data at 0x401800; IL2CPP per-field values
function mono_class_getStaticFieldAddress(domain, k) if not __fake.il2cpp then return 0x401800 end end
function mono_getStaticFieldValue(vtable, field) if field == 3 then return 0x401000 elseif field == 4 then return 0xFFFFFFFE end end
function getDotNetValueReader(monotype) if monotype == 0x08 then return function(a) return readInteger(a, true) end end end

function __fake.monoObjects()
  writeQword(0x401000, 0x777) writeQword(0x401008, 0) writeInteger(0x401010, 75) writeQword(0x401018, 0)
  writeQword(0x401100, 0x777) writeQword(0x401108, 0x401200)
  writeQword(0x401800, 0x401000) writeInteger(0x401808, 3)
end
