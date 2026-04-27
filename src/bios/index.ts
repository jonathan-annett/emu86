export {
  BDA,
  BDA_BASE,
  BDA_SEGMENT,
  BiosDataArea,
  EQUIPMENT_DEFAULT,
  KBBUF_BYTES,
  KBBUF_END_DEFAULT,
  KBBUF_START_DEFAULT,
  MEMORY_SIZE_KB_DEFAULT,
} from './bios-data-area.js';

export {
  BIOS_DISKETTE_PARAM_TABLE_OFFSET,
  BIOS_INIT_OFFSET,
  BIOS_RESET_VECTOR_OFFSET,
  BIOS_ROM_BASE,
  BIOS_ROM_SIZE,
  BIOS_TRAP_TABLE_OFFSET,
  buildBiosRom,
  trapAddressForVector,
  type BiosRomLayout,
  type BuiltBiosRom,
} from './bios-rom.js';

export {
  type BiosContext,
  type BiosHandler,
  int8Handler,
  int10Handler,
  int11Handler,
  int12Handler,
  int13Handler,
  int16Handler,
  int19Handler,
  int1aHandler,
  registerBiosHandlers,
  setReturnCF,
  setReturnCsIp,
  setReturnZF,
} from './bios-services.js';
