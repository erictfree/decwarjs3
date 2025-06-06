import { players, planets, blackholes, stars } from "./game.js";
import { Planet } from "./planet.js";
import { Blackhole } from "./blackhole.js";
import { Star } from "./star.js";
import { Player } from "./player.js";
import { Ship } from "./ship.js";
import { GRID_HEIGHT, GRID_WIDTH, OCDEF } from "./settings.js";

export type Position = {
    v: number;
    h: number;
}

export function chebyshev(a: Position, b: Position): number {
    return Math.max(Math.abs(a.v - b.v), Math.abs(a.h - b.h));
}

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