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

export const BASE_WARNING_DISTANCE = 4;
export const PLANET_WARNING_DISTANCE = 2;
export const BLACKHOLE_WARNING_DISTANCE = 1;
export const DEFAULT_SCAN_RANGE = 10;
export const DEFAULT_SRS_RANGE = 7;
export const INITIAL_BASE_STRENGTH = 1000;

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