// Fully FORTRAN-faithful LIST command for DECWAR
import { Player } from './player.js';
import { Command } from './command.js';
import {
    players,
    planets,
    bases,
} from './game.js';
import { sendMessageToClient } from './communication.js';
import { Planet } from './planet.js';
import { Ship } from './ship.js';
import { chebyshev } from './coords.js';
import { DEFAULT_SCAN_RANGE, MAX_SHIELD_ENERGY, OutputSetting, SYMBOL_BASE_FED, SYMBOL_BASE_EMP, INITIAL_BASE_STRENGTH, Side } from './settings.js';
import { teamMemory } from './memory.js';

type ListClause = {
    objectFilters: string[];
    sideFilters: string[];
    rangeFilters: (string | number)[];
    locationFilters: { vpos: number; hpos: number }[];
    modes: string[];
    controlKeywords: string[];
    shipNames: string[];
};

type ParseSuccess = {
    ok: true;
    clauses: ListClause[];
};

type ParseError = {
    ok: false;
    error: string;
};

type ParseResult = ParseSuccess | ParseError;

const OBJECT_FILTERS = ["SHIPS", "BASES", "PLANETS", "PORTS"];
const SIDE_FILTERS = ["FEDERATION", "HUMAN", "EMPIRE", "KLINGON", "FRIENDLY", "ENEMY", "TARGETS", "NEUTRAL", "CAPTURED"];
const MODES = ["LIST", "SUMMARY"];
const CONTROL_KEYWORDS = ["AND", "&"];
const RANGE_KEYWORDS = ["CLOSEST", "ALL"];

export function listCommand(player: Player, command: Command): void {
    listCommandHelper(player, command, false);
}

export function listCommandHelper(player: Player, command: Command, onlySummarize: boolean = false): void {
    const result: ParseResult = parseListCommand(command.raw);
    let ship: Ship;
    if (!player.ship) {
        sendMessageToClient(player, "You must be in a ship to use LIST.");
        return;
    } else {
        ship = player.ship;
    }

    if (!result.ok) {
        sendMessageToClient(player, result.error);
        return;
    }

    let outputMode: OutputSetting = player.settings.output ?? "LONG";

    for (const clause of result.clauses) {
        if (clause.objectFilters.length == 0) {
            clause.objectFilters = ["SHIPS", "BASES", "PLANETS"];
        }

        let range = DEFAULT_SCAN_RANGE;
        let explicitRange = false;
        let allShips: Ship[] = [];
        let allBases: Planet[] = [];
        let allPlanets: Planet[] = [];
        const outputLines: string[] = [];

        if (clause.rangeFilters.length > 0) {
            const numericRanges = clause.rangeFilters.filter(r => typeof r === "number") as number[];
            if (numericRanges.length > 0) {
                range = Math.max(...numericRanges);
                explicitRange = true;
            }
            if (clause.rangeFilters.includes("ALL")) { //needed?
                range = Infinity;
            }
        }

        if (!explicitRange) {
            clause.rangeFilters.push("ALL");
            range = Infinity;
        }

        // filter by objects first

        if (clause.objectFilters.includes("SHIPS")) {
            allShips = players.map(p => p.ship).filter((ship): ship is Ship => ship !== null);
        }
        if (
            clause.objectFilters.includes("BASES") ||
            clause.objectFilters.includes("PORTS")) {
            allBases = [...bases.federation, ...bases.empire];
        }
        if (clause.objectFilters.includes("PLANETS") ||
            clause.objectFilters.includes("PORTS")) {
            allPlanets = [...planets];
        }

        allPlanets = dedup(allPlanets, [...bases.federation, ...bases.empire]);

        // filters by side
        if (allShips.length > 0) {
            const filter = new Set(clause.sideFilters);
            allShips = allShips.filter(ship => isSideMatch(player, filter, ship));
        }

        if (allBases.length > 0) {
            const filter = new Set(clause.sideFilters);
            allBases = allBases.filter(base => isSideMatch(player, filter, base));
        }

        if (allPlanets.length > 0) {
            const filter = new Set(clause.sideFilters);
            allPlanets = allPlanets.filter(planet => isSideMatch(player, filter, planet));
        }

        // filters by range
        if (clause.rangeFilters.length > 0) {
            if (clause.rangeFilters.includes("CLOSEST")) {
                console.log("closest");
                if (allShips.length > 0) {
                    const closestShip = allShips.reduce((a, b) =>
                    // Find the closest ship to player.ship, but skip player.ship itself
                    (a === player.ship ? b : b === player.ship ? a :
                        (chebyshev(ship.position, a.position) <= chebyshev(ship.position, b.position) ? a : b))
                    );
                    allShips = [closestShip];
                }
                if (allBases.length > 0) {
                    const closestBase = allBases.reduce((a, b) =>
                        chebyshev(ship.position, a.position) <= chebyshev(ship.position, b.position) ? a : b
                    );
                    allBases = [closestBase];
                }
                if (allPlanets.length > 0) {
                    const closestPlanet = allPlanets.reduce((a, b) =>
                        chebyshev(ship.position, a.position) <= chebyshev(ship.position, b.position) ? a : b
                    );
                    allPlanets = [closestPlanet];
                }
            }
        }

        // filter by range
        if (range !== Infinity) {
            allShips = allShips.filter(ship => chebyshev(ship.position, ship.position) <= range);
            allBases = allBases.filter(base => chebyshev(ship.position, base.position) <= range);
            allPlanets = allPlanets.filter(planet => chebyshev(ship.position, planet.position) <= range);
        }

        // filter by location

        // If there are any location filters, filter objects to those locations
        if (clause.locationFilters.length > 0) {
            // For ships, match if their position matches any location filter
            allShips = allShips.filter(ship =>
                clause.locationFilters.some(loc =>
                    ship.position.h === loc.hpos && ship.position.v === loc.vpos
                )
            );
            // For bases, match if their x/y matches any location filter
            allBases = allBases.filter(base =>
                clause.locationFilters.some(loc =>
                    base.position.h === loc.hpos && base.position.v === loc.vpos
                )
            );
            // For planets, match if their position matches any location filter
            allPlanets = allPlanets.filter(planet =>
                clause.locationFilters.some(loc =>
                    planet.position.h === loc.hpos && planet.position.v === loc.vpos
                )
            );
        }

        let summarize = clause.modes.includes("SUMMARY");

        // Show full object listings (as in 2.2 LIST default)
        let finalShips = [];
        let finalBases = [];
        let finalPlanets = [];
        let needReturn = false;

        let qualifier = explicitRange ? "in specified range" : "in game";

        for (const ship of allShips) {
            const line = formatShipLine(ship, outputMode, player);
            if (line) {
                if (!onlySummarize) {
                    outputLines.push(line);
                    needReturn = true;
                }
                finalShips.push(ship);
            }
        }

        if (needReturn) {
            outputLines.push("");
            needReturn = false;
        }

        if (summarize) {
            let shipSummary: ListSummary = summarizeShips(finalShips);
            printSummary(shipSummary, "ships", qualifier, outputLines);
            if (finalShips.length > 0) needReturn = true;
        }

        if (needReturn) {
            outputLines.push("");
            needReturn = false;
        }

        for (const base of allBases) {
            const line = formatBaseLine(base, outputMode, player);
            if (line) {
                if (!onlySummarize) {
                    outputLines.push(line);
                    needReturn = true;
                }
                finalBases.push(base);
            }
        }

        if (needReturn) {
            outputLines.push("");
            needReturn = false;
        }

        if (summarize) {
            let baseSummary: ListSummary = summarizeBases(finalBases);
            printSummary(baseSummary, "bases", qualifier, outputLines);
            if (finalBases.length > 0) needReturn = true;
        }

        if (needReturn) {
            outputLines.push("");
            needReturn = false;
        }

        for (const planet of allPlanets) {
            const line = formatPlanetLine(planet, outputMode, player);
            if (line) {
                if (!onlySummarize) {
                    outputLines.push(line);
                    needReturn = true;
                }
                finalPlanets.push(planet);
            }
        }


        if (needReturn) {
            outputLines.push("");
            needReturn = false;
        }

        if (summarize) {
            let planetSummary: ListSummary = summarizePlanets(finalPlanets);
            printSummary(planetSummary, "planets", qualifier, outputLines);
            if (finalPlanets.length > 0) needReturn = true;
        }

        if (needReturn) {
            outputLines.push("");
            needReturn = false;
        }

        if (outputLines.length === 0) {
            sendMessageToClient(player, "Nothing matches your LIST criteria.");
        } else {
            for (const line of outputLines) {
                sendMessageToClient(player, line);
            }
        }

    }

}

function formatShipLine(ship: Ship, mode: OutputSetting, viewer: Player): string | null {
    if (ship.romulanStatus.isRomulan && ship.romulanStatus.cloaked) {
        return null;
    }
    if (!viewer.ship) {
        return null;
    }

    let isOutOfRange = false;
    let distance = chebyshev(ship.position, viewer.ship.position);

    if (distance > DEFAULT_SCAN_RANGE && ship.side !== viewer.ship.side) isOutOfRange = true;
    //const { v, h } = ship.position;
    const flag = (ship.side !== viewer.ship.side) ? "*" : " ";

    let coord = 'out of range';
    const name = ship.name ?? '??';
    let fullName = (name[0].toUpperCase() + name.slice(1).toLowerCase()).padEnd(12);
    let percent = "%";
    let shieldPct = (ship.level / MAX_SHIELD_ENERGY) * 100;
    let shieldDisplay = `+${shieldPct.toFixed(0)}${percent}`.padStart(7);


    if (mode === "SHORT" || mode === "MEDIUM") {
        fullName = name[0].toUpperCase().padEnd(3);
        percent = " ";
    }

    if (!isOutOfRange) {
        coord = `${formatCoordsForPlayer2(ship.position.v, ship.position.h, viewer)}`;
        if (mode === "SHORT" || mode === "MEDIUM") {
            shieldDisplay = `+${shieldPct.toFixed(1)}${percent}`.padStart(9);
        } else {
            coord = `@${coord}`;
        }
    } else {
        shieldDisplay = '';
    }

    if (mode === "SHORT" || mode === "MEDIUM") {
        return `${flag}${fullName}${coord} ${shieldDisplay}`;
    } else {
        return `${flag}${fullName}${coord}${shieldDisplay}`;
    }
}

function formatBaseLine(base: Planet, mode: OutputSetting, viewer: Player): string | null {
    if (!viewer.ship) {
        return null;
    }
    let distance = chebyshev(viewer.ship.position, viewer.ship.position);
    if (distance > DEFAULT_SCAN_RANGE && base.side !== viewer.ship.side) {
        const memory = viewer.ship.side === "FEDERATION" ? teamMemory.federation : teamMemory.empire;
        if (!memory.has(`${base.position.v},${base.position.h}`)) {
            return null;
        }
    }

    const name = base.side.slice(0, 3).charAt(0).toUpperCase() + base.side.slice(1, 3).toLowerCase();
    const isEnemy = base.side !== viewer.ship.side;
    const flag = isEnemy ? "*" : " ";
    let fullName;
    let percent;

    if (mode === "SHORT" || mode === "MEDIUM") {
        fullName = (base.side === "FEDERATION" ? SYMBOL_BASE_FED : base.side === "EMPIRE" ? SYMBOL_BASE_EMP : base.side.slice(0, 3)).padEnd(3);
        percent = " ";
    } else {
        fullName = ((name[0].toUpperCase() + name.slice(1).toLowerCase()) + " Base").padEnd(12);
        percent = "%";
    }

    let coord = `${formatCoordsForPlayer2(base.position.v, base.position.h, viewer)}`;
    //const delta = `${dx >= 0 ? "+" : ""}${dx},${dy >= 0 ? "+" : ""}${dy}`.padStart(9);
    const shieldPct = (base.strength / INITIAL_BASE_STRENGTH) * 100;
    let shieldDisplay = `+${shieldPct.toFixed(1)}${percent}`.padStart(9);
    if (mode === "SHORT" || mode === "MEDIUM") {
        shieldDisplay = `${shieldPct.toFixed(0)}${percent}`.padStart(8);
        return `${flag}${fullName}${coord}${shieldDisplay}`;
    } else {
        return `${flag}${fullName}@${coord}${shieldDisplay}`;
    }
}

function formatPlanetLine(planet: Planet, mode: OutputSetting, viewer: Player): string | null {
    if (!viewer.ship) {
        return null;
    }
    let distance = chebyshev(planet.position, viewer.ship.position);
    if (distance > DEFAULT_SCAN_RANGE) {
        const memory = viewer.ship.side === "FEDERATION" ? teamMemory.federation : teamMemory.empire;
        if (!memory.has(`${planet.position.v},${planet.position.h}`)) {
            return null;
        }
    }

    const name = planet.side.slice(0, 3).charAt(0).toUpperCase() + planet.side.slice(1, 3).toLowerCase() + " planet";
    const isEnemy = planet.side !== viewer.ship.side && planet.side !== "NEUTRAL";
    let flag;
    if (isEnemy) {
        flag = "*";
    } else if (planet.side === "NEUTRAL") {
        flag = " ";
    } else {
        flag = "-";
    }

    let fullName, builds;
    let coord = `${formatCoordsForPlayer2(planet.position.v, planet.position.h, viewer)}`
    if (mode === "SHORT" || mode === "MEDIUM") {
        fullName = "@";
        const pad = true ? 6 : 2;
        builds = (planet.builds + "").padStart(pad);
        if (planet.builds == 0) builds = "";
        return ` ${flag}${fullName} ${coord}${builds}`;
    } else {
        builds = planet.builds + " builds".padStart(5);
        fullName = name.padEnd(12);
        const pad = (viewer.settings.ocdef !== "BOTH") ? 10 : 18;
        coord = coord.padEnd(pad);
        if (planet.builds == 0) builds = "";
        const sep = (viewer.settings.ocdef === "RELATIVE") ? "" : "@";
        return `${flag}${fullName}${sep}${coord}${builds}`;
    }
}

export function parseListCommand(input: string): ParseResult {
    try {
        const tokens = tokenize(input.toUpperCase());
        const clauses: ListClause[] = [];
        let current: ListClause = emptyClause();

        while (tokens.length > 0) {
            const token = tokens[0];

            if (matchesKeyword(token, CONTROL_KEYWORDS)) {
                tokens.shift();
                clauses.push(current);
                current = emptyClause();
            } else if (matchesKeyword(token, OBJECT_FILTERS)) {
                current.objectFilters.push(matchAndShift(tokens, OBJECT_FILTERS)!);
            } else if (matchesKeyword(token, SIDE_FILTERS)) {
                current.sideFilters.push(matchAndShift(tokens, SIDE_FILTERS)!);
            } else if (matchesKeyword(token, MODES)) {
                current.modes.push(matchAndShift(tokens, MODES)!);
            } else if (matchesKeyword(token, RANGE_KEYWORDS)) {
                current.rangeFilters.push(matchAndShift(tokens, RANGE_KEYWORDS)!);
            } else if (!isNaN(Number(token))) {
                const vpos = Number(tokens.shift());
                if (tokens.length > 0 && /^[0-9]+$/.test(tokens[0])) {
                    const hpos = Number(tokens.shift());
                    current.locationFilters.push({ vpos, hpos });
                } else {
                    current.rangeFilters.push(vpos);
                }
            } else if (/^[A-Z]+$/.test(token)) {
                current.shipNames.push(tokens.shift()!);
            } else {
                return { ok: false, error: "Unknown token: " + token };
            }
        }

        clauses.push(current);
        return { ok: true, clauses };
    } catch (e: any) {
        return { ok: false, error: e.message || "Unexpected parsing error" };
    }
}

function emptyClause(): ListClause {
    return {
        objectFilters: [],
        sideFilters: [],
        rangeFilters: [],
        locationFilters: [],
        modes: [],
        controlKeywords: [],
        shipNames: [],
    };
}

function tokenize(input: string): string[] {
    return input.trim().split(/\s+/);
}

function matchesKeyword(token: string, options: string[]): boolean {
    return options.some(opt => opt.startsWith(token));
}

function matchAndShift(tokens: string[], options: string[]): string | null {
    const token = tokens[0];
    const match = options.find(opt => opt.startsWith(token));
    if (match) {
        tokens.shift();
        return match;
    }
    return null;
}

//isSideMatch(player, ship.side, filter, ship));

function isSideMatch(player: Player, filter: Set<string>, target: Ship | Planet): boolean {
    if (!player.ship) {
        return false;
    }
    const playerSide = player.ship.side;
    const targetSide = target.side;

    if (filter.size === 0) return true;

    if (filter.has("CAPTURED")) {
        if (target instanceof Planet) {
            if (target.side === "NEUTRAL") return false;
        } else {
            return false;
        }
    }
    if (filter.has("HUMAN") || filter.has("FEDERATION")) {
        if (targetSide === "EMPIRE" || targetSide === "ROMULAN" || targetSide === "NEUTRAL") return false;
    }
    if (filter.has("KLINGON") || filter.has("EMPIRE")) {
        if (targetSide === "FEDERATION" || targetSide === "ROMULAN" || targetSide === "NEUTRAL") return false;
    }
    if (filter.has("FRIENDLY") && (playerSide !== targetSide || targetSide === "NEUTRAL")) return false;

    if (filter.has("ENEMY") || filter.has("TARGETS")) {
        if ((playerSide === targetSide) || targetSide === "NEUTRAL" as Side) return false;
    }
    if (filter.has("NEUTRAL") && (targetSide as Side) !== "NEUTRAL") return false;

    return true;
}

export function formatCoordsForPlayer2(
    targetV: number,
    targetH: number,
    player: Player
): string {
    if (!player.ship) {
        return "";
    }
    let abs = `${targetV.toString().padStart(2, ' ')}-${targetH.toString().padStart(2, ' ')}`;
    const relV = targetV - player.ship.position.v;
    const relH = targetH - player.ship.position.h;

    // Format with sign only for non-zero
    const formatRel = (num: number) => {
        if (num === 0) return "0";
        return (num > 0 ? "+" : "") + num;
    };

    const rel = `${formatRel(relV)},${formatRel(relH).padStart(3)}`.padStart(7);


    //@48-70 -10, +5
    switch (player.settings.ocdef) {
        case "RELATIVE":
            return rel;
        case "BOTH":
            return `${abs} ${rel}`;
        case "ABSOLUTE":
        default:
            return abs;
    }
}

function dedup(planets: Planet[], bases: Planet[]): Planet[] {
    // Create a Set of base coordinates as "y-x" strings for fast lookup
    const baseCoords = new Set(bases.map(b => `${b.position.v}-${b.position.h}`));
    // Filter out any planet whose coords match a base
    return planets.filter(p => !baseCoords.has(`${p.position.v}-${p.position.h}`));
}

function printSummary(summary: ListSummary, label: string, qualifier: string, outputLines: string[]): void {
    if (summary.FEDERATION > 0) outputLines.push(summary.FEDERATION + ` Federation ${label} ${qualifier}`);
    if (summary.EMPIRE > 0) outputLines.push(summary.EMPIRE + ` Empire ${label} ${qualifier}`);
    if (summary.ROMULAN > 0) outputLines.push(summary.ROMULAN + ` Romulan ${label} ${qualifier}`);
    if (summary.NEUTRAL > 0) outputLines.push(summary.NEUTRAL + ` Neutral ${label} ${qualifier}`);
}


export function summaryCommand(player: Player, command: Command): void {
    listCommandHelper(player, command, true);
}

export interface ListSummary {
    FEDERATION: number;
    EMPIRE: number;
    ROMULAN: number;
    NEUTRAL: number;
}

/**
 * Counts ships by side (FEDERATION, EMPIRE, ROMULAN) from the provided array.
 * Assumes all ships in the array are vetted and valid.
 * @param ships - Array of Player objects representing ships to count.
 * @returns A ShipSummary object containing counts of ships by side.
 */
export function summarizeShips(ships: Ship[]): ListSummary {
    const summary: ListSummary = {
        FEDERATION: 0,
        EMPIRE: 0,
        ROMULAN: 0,
        NEUTRAL: 0
    };

    for (const ship of ships) {
        if (ship.romulanStatus?.isRomulan) {
            summary.ROMULAN += 1;
        } else if (ship.side === 'FEDERATION') {
            summary.FEDERATION += 1;
        } else if (ship.side === 'EMPIRE') {
            summary.EMPIRE += 1;
        }
    }

    return summary;
}


/**
 * Counts bases by side (FEDERATION, EMPIRE) from the provided array.
 * Assumes all bases in the array are vetted and valid.
 * @param bases - Array of Base objects to count.
 * @returns A BaseSummary object containing counts of bases by side.
 */
export function summarizeBases(bases: Planet[]): ListSummary {
    const summary: ListSummary = {
        FEDERATION: 0,
        EMPIRE: 0,
        ROMULAN: 0,
        NEUTRAL: 0
    };

    for (const base of bases) {
        if (base.side === 'FEDERATION') {
            summary.FEDERATION += 1;
        } else if (base.side === 'EMPIRE') {
            summary.EMPIRE += 1;
        }
    }

    return summary;
}

/**
 * Counts planets by side (FEDERATION, EMPIRE, NEUTRAL) from the provided array.
 * Assumes all planets in the array are vetted and valid, with no base overlaps.
 * @param planets - Array of Planet objects to count.
 * @returns A PlanetSummary object containing counts of planets by side.
 */
export function summarizePlanets(planets: Planet[]): ListSummary {
    const summary: ListSummary = {
        FEDERATION: 0,
        EMPIRE: 0,
        ROMULAN: 0,
        NEUTRAL: 0
    };

    for (const planet of planets) {
        if (planet.side === 'FEDERATION') {
            summary.FEDERATION += 1;
        } else if (planet.side === 'EMPIRE') {
            summary.EMPIRE += 1;
        } else if (planet.side === 'NEUTRAL') {
            summary.NEUTRAL += 1;
        }
    }

    return summary;
}