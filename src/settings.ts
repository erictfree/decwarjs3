import { VERSION } from "./version.js";

export const GRID_WIDTH = 75;
export const GRID_HEIGHT = 75;
export const MAX_PLAYERS = 18;
export const NUMBER_OF_PLANETS = 60;
export const MAX_NUMBER_OF_PLAYERS = 18;
export const DEFAULT_BASE_ENERGY = 1000;
export const MAX_BUILDS_PER_PLANET = 5;
export const MAX_SHIP_ENERGY = 5000;
export const MAX_SHIELD_ENERGY = 2500;
export const MAX_TORPEDOES = 10;
export const BASE_WARNING_DISTANCE = 4;
export const PLANET_WARNING_DISTANCE = 2;
export const BLACKHOLE_WARNING_DISTANCE = 1;
export const DEFAULT_SCAN_RANGE = 10;
export const DEFAULT_SRS_RANGE = 7;
export const INITIAL_BASE_STRENGTH = 1000;
export const CAPTURE_DELAY_MIN_MS = 1000;
export const WARP_DELAY_MIN_MS = 2000;
export const WARP_DELAY_RANGE = 2000;
export const DOCK_DELAY_RANGE = 2000;
export const DOCK_DELAY_MIN_MS = 2000;
export const BUILD_DELAY_MIN_MS = 2000;
export const BUILD_DELAY_RANGE = 2000;
export const MAX_BASES_PER_TEAM = 10;
export const ENERGY_REPAIR_COST = 500;
export const SHIELD_REPAIR_COST = 300;
export const SHIELD_REPAIR_AMOUNT = 500;
export const ENERGY_REPAIR_AMOUNT = 1000;
export const DESTRUCTION_DAMAGE_THRESHOLD = 2500;
export const PHASER_COOLDOWN = 1000;
export const IMPULSE_DELAY_MS = 2000;
export const IMPULSE_DELAY_RANGE = 2000; // So delay = 1000–1999ms
export const MAX_TORPEDO_RANGE = 10;

export type ScanSetting = "LONG" | "SHORT";
export type PromptSetting = "NORMAL" | "INFORMATIVE";
export type CoordMode = "ABSOLUTE" | "RELATIVE" | "COMPUTED";
export type ICDEF = "ABSOLUTE" | "RELATIVE";
export type OCDEF = "ABSOLUTE" | "RELATIVE" | "BOTH";
export type Condition = "RED" | "YELLOW" | "GREEN";
export type OutputSetting = "SHORT" | "MEDIUM" | "LONG";

export const SYMBOL_ROMULAN = "R";
export const SYMBOL_STAR = "*";
export const SYMBOL_BLACK_HOLE = " ";
export const SYMBOL_EMPTY = ".";
export const SYMBOL_WARNING = "!";
export const SYMBOL_BASE_FED = "<>";
export const SYMBOL_BASE_EMP = ")(";
export const SYMBOL_PLANET_NEU = "@";
export const SYMBOL_PLANET_FED = "@F";
export const SYMBOL_PLANET_EMP = "@E";
export const SYMBOL_PLANET_UNKNOWN = "@?";


export type Side = "NEUTRAL" | "FEDERATION" | "EMPIRE" | "ROMULAN";

export const FEDERATION_SHIPS: string[] = [
    "EXCALIBUR"
    , "FARRAGUT", "INTREPID", "LEXINGTON", "NIMITZ",
    "SAVANNAH", "TRENTON", "VULCAN", "YORKTOWN"
];

export const EMPIRE_SHIPS: string[] = [
    "BUZZARD",
    "COBRA", "DEMON", "GOBLIN", "HAWK",
    "JACKAL", "MANTA", "PANTHER", "WOLF"
];

export const SHIPNAMES: string[] = [...FEDERATION_SHIPS, ...EMPIRE_SHIPS];

export const settings = {
    stardate: 0,
    generated: false,
    version: "0.3" + VERSION,
    date: "2025-06-06",
    allowRomulans: true,
    allowBlackHoles: true,
    outputDetail: "FULL",
    promptStyle: "DEFAULT",
    sensorScanDetail: "DEFAULT",
    coordInputDefault: "DEFAULT",
    coordOutputDefault: "DEFAULT",
    ttyType: "DEFAULT",
    allowGripe: true,
    gameNumber: 1,
    timeConsumingMoves: 0
};