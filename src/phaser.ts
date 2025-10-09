import { Player } from './player.js';
import { Command } from './command.js';
import {
    OutputSetting,
    STARBASE_PHASER_RANGE,
    MAX_SHIELD_ENERGY
} from './settings.js';
import { sendMessageToClient, addPendingMessage, sendOutputMessage } from './communication.js';
import { chebyshev, ocdefCoords, getCoordsFromCommandArgs } from './coords.js';
import { Planet } from './planet.js';
import { players, planets, bases, removePlayerFromGame, checkEndGame, pointsManager } from './game.js';
import { handleUndockForAllShipsAfterPortDestruction } from './ship.js';
import { SHIP_FATAL_DAMAGE, PLANET_PHASER_RANGE } from './game.js';

import type { Side } from "./settings.js";

type ScoringAPI = {
    addDamageToEnemies?(amount: number, source: Player, side: Side): void;
    addDamageToBases?(amount: number, source: Player, side: Side): void;
    addEnemiesDestroyed?(count: number, source: Player, side: Side): void;
    addPlanetsCaptured?(count: number, player: Player, side: Side): void;
    incrementShipsCommissioned?(side: Side): void;
};



export function phaserCommand(player: Player, command: Command): void {
    if (!player.ship) {
        sendMessageToClient(player, "You cannot fire phasers — you have no ship.");
        return;
    }

    let args = command.args;
    const now = Date.now();
    const [ph1, ph2] = player.ship.cooldowns.phasersAvailableAt;
    const bankIndex = ph1 <= ph2 ? 0 : 1;
    let energy = NaN;

    if (!player.ship.isDeviceOperational("phaser")) return;

    if (now < player.ship.cooldowns.phasersAvailableAt[bankIndex]) {
        switch (player.settings.output) {
            case "SHORT": sendMessageToClient(player, "PH > RCHG"); break;
            case "MEDIUM": sendMessageToClient(player, "Phasers unavailable — recharging."); break;
            case "LONG": sendMessageToClient(player, "Both phaser banks are currently recharging."); break;
        }
        return;
    }

    // Parse arguments
    if (command.args.length === 2) {
        args = [player.settings.icdef, ...command.args];  // v h
    } else if (command.args.length === 3) { // either energy v h, or mode v h
        energy = parseInt(command.args[0], 10);
        if (!Number.isNaN(energy)) {
            args[0] = player.settings.icdef // remove energy and treat as normal
        }
    } else if (command.args.length === 4) { // mode energy v h
        energy = parseInt(command.args[1], 10);
        if (Number.isNaN(energy)) {
            switch (player.settings.output) {
                case "SHORT":
                    sendMessageToClient(player, "PH > BAD E");
                    break;
                case "MEDIUM":
                    sendMessageToClient(player, "Invalid phaser energy input.");
                    break;
                case "LONG":
                default:
                    sendMessageToClient(player, "Bad energy value provided. Phaser command aborted.");
                    break;
            }
            return;
        } else {
            args = command.args.slice(0, 1).concat(command.args.slice(2));
        }
    }

    if (Number.isNaN(energy)) {
        energy = 200;
    }
    energy = Math.min(Math.max(energy, 50), 500);

    const shieldPenalty = player.ship.shieldsUp ? 200 : 0;
    if (shieldPenalty > 0) {
        switch (player.settings.output) {
            case "LONG": sendMessageToClient(player, "High speed shield control activated."); break;
        }
    }

    const totalEnergyCost = energy + shieldPenalty;
    if (player.ship.energy < totalEnergyCost) {
        const e = player.ship.energy.toFixed(1);
        switch (player.settings.output) {
            case "SHORT": sendMessageToClient(player, `PH > NO E ${e}`); break;
            case "MEDIUM": sendMessageToClient(player, `Insufficient energy: ${e}`); break;
            case "LONG": sendMessageToClient(player, `Insufficient energy to fire phasers. Available energy: ${e}`); break;
        }
        return;
    }

    const { position: { v: targetV, h: targetH } } = getCoordsFromCommandArgs(player, args, player.ship.position.v, player.ship.position.h, true);
    const distance = chebyshev(player.ship.position, { v: targetV, h: targetH });

    if (distance > 10) {
        switch (player.settings.output) {
            case "SHORT": sendMessageToClient(player, "PH > RANGE"); break;
            case "MEDIUM": sendMessageToClient(player, "Target exceeds phaser range."); break;
            case "LONG": sendMessageToClient(player, "Target out of phaser range (maximum 10 sectors)."); break;
        }
        return;
    }

    player.ship.energy -= totalEnergyCost;
    player.ship.condition = "RED";

    const target = players.find(p => p.ship && p.ship.position.h === targetH && p.ship.position.v === targetV) ||
        planets.find(p => p.position.h === targetH && p.position.v === targetV && p.isBase);
    if (!target) {
        switch (player.settings.output) {
            case "SHORT": sendMessageToClient(player, "PH > MISS"); break;
            case "MEDIUM": sendMessageToClient(player, "No target present."); break;
            case "LONG": sendMessageToClient(player, "No valid target at that location for phaser strike."); break;
        }
        return;
    }
    const targetSide = target instanceof Planet ? target.side : target.ship?.side;  //TODO
    if (targetSide === player.ship.side) {
        sendMessageToClient(player, "Cannot fire phasers at a friendly target.");
        return;
    }

    // Phaser hit calculation (adapted from phadam)
    let phit = energy;
    const distFactor = Math.pow(0.9 + 0.02 * Math.random(), distance); // pwr(0.9-0.92, id)
    if (player.ship.devices.phaser > 0 || player.ship.devices.computer > 0) {
        phit *= 0.8; // Damaged phasers/computer reduce hit by 20%
    }
    phit *= distFactor;

    // Apply damage
    const result = applyPhaserDamage(player, target, phit);

    // Update points
    if (result.hita > 0) {
        if (target instanceof Player && target.ship && target.ship.romulanStatus.isRomulan) {
            pointsManager.addDamageToRomulans(result.hita, player, player.ship.side);
        } else if (target instanceof Planet && target.isBase) {
            pointsManager.addDamageToBases(result.hita, player, player.ship.side);
        } else {
            pointsManager.addDamageToEnemies(result.hita, player, player.ship.side);
        }
    }
    if (result.checkEndGame) {
        checkEndGame();
    }
}
export function applyPhaserDamage(
    attacker: Player,
    target: Player | Planet,
    phit: number
): { hita: number; critdv: number; critdm: number; klflg: number; checkEndGame: boolean } {
    if (!attacker.ship) {
        return { hita: 0, critdv: 0, critdm: 0, klflg: 0, checkEndGame: false };
    }

    // Spend energy & normalize phit like PHACON
    const { phit: phitUsed } = preparePhaserShot(attacker, phit);

    let hita = phitUsed;
    let critdv = 0;
    let critdm = 0;
    let klflg = 0;
    let checkEndGame = false;

    // Non-base planet behavior (unchanged)
    if (target instanceof Planet && !target.isBase) {
        if (Math.random() < 0.25) {
            if (target.builds > 0) {
                target.builds = Math.max(0, target.builds - 1);
                hita = 1;
                const coords = ocdefCoords(attacker.settings.ocdef, attacker.ship.position, target.position);
                sendOutputMessage(attacker, {
                    SHORT: `Planet hit @${coords}: Builds -1`,
                    MEDIUM: `Phaser hit reduced builds on planet at ${coords} by 1 (now ${target.builds}).`,
                    LONG: `Phasers damaged planetary installations at ${coords}, reducing builds by 1 to ${target.builds}. Cannot destroy planet.`
                });
            } else {
                hita = 0;
                sendMessageToClient(attacker, `Planet at full vulnerability; phasers cannot destroy it.`);
            }
        } else {
            hita = 0;
            sendMessageToClient(attacker, `Phaser hit on planet had no effect on installations.`);
        }
        return { hita, critdv, critdm, klflg, checkEndGame };
    }

    // --- PHADAM-parity shield/absorption/drain + final damage ---------
    const attackerPos = attacker.ship.position;
    const targetPos = (target instanceof Player && target.ship) ? target.ship.position : (target as Planet).position;
    const distance = chebyshev(attackerPos, targetPos);

    const shooterDamaged =
        !!(attacker.ship?.devices?.phaser > 0) || !!(attacker.ship?.devices?.computer > 0);

    // Shield "energy" and max for the target
    let rawShieldEnergy: number;
    let rawShieldMax: number;
    const targetIsBase = target instanceof Planet && target.isBase;

    if (target instanceof Player && target.ship) {
        rawShieldEnergy = target.ship.shieldEnergy;
        rawShieldMax = MAX_SHIELD_ENERGY;
    } else {
        rawShieldEnergy = (target as Planet).energy; // bases use 0..1000 scale
        rawShieldMax = 1000;
    }

    // Snapshot previous shield % (0..1000) before modification
    const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
    const toPct = (energy: number, max: number) => (max > 0 ? clamp((energy / max) * 1000, 0, 1000) : 0);
    const prevShieldPct = toPct(rawShieldEnergy, rawShieldMax);

    const core = phadamCore({
        targetIsBase,
        rawShieldEnergy,
        rawShieldMax,
        distance,
        shooterDamaged,
        phit: phitUsed,
    });

    hita = core.hita;

    // Write back updated shields/energy (post-drain)
    if (target instanceof Player && target.ship) {
        target.ship.shieldEnergy = core.newShieldEnergy;
    } else {
        (target as Planet).energy = core.newShieldEnergy; // for bases: % store (0..1000)
    }

    // --- Base collapse crit/kill BEFORE hull damage --------------------
    let baseKilledNow = false;
    if (targetIsBase) {
        const newShieldPct = toPct(core.newShieldEnergy, rawShieldMax); // post-drain, pre-hull
        if (prevShieldPct > 0 && newShieldPct === 0) {
            const rana = Math.random();
            const extra = 50 + Math.floor(100 * rana); // 50..149
            (target as Planet).energy = Math.max(0, (target as Planet).energy - extra);
            critdm = Math.max(critdm, 1);

            if (Math.random() < 0.10 || (target as Planet).energy <= 0) {
                klflg = 1;



                // ✅ BASE KILL BONUS (+/-10000), guarded
                if (attacker.ship) {
                    const atkSide = attacker.ship.side;
                    const tgtSide = (target as Planet).side;
                    const sign = (atkSide !== tgtSide) ? 1 : -1;

                    (pointsManager as unknown as ScoringAPI)
                        .addDamageToBases?.(10000 * sign, attacker, atkSide);
                }

                const baseArray = target.side === "FEDERATION" ? bases.federation : bases.empire;
                const idx = baseArray.indexOf(target);
                if (idx !== -1) baseArray.splice(idx, 1);
                (target as Planet).isBase = false;
                (target as Planet).builds = 0;
                (target as Planet).energy = 0;
                handleUndockForAllShipsAfterPortDestruction(target as Planet);
                checkEndGame = true;
                baseKilledNow = true; // don't also apply hull
            }
        }
    }

    // --- Ship device crit + jitter BEFORE hull (ships only) ------------
    if (!baseKilledNow && target instanceof Player && target.ship && Math.random() < CRIT_CHANCE) {
        const crit = applyShipCriticalParity(target, hita);
        hita = crit.hita;
        critdv = crit.critdv;
        critdm = Math.max(critdm, crit.critdm);

        const deviceKeys = Object.keys(target.ship.devices);
        const deviceName = deviceKeys[critdv]?.toUpperCase?.() ?? "DEVICE";
        addPendingMessage(target, `CRITICAL HIT: ${deviceName} damaged by ${critdm}!`);
    }

    // --- Apply damage to hull/energy (skip if base just died) ----------
    if (!baseKilledNow) {
        if (target instanceof Player && target.ship) {
            target.ship.energy -= hita;
            target.ship.damage += hita / 2;
        } else if (target instanceof Planet) {
            target.energy -= hita;
        }
    }

    // --- Destruction check (ship threshold parity = 25000) -------------
    const isDestroyed =
        (target instanceof Player && target.ship && (target.ship.energy <= 0 || target.ship.damage >= SHIP_FATAL_DAMAGE)) ||
        (target instanceof Planet && target.isBase && target.energy <= 0);

    if (isDestroyed && !baseKilledNow) {
        klflg = 1;
        if (target instanceof Player) {
            // ✅ SHIP KILL BONUS (+/-5000), guarded
            if (attacker.ship) {
                const atkSide = attacker.ship.side;
                const tgtSide = (target as Player).ship?.side;
                const sign = (tgtSide && atkSide !== tgtSide) ? 1 : -1;

                (pointsManager as unknown as ScoringAPI)
                    .addDamageToEnemies?.(5000 * sign, attacker, atkSide);
            }

            removePlayerFromGame(target);
            if (attacker.ship) {
                pointsManager.addEnemiesDestroyed(1, attacker, attacker.ship.side);
            }
        } else {
            // (base path for energy <= 0 that wasn't killed in collapse branch)
            // ✅ BASE KILL BONUS (+/-10000), guarded
            if (attacker.ship) {
                const atkSide = attacker.ship.side;
                const tgtSide = (target as Planet).side;
                const sign = (atkSide !== tgtSide) ? 1 : -1;

                (pointsManager as unknown as ScoringAPI)
                    .addDamageToBases?.(10000 * sign, attacker, atkSide);
            }

            const baseArray = target.side === "FEDERATION" ? bases.federation : bases.empire;
            const idx = baseArray.indexOf(target);
            if (idx !== -1) baseArray.splice(idx, 1);
            target.isBase = false;
            target.builds = 0;
            target.energy = 0;
            handleUndockForAllShipsAfterPortDestruction(target);
            checkEndGame = true;
        }
    }

    // --- Scoring: award DAMAGE POINTS from the actual applied hit -------------
    if (attacker.ship && hita > 0) {
        const atkSide = attacker.ship.side;

        // Base damage (+/- based on friend/foe)
        if (target instanceof Planet && target.isBase) {
            const sign = atkSide !== target.side ? 1 : -1;
            (pointsManager as unknown as ScoringAPI)
                .addDamageToBases?.(Math.round(hita) * sign, attacker, atkSide);
        }
        // Ship damage (+/- based on friend/foe)
        else if (target instanceof Player && target.ship) {
            const sign = atkSide !== target.ship.side ? 1 : -1;
            (pointsManager as unknown as ScoringAPI)
                .addDamageToEnemies?.(Math.round(hita) * sign, attacker, atkSide);
        }
    }

    // --- Messaging -----------------------------------------------------
    const coords = ocdefCoords(attacker.settings.ocdef, attacker.ship.position, targetPos);
    sendOutputMessage(attacker, {
        SHORT: `Phaser hit @${coords}: ${Math.round(hita)}`,
        MEDIUM: `Phaser hit on target at ${coords} for ${Math.round(hita)} damage.`,
        LONG: `Phasers struck target at ${coords}, inflicting ${Math.round(hita)} damage. Critical: ${critdm > 0 ? 'Yes' : 'No'}.`
    });

    if (target instanceof Player) {
        addPendingMessage(target, `Phaser hit from ${attacker.ship.name} for ${Math.round(hita)} damage!`);
    }

    return { hita, critdv, critdm, klflg, checkEndGame };
}

// --- Add this helper near your combat utilities ----------------------

/**
 * PHADAM-parity core: shield absorption + shield drain + final damage.
 * Uses Fortran shield scale 0..1000 internally and converts back.
 */
// Core phaser/torpedo damage math — PHADAM parity
// Inputs:
//  - targetIsBase: bases always treated as “shielded” in powfac
//  - rawShieldEnergy: current shield/energy store of target
//  - rawShieldMax: MAX_SHIELD_ENERGY for ships, 1000 for bases
//  - distance: Chebyshev distance between attacker and target
//  - shooterDamaged: attacker phaser/computer damaged -> penalty
//  - phit: caller-provided “power” (PHACON uses 200; BASPHA uses 200/numply; planets use 50+30*builds / numply)
//
// Returns:
//  - hita: hull/energy damage to apply AFTER shield absorption
//  - newShieldEnergy: updated shield store (same units as input)
export function phadamCore(opts: {
    targetIsBase: boolean;
    rawShieldEnergy: number;
    rawShieldMax: number;
    distance: number;
    shooterDamaged: boolean;
    phit: number;
}): { hita: number; newShieldEnergy: number } {
    const {
        targetIsBase,
        rawShieldEnergy,
        rawShieldMax,
        distance,
        shooterDamaged,
        phit,
    } = opts;

    // helpers for 0..1000 “percent” shield math
    const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
    const toPct = (energy: number, max: number) => (max > 0 ? clamp((energy / max) * 1000, 0, 1000) : 0);
    const fromPct = (pct: number, max: number) => clamp((pct / 1000) * max, 0, max);

    let shieldPct = toPct(rawShieldEnergy, rawShieldMax);

    // powfac starts at 80, halves if target has shields up OR is a base
    let powfac = 80;
    if (targetIsBase || shieldPct > 0) powfac = 40;

    // distance falloff: (0.9 + 0.02*rand)^distance
    const base = 0.9 + 0.02 * Math.random();
    let hit = Math.pow(base, Math.max(0, distance));

    // attacker device penalty
    if (shooterDamaged) hit *= 0.8;

    // local hita before scaling
    const localHita = hit;

    // Amount that penetrates shields
    if (shieldPct > 0) {
        // portion that gets through
        hit = (1000 - shieldPct) * localHita * 0.001;

        // shield drain: (localHita * powfac * phit * max(shield%*0.001, 0.1) + 10) * 0.03
        const absorptionFactor = Math.max(shieldPct * 0.001, 0.1);
        const drain = (localHita * powfac * phit * absorptionFactor + 10) * 0.03;

        shieldPct = clamp(shieldPct - drain, 0, 1000);
    } else {
        // no shields — full localHita goes through
        // (hit already equals localHita here)
    }

    // final hull/energy damage
    const hita = Math.max(0, hit * powfac * phit);

    // write back shields in caller’s units
    const newShieldEnergy = fromPct(shieldPct, rawShieldMax);

    return { hita, newShieldEnergy };
}


// --- Optional tiny helper if you don't already have one --------------
// function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }) {
//     const dx = a.x - b.x;
//     const dy = a.y - b.y;
//     return Math.hypot(dx, dy);
// }


export function starbasePhaserDefense(triggeringPlayer: Player): void {

    // function starbasePhaserDamage(distance: number, target: Player): number {
    //     let baseHit = Math.pow(0.9 + 0.02 * Math.random(), distance); // Fortran: pwr(0.9–0.92, id)
    //     if (target.ship && (target.ship.devices.phaser > 0 || target.ship.devices.computer > 0)) {
    //         baseHit *= 0.8; // Fortran: hit *= 0.8 if damaged
    //     }
    //     return baseHit;
    // }
    if (!triggeringPlayer.ship) return;
    const isRomulan = triggeringPlayer.ship.romulanStatus?.isRomulan ?? false;

    const targetSides: ("FEDERATION" | "EMPIRE")[] = isRomulan
        ? ["FEDERATION", "EMPIRE"]
        : triggeringPlayer.ship.side === "FEDERATION"
            ? ["EMPIRE"]
            : ["FEDERATION"];

    for (const side of targetSides) {
        const sideBases = side === "FEDERATION" ? bases.federation : bases.empire;

        for (const base of sideBases) {
            if (base.energy <= 0) continue;

            for (const player of players) {
                if (!player.ship) continue;
                if (player.ship.romulanStatus?.cloaked) continue;
                if (player.ship.side === side && !player.ship.romulanStatus?.isRomulan) continue;

                const distance = chebyshev(player.ship.position, base.position);
                if (distance > STARBASE_PHASER_RANGE) continue;

                // const baseHit = starbasePhaserDamage(distance, player);
                // const powfac = player.ship.shieldsUp ? 40 : 80; // Fortran: powfac halved if shields up
                // const phit = 0.4; // 200 energy equivalent (200/500)

                addPendingMessage(player, `\r\n** ALERT ** Starbase at ${base.position.v}-${base.position.h} opens fire!`);
                addPendingMessage(player, `You are under automatic phaser attack from enemy starbase!`);
                // DO_DAMANGE

                // calculateAndApplyPhaserDamage(base, player, baseHit);
            }
        }
    }
}

export function formatPhaserHit({
    attacker,
    target,
    damage,
    attackerPos,
    targetShieldPercent,
    outputLevel
}: {
    attacker: string;
    target: string;
    damage: number;
    attackerPos: { v: number, h: number };
    targetShieldPercent: number;
    outputLevel: OutputSetting;
}): string {
    const dmg = Math.round(damage);
    const shields = Math.round(targetShieldPercent);

    switch (outputLevel) {
        case "LONG":
            return `${attacker} @${attackerPos.v}-${attackerPos.h} makes ${dmg} unit phaser hit on ${target}, ${shields >= 0 ? "+" : ""}${shields}%`;
        case "MEDIUM":
            return `${attacker[0]} @${attackerPos.v}-${attackerPos.h} ${dmg}P ${target[0]}, ${shields >= 0 ? "+" : ""}${shields}%`;
        case "SHORT":
            return `${attacker[0]} ${attackerPos.v}-${attackerPos.h} ${dmg}P ${target[0]} ${shields >= 0 ? "+" : ""}${shields}`;
    }
}

export function formatPhaserBaseHit({
    player,
    base,
    damage
}: {
    player: Player;
    base: Planet;
    damage: number;
}): string {
    if (!player.ship) return "The phaser malfunctioned.";
    const dmg = Math.round(damage);
    const coords = ocdefCoords(player.settings.ocdef, player.ship.position, base.position);
    const attacker = player.ship.name;
    const output = player.settings.output;

    switch (output) {
        case "LONG":
            return `${attacker} fires phasers and hits ${base.side} base at ${coords} for ${dmg} units`;
        case "MEDIUM":
            return `${attacker?.[0]} PH ${base.side[0]}B @${coords} ${dmg}`;
        case "SHORT":
            return `${attacker?.[0]} > ${base.side[0]}B ${coords} ${dmg}`;
        default:
            return `${attacker} fires phasers and hits ${base.side} base at ${coords} for ${dmg} units`;
    }
}

export function formatPhaserPlanetHit(player: Player, planet: Planet): string {
    if (!player.ship) return "The phaser malfunctioned.";
    const coords = ocdefCoords(player.settings.ocdef, player.ship.position, planet.position);
    const name = player.ship.name;
    switch (player.settings.output) {
        case "SHORT":
            return `${name?.[0]} > P ${coords} ${planet.builds}B`;
        case "MEDIUM":
            return `${name} hit planet @${coords}, builds left: ${planet.builds}`;
        case "LONG":
            return `${name} fired phasers at planet located at ${coords}. Remaining builds: ${planet.builds}`;
    }
}

export function formatPhaserBaseDestroyed({ player, base }: { player: Player; base: Planet }): string {
    if (!player.ship) return "The phaser malfunctioned.";
    const coords = ocdefCoords(player.settings.ocdef, player.ship.position, base.position);
    const output = player.settings.output;
    switch (output) {
        case "SHORT":
            return `☠ ${base.side[0]}B ${coords}`;
        case "MEDIUM":
            return `${base.side} base destroyed at ${coords}`;
        case "LONG":
            return `The ${base.side} base at ${coords} has been destroyed!`;
    }
}

export function sendFormattedMessageToObservers({
    origin,
    attacker,
    target,
    damage,
    targetShieldPercent,
    formatFunc
}: {
    origin: { v: number, h: number };
    attacker: string;
    target: string;
    damage: number;
    targetShieldPercent: number;
    formatFunc: (opts: {
        attacker: string;
        target: string;
        damage: number;
        attackerPos: { v: number, h: number };
        targetShieldPercent: number;
        outputLevel: OutputSetting;
    }) => string;
}): void {
    for (const other of players) {
        if (!other.radioOn) continue;
        if (!other.ship) continue;

        if (chebyshev(origin, other.ship.position) > 10) continue;

        const msg = formatFunc({
            attacker,
            target,
            damage,
            attackerPos: origin,
            targetShieldPercent,
            outputLevel: other.settings.output
        });

        addPendingMessage(other, msg);
    }
}

function preparePhaserShot(attacker: Player, requestedPhit: number | undefined): { phit: number; energySpent: number } {
    // Default PHACON phit
    let phit = (requestedPhit ?? 0) > 0 ? requestedPhit! : 200;

    // Cost is phit * 10 (integer scaling in original)
    let energyCost = Math.floor(phit * 10);

    // If not enough energy, scale phit down proportionally
    const ship = attacker.ship!;
    if (ship.energy < energyCost) {
        phit = Math.max(0, Math.floor(ship.energy / 10));
        energyCost = Math.floor(phit * 10);
    }

    // Deduct the cost
    ship.energy = Math.max(0, ship.energy - energyCost);

    return { phit, energySpent: energyCost };
}


export const CRIT_CHANCE = 0.20;


export function applyShipCriticalParity(
    target: Player,
    baseHita: number
): {
    hita: number;          // final hit after halve + jitter
    critdv: number;        // device index chosen (-1 if none)
    critdm: number;        // device damage amount applied
    droppedShields: boolean;
} {
    // Narrow first to satisfy strict null checks
    const ship = target.ship;
    // If somehow called without a ship, just do a safe halve+jitter and return
    if (!ship) {
        let hita = Math.max(0, Math.floor(baseHita / 2));
        const jitter = Math.floor((Math.random() - 0.5) * 1000);
        hita = Math.max(0, hita + jitter);
        return { hita, critdv: -1, critdm: 0, droppedShields: false };
    }

    // halve hit per parity
    let hita = Math.floor(baseHita / 2);

    // pick a random device (handle empty set defensively)
    const deviceKeys = Object.keys(ship.devices) as Array<keyof typeof ship.devices>;
    if (deviceKeys.length === 0) {
        const jitter = Math.floor((Math.random() - 0.5) * 1000);
        hita = Math.max(0, hita + jitter);
        return { hita, critdv: -1, critdm: 0, droppedShields: false };
    }

    const critdv = Math.floor(Math.random() * deviceKeys.length);
    const device = deviceKeys[critdv];

    // device takes damage equal to (halved) hit
    const critdm = Math.max(0, hita);
    ship.devices[device] = (ship.devices[device] ?? 0) + critdm;

    // if it's the shields device, drop shields immediately
    let droppedShields = false;
    if (/shield/i.test(String(device))) {
        ship.shieldsUp = false;
        ship.shieldEnergy = 0;
        droppedShields = true;
    }

    // jitter ±500
    const jitter = Math.floor((Math.random() - 0.5) * 1000);
    hita = Math.max(0, hita + jitter);

    return { hita, critdv, critdm, droppedShields };
}


function applyInstallationPhaserToShip(opts: {
    attackerPlanet: Planet;
    target: Player;
    phit: number;           // already scaled for numply
    distance: number;       // Chebyshev
}) {
    const { attackerPlanet, target, phit, distance } = opts;
    if (!target.ship) return { hita: 0, killed: false };

    const coords = ocdefCoords(target.settings.ocdef, attackerPlanet.position, target.ship.position);
    sendMessageToClient(target, `Phaser fire from planet @${coords}!`);

    // PHADAM shield math (shooter is NOT a ship)
    const core = phadamCore({
        targetIsBase: false,
        rawShieldEnergy: target.ship.shieldEnergy,
        rawShieldMax: MAX_SHIELD_ENERGY,
        distance,
        shooterDamaged: false,   // planet devices can’t be “damaged”
        phit
    });

    // write back shields, then ship-crit + jitter BEFORE hull (PHADAM parity)
    target.ship.shieldEnergy = core.newShieldEnergy;

    let hita = core.hita;
    if (Math.random() < CRIT_CHANCE) {
        const crit = applyShipCriticalParity(target, hita);
        hita = crit.hita;
        // We don’t broadcast device detail here; player still gets the main hit msg.
    }

    // apply to hull
    target.ship.energy -= hita;
    target.ship.damage += hita / 2;

    const killed =
        target.ship.energy <= 0 || target.ship.damage >= SHIP_FATAL_DAMAGE;

    return { hita, killed };
}

export function planetPhaserDefense(triggeringPlayer: Player): void {
    if (!triggeringPlayer.ship) return;
    const isRomulanMove = !!triggeringPlayer.ship.romulanStatus?.isRomulan;
    const moverSide = triggeringPlayer.ship.side;
    const numply = players.filter(p => p.ship).length;

    for (const planet of planets) {
        if (planet.isBase) continue; // bases handled elsewhere
        if (planet.energy <= 0) continue; // inert planet

        // Activation rules:
        const isNeutral = planet.side === "NEUTRAL";
        const isEnemy = planet.side !== "NEUTRAL" && planet.side !== moverSide;

        if (!isRomulanMove) {
            if (!isEnemy && !isNeutral) continue;          // own side’s planets do NOT activate
            if (isNeutral && Math.random() < 0.5) continue; // 50% chance to skip neutrals
        } else {
            // Romulan activates both sides; neutrals still 50%
            if (isNeutral && Math.random() < 0.5) continue;
        }

        // Precompute phit from builds: (50 + 30*builds) / numply
        const phit = (50 + 30 * (planet.builds ?? 0)) / Math.max(numply, 1);

        // scan for enemy, visible ships in range 2
        for (const p of players) {
            if (!p.ship) continue;
            if (p.ship.romulanStatus?.cloaked) continue;          // “disp > 0” analogue
            if (planet.side !== "NEUTRAL" && p.ship.side === planet.side && !p.ship.romulanStatus?.isRomulan) continue;

            const dist = chebyshev(planet.position, p.ship.position);
            if (dist > PLANET_PHASER_RANGE) continue;

            // fire!
            const { hita, killed } = applyInstallationPhaserToShip({
                attackerPlanet: planet,
                target: p,
                phit,
                distance: dist
            });

            if (hita <= 0) continue;

            // Team scoring: damage goes to the planet’s captor side; kill yields +5000
            if (planet.side !== "NEUTRAL") {
                pointsManager.addDamageToEnemies(hita, /*by*/ undefined, planet.side);
                if (killed) {
                    pointsManager.addDamageToEnemies(5000, /*by*/ undefined, planet.side);
                }
            }

            // Player messaging (pridis/makhit analogue)
            const coords = ocdefCoords(p.settings.ocdef, p.ship.position, planet.position);
            addPendingMessage(p,
                `ALERT: Planet at ${coords} fires phasers! You take ${Math.round(hita)} damage.`);

            // If the victim died, handle removal like elsewhere
            if (killed) {
                removePlayerFromGame(p);
            }
        }
    }
}
