import { players, planets, blackholes, stars } from "./game.js";
import { Planet } from "./planet.js";
import { Blackhole } from "./blackhole.js";
import { Star } from "./star.js";
import { Player } from "./player.js";
import { Ship } from "./ship.js";
import { GRID_HEIGHT, GRID_WIDTH, OCDEF, CoordMode } from "./settings.js";
import { sendMessageToClient } from "./communication.js";

export type Position = {
    v: number;
    h: number;
}

export function chebyshev(a: Position, b: Position): number {
    return Math.max(Math.abs(a.v - b.v), Math.abs(a.h - b.h));
}

// // TODO is this the right semantics? or should BlackHoles be included?
// export function spaceOccupied(x: number, y: number): boolean {
//     return (
//         // Planets
//         planets.some(p => p.position.x === x && p.position.y === y) ||

//         // All bases
//         bases.federation.some(b => b.position.x === x && b.position.y === y) ||
//         bases.empire.some(b => b.position.x === x && b.position.y === y) ||

//         // Other ships
//         [...players].some(p =>
//             p.ship.position.x === x && p.ship.position.y === y
//         ) ||

//         // Stars
//         stars.some(s => s.x === x && s.y === y)
//     );
// }

// export function spaceOccupiedIncludingBlackHole(x: number, y: number): boolean {
//     return (
//         spaceOccupied(x, y) ||
//         // Black holes
//         blackHoles.some(bh => bh.x === x && bh.y === y)
//     );
// }


/**
 * Finds a Planet, BlackHole, or Ship at the given (v, h) position.
 * Returns { v, h, obj } if found, otherwise null.
 */
export function findObjectAtPosition(
    v: number,
    h: number
): { v: number; h: number; obj: Ship | Planet | Star | Blackhole } | null {
    for (const player of players) {
        if (player.ship && player.ship.position.v === v && player.ship.position.h === h) {
            return { v, h, obj: player.ship };
        }
    }

    for (const planet of planets) {
        if (planet.position.v === v && planet.position.h === h) {
            return { v, h, obj: planet };
        }
    }

    for (const star of stars) {
        if (star.position.v === v && star.position.h === h) {
            return { v, h, obj: star };
        }
    }
    for (const bh of blackholes) {
        if (bh.position.v === v && bh.position.h === h) {
            return { v, h, obj: bh };
        }
    }
    return null;
}

export function findEmptyLocation(): Position | null {
    for (let attempts = 0; attempts < 1000; attempts++) {
        const v = Math.floor(Math.random() * GRID_HEIGHT) + 1;
        const h = Math.floor(Math.random() * GRID_WIDTH) + 1;

        if (!findObjectAtPosition(v, h)) {
            return { v, h };
        }
    }
    return null; // fallback if map is saturated
}

export interface ParsedCoords {
    position: Position;
    cursor: number;
    mode: CoordMode;
    error?: string;
}

/**
 * Parses coordinates from a command's argument list.
 * - Allows optional mode prefix ("A", "R", or "C").
 * - Returns absolute coordinates with mode info.
 * - If COMPUTED is used but not allowed, returns an error.
 */
export function getCoordsFromCommandArgs(
    player: Player,
    args: string[],
    currentV: number,
    currentH: number,
    allowComputed: boolean = false
): ParsedCoords {
    let cursor = 0;
    let mode: CoordMode = "ABSOLUTE";

    const modeArg = args[0]?.toUpperCase();
    if (modeArg === "R" || modeArg === "RELATIVE") {
        mode = "RELATIVE";
        cursor++;
    } else if (modeArg === "A" || modeArg === "ABSOLUTE") {
        mode = "ABSOLUTE";
        cursor++;
    } else if (modeArg === "C" || modeArg === "COMPUTED") {
        if (!allowComputed) {
            return { position: { v: 0, h: 0 }, cursor, mode: "COMPUTED", error: "COMPUTED coordinates are not allowed for this command." };
        }
        mode = "COMPUTED";
        cursor++;
    } else {
        if (player.settings.icdef) {
            mode = player.settings.icdef;
        }
    }

    if (mode === "COMPUTED") {
        const shipArg = args[cursor];
        return getComputedCoordsFromCommandArg(player, shipArg, cursor, mode);
    }

    const v = parseInt(args[cursor++], 10);
    const h = parseInt(args[cursor++], 10);

    if (Number.isNaN(h) || Number.isNaN(v)) {
        return { position: { v: 0, h: 0 }, cursor, mode, error: "Invalid coordinates." };
    }

    const resultV = mode === "RELATIVE" ? currentV + v : v;
    const resultH = mode === "RELATIVE" ? currentH + h : h;
    return {
        position: { v: resultV, h: resultH },
        cursor,
        mode,
        error: undefined
    };
}

function getComputedCoordsFromCommandArg(player: Player, shipArg: string, cursor: number, mode: CoordMode) {
    if (!shipArg) {
        return { position: { v: 0, h: 0 }, cursor, mode, error: "Ship name required for COMPUTED coordinates." };
    }
    if (!player.ship!.isDeviceOperational("computer")) {
        sendMessageToClient(player, "COMPUTER MALFUNCTION — unable to compute target coordinates.");
        return { position: { v: 0, h: 0 }, cursor, mode, error: "COMPUTER MALFUNCTION — unable to compute target coordinates." };
    }
    cursor++;

    const ship = Ship.findShipByPartialName(shipArg);
    if (!ship) {
        const shipName = Ship.findShipByPartialName(shipArg);
        if (shipName) {
            return { position: { v: 0, h: 0 }, cursor, mode, error: `Ship ${shipName} not in game.` };
        } else {
            return { position: { v: 0, h: 0 }, cursor, mode, error: `Unknown computed target ${shipArg}.` };
        }
    }
    return { position: { v: ship.position.v, h: ship.position.h }, cursor, mode, error: undefined };
}

export function ocdefCoords(
    ocdef: OCDEF,
    source: Position,
    location: Position
): string {
    const abs = `${location.v}-${location.h}`;
    const relV = location.v - source.v;
    const relH = location.h - source.h;
    const rel = `${relV >= 0 ? "+" : ""}${relV} ${relH >= 0 ? "+" : ""}${relH}`;

    switch (ocdef) {
        case "RELATIVE":
            return rel;
        case "BOTH":
            return `${abs} (${rel})`;
        case "ABSOLUTE":
        default:
            return abs;
    }
}

// Bresenham line generator
export function* bresenhamLine(v0: number, h0: number, v1: number, h1: number) {
    let dh = Math.abs(h1 - h0),
        dv = Math.abs(v1 - v0),
        sh = h0 < h1 ? 1 : -1,
        sv = v0 < v1 ? 1 : -1,
        err = dh - dv;

    while (true) {
        yield { h: h0, v: v0 };
        if (h0 === h1 && v0 === v1) break;
        const e2 = err * 2;
        if (e2 > -dv) { err -= dv; h0 += sh; }
        if (e2 < dh) { err += dh; v0 += sv; }
    }
}