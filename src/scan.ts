import { Player } from './player.js';
import { sendMessageToClient } from './communication.js';
import {
    GRID_HEIGHT, GRID_WIDTH,
    SYMBOL_ROMULAN, SYMBOL_STAR, SYMBOL_BLACK_HOLE, SYMBOL_EMPTY,
    SYMBOL_WARNING, SYMBOL_BASE_FED, SYMBOL_BASE_EMP,
    SYMBOL_PLANET_NEU, SYMBOL_PLANET_FED, SYMBOL_PLANET_EMP, SYMBOL_PLANET_UNKNOWN,
    BASE_WARNING_DISTANCE, PLANET_WARNING_DISTANCE, BLACKHOLE_WARNING_DISTANCE,
    DEFAULT_SCAN_RANGE,
} from './settings.js';
import { addPlanetToMemory } from './memory.js';
import { Command } from './command.js';
import { Planet } from './planet.js';
import { planets, players, stars, blackholes } from './game.js';
import { matchesPattern } from './util/util.js';

export function scanCommand(player: Player, command: Command): void {
    scan(player, command, DEFAULT_SCAN_RANGE);
}

export function scan(player: Player, command: Command, range: number = DEFAULT_SCAN_RANGE): void {
    const args = command.args.map(arg => arg.toUpperCase());
    if (!player.ship) return;

    const { v, h } = player.ship.position;

    // ────── Parse arguments ──────
    let vDir = 0, hDir = 0;
    let vertical = range;
    let horizontal = range;
    let cornerMode = false;

    const nums = args.map(Number).filter(n => !isNaN(n));
    if (nums.length === 1) {
        vertical = horizontal = Math.min(nums[0], range);
    } else if (nums.length >= 2) {
        vertical = Math.min(nums[0], range);
        horizontal = Math.min(nums[1], range);
    }

    for (const arg of args) {
        if (!isNaN(Number(arg))) continue;
        if (matchesPattern(arg, "Up")) vDir = 1;  //matchesPattern
        else if (matchesPattern(arg, "Down")) vDir = -1;
        else if (matchesPattern(arg, "Right")) hDir = 1;
        else if (matchesPattern(arg, "Left")) hDir = -1;
        else if (matchesPattern(arg, "Center")) cornerMode = true;
    }

    const warningFlag = args.some(arg => matchesPattern(arg, "Warning"));
    const warningSectors = warningFlag ? getWarningSectors(player) : new Set<string>();

    // ────── Compute scan bounds ──────
    let vMin: number, vMax: number, hMin: number, hMax: number;

    if (cornerMode && nums.length >= 2) {
        const dv = Math.max(-range, Math.min(range, nums[0]));
        const dh = Math.max(-range, Math.min(range, nums[1]));

        vMin = Math.min(v, v + dv);
        vMax = Math.max(v, v + dv);
        hMin = Math.min(h, h + dh);
        hMax = Math.max(h, h + dh);
    } else {
        if (hDir < 0) {
            hMin = h - horizontal;
            hMax = h;
        } else if (hDir > 0) {
            hMin = h;
            hMax = h + horizontal;
        } else {
            hMin = h - horizontal;
            hMax = h + horizontal;
        }

        if (vDir < 0) {
            vMin = v - vertical;
            vMax = v;
        } else if (vDir > 0) {
            vMin = v;
            vMax = v + vertical;
        } else {
            vMin = v - vertical;
            vMax = v + vertical;
        }
    }

    hMin = Math.max(1, hMin);
    hMax = Math.min(GRID_WIDTH, hMax);
    vMin = Math.max(1, vMin);
    vMax = Math.min(GRID_HEIGHT, vMax);

    // ────── Build spatial maps for fast lookup ──────
    const coordKey = (v: number, h: number) => `${v},${h}`;

    const shipMap = new Map<string, Player>();
    for (const p of players) {
        if (p.ship) {
            shipMap.set(coordKey(p.ship.position.v, p.ship.position.h), p);
        }
    }

    const planetMap = new Map<string, Planet>();
    for (const planet of planets) {
        planetMap.set(coordKey(planet.position.v, planet.position.h), planet);
        addPlanetToMemory(player, planet);
    }

    const blackholeSet = new Set<string>(blackholes.map(bh => coordKey(bh.position.v, bh.position.h)));
    const starSet = new Set<string>(stars.map(s => coordKey(s.position.v, s.position.h)));

    // ────── Header ──────
    const header = [];
    for (let col = hMin; col <= hMax; col += 2) {
        header.push(String(col).padStart(2, " "));
    }
    sendMessageToClient(player, `   ${header.join("  ")}`);

    // ────── Grid ──────
    for (let rowV = vMax; rowV >= vMin; rowV--) {
        let line = `${String(rowV).padStart(2, " ")} `;

        for (let colH = hMin; colH <= hMax; colH++) {
            const key = coordKey(rowV, colH);
            let symbol = SYMBOL_EMPTY;

            const player = shipMap.get(key);
            const planet = planetMap.get(key);

            if (player) {    // why?  && !ship.ship.romulanStatus.cloaked) {
                if (player.ship && player.ship.name) {
                    if (player.ship.romulanStatus.isRomulan && !player.ship.romulanStatus.cloaked) {
                        symbol = SYMBOL_ROMULAN;
                    } else {
                        symbol = player.ship.name[0]
                    }
                } else {
                    symbol = `?`
                }
            } else if (planet) {
                if (planet.isBase) {
                    symbol = planet.side === "FEDERATION" ? SYMBOL_BASE_FED : SYMBOL_BASE_EMP;
                } else {
                    const side = planet.side;
                    symbol = side === "NEUTRAL" ? SYMBOL_PLANET_NEU :
                        side === "FEDERATION" ? SYMBOL_PLANET_FED :
                            side === "EMPIRE" ? SYMBOL_PLANET_EMP :
                                SYMBOL_PLANET_UNKNOWN;
                }
            } else if (starSet.has(key)) {
                symbol = SYMBOL_STAR;
            } else if (blackholeSet.has(key)) {
                symbol = SYMBOL_BLACK_HOLE;
            } else if (warningSectors.has(key)) {
                symbol = SYMBOL_WARNING;
            }

            if (symbol.length === 1) symbol = ` ${symbol}`;
            line += symbol;
        }

        line += ` ${String(rowV).padStart(2, " ")}`;
        sendMessageToClient(player, line);
    }

    // ────── Footer ──────
    sendMessageToClient(player, `   ${header.join("  ")}`);
}


// Identify sectors that should show warnings
function getWarningSectors(player: Player): Set<string> {
    const warningSet = new Set<string>();
    if (!player.ship) return warningSet;

    const side = player.ship.side;  // SHOULDN'T HAPPEN

    let warningDistance = PLANET_WARNING_DISTANCE;
    for (const planet of planets) {
        if (planet.isBase) {
            warningDistance = BASE_WARNING_DISTANCE;
        } else {
            warningDistance = PLANET_WARNING_DISTANCE;
        }
        if (planet.side !== side || planet.side === "NEUTRAL") {   // neutral is via Harris info
            for (let dh = -warningDistance; dh <= warningDistance; dh++) {
                for (let dv = -warningDistance; dv <= warningDistance; dv++) {
                    if (dh === 0 && dv === 0) continue;
                    warningSet.add(`${planet.position.v + dv},${planet.position.h + dh}`);
                }
            }
        }
    }

    for (const obj of [...blackholes]) {  // , ...stars
        for (let dh = -BLACKHOLE_WARNING_DISTANCE; dh <= BLACKHOLE_WARNING_DISTANCE; dh++) {
            for (let dv = -BLACKHOLE_WARNING_DISTANCE; dv <= BLACKHOLE_WARNING_DISTANCE; dv++) {
                if (dh === 0 && dv === 0) continue;
                warningSet.add(`${obj.position.v + dv},${obj.position.h + dh}`);
            }
        }
    }

    return warningSet;
}
