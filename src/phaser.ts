import { Player } from './player.js';
import { Command } from './command.js';
import { ran } from './util/random.js';
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
import { attackerRef, emitShipDestroyed } from './api/events.js';
import { emitPhaserEvent, emitShieldsChanged, emitPlanetBaseRemoved } from './api/events.js';

import type { Side } from "./settings.js";

type ScoringAPI = {
    addDamageToEnemies?(amount: number, source: Player, side: Side): void;
    addDamageToBases?(amount: number, source: Player, side: Side): void;
    addEnemiesDestroyed?(count: number, source: Player, side: Side): void;
    addPlanetsCaptured?(count: number, player: Player, side: Side): void;
    incrementShipsCommissioned?(side: Side): void;
};

// Player-visible scale: divide energy before feeding PHADAM core.
// 56 is derived from a distance-4 anchor so 200-in ≈ 200 dmg avg.
const PHADAM_PHIT_DIVISOR = 20;

// If your hits look globally too big/small, tweak this (1 = unchanged).
const PHASER_HULL_SCALE: number = 1;

// (debug helper removed)

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
            args[0] = player.settings.icdef; // remove energy and treat as normal
        }
    } else if (command.args.length === 4) { // mode energy v h
        energy = parseInt(command.args[1], 10);
        if (Number.isNaN(energy)) {
            switch (player.settings.output) {
                case "SHORT": sendMessageToClient(player, "PH > BAD E"); break;
                case "MEDIUM": sendMessageToClient(player, "Invalid phaser energy input."); break;
                case "LONG":
                default: sendMessageToClient(player, "Bad energy value provided. Phaser command aborted."); break;
            }
            return;
        } else {
            args = command.args.slice(0, 1).concat(command.args.slice(2));
        }
    }

    if (Number.isNaN(energy)) energy = 200;
    energy = Math.min(Math.max(energy, 50), 500);

    const shieldPenalty = player.ship.shieldsUp ? 200 : 0;
    if (shieldPenalty > 0 && player.settings.output === "LONG") {
        sendMessageToClient(player, "High speed shield control activated.");
    }

    // Pre-check against actual energy model (player units): cost = phit + shieldPenalty
    const totalEnergyCost = Math.floor(energy) + shieldPenalty;
    if (player.ship.energy < totalEnergyCost) {
        const e = player.ship.energy.toFixed(1);
        switch (player.settings.output) {
            case "SHORT": sendMessageToClient(player, `PH > NO E ${e}`); break;
            case "MEDIUM": sendMessageToClient(player, `Insufficient energy: ${e}`); break;
            case "LONG":
            default: sendMessageToClient(player, `Insufficient energy to fire phasers. Available energy: ${e}`); break;
        }
        return;
    }

    const { position: { v: targetV, h: targetH } } =
        getCoordsFromCommandArgs(player, args, player.ship.position.v, player.ship.position.h, true);

    const distance = chebyshev(player.ship.position, { v: targetV, h: targetH });

    if (distance > 10) {
        switch (player.settings.output) {
            case "SHORT": sendMessageToClient(player, "PH > RANGE"); break;
            case "MEDIUM": sendMessageToClient(player, "Target exceeds phaser range."); break;
            case "LONG": sendMessageToClient(player, "Target out of phaser range (maximum 10 sectors)."); break;
        }
        return;
    }

    player.ship.condition = "RED";

    const target = findTargetAt(targetV, targetH);
    if (!target) {
        switch (player.settings.output) {
            case "SHORT": sendMessageToClient(player, "PH > MISS"); break;
            case "MEDIUM": sendMessageToClient(player, "No target present."); break;
            case "LONG": sendMessageToClient(player, "No valid target at that location for phaser strike."); break;
        }
        return;
    }
    const targetSide = target instanceof Planet ? target.side : target.ship?.side;
    if (targetSide === player.ship.side) {
        sendMessageToClient(player, "Cannot fire phasers at a friendly target.");
        return;
    }

    // PHADAM parity: range & device effects applied inside core; pass requested energy.
    const result = applyPhaserDamage(player, target, energy);

    if (result.checkEndGame) checkEndGame();
}

function findTargetAt(v: number, h: number): Player | Planet | null {
    // 1) Ship
    const ship = players.find(p => p.ship && p.ship.position.v === v && p.ship.position.h === h);
    if (ship) return ship;

    // 2) Base via planets (preferred if flagged)
    const planetAt = planets.find(p => p.position.v === v && p.position.h === h);
    if (planetAt?.isBase) return planetAt;

    // 3) Base via bases lists (in case isBase flag isn’t synced)
    const baseOnly = [...bases.federation, ...bases.empire]
        .find(b => b.position.v === v && b.position.h === h);
    if (baseOnly) return baseOnly;

    // 4) Plain planet (non-base)
    return planetAt ?? null;
}

export function applyPhaserDamage(
    attacker: Player,
    target: Player | Planet,
    phit: number
): { hita: number; critdv: number; critdm: number; klflg: number; checkEndGame: boolean } {
    if (!attacker.ship) return { hita: 0, critdv: 0, critdm: 0, klflg: 0, checkEndGame: false };

    // Spend energy & normalize phit (PHACON parity) — do NOT range-scale here.
    const shieldPenalty = attacker.ship.shieldsUp ? 200 : 0;
    const { phit: phitUsed, energySpent } = preparePhaserShot(attacker, phit, shieldPenalty);

    // If power scaled to zero, do not fire at all (prevents free shield drain in core)
    if (phitUsed <= 0) {
        // Keep parity-friendly wording; this avoids emitting any phaser event as well.
        try {
            sendMessageToClient(attacker, "No energy for phasers.");
        } catch { /* no-op */ }
        return { hita: 0, critdv: 0, critdm: 0, klflg: 0, checkEndGame: false };
    }

    // Convert to core scale (floating; FORTRAN used reals)
    const phitForCore = Math.max(0, phitUsed / PHADAM_PHIT_DIVISOR);


    let hita = 0;
    let critdv = 0;
    let critdm = 0;
    let klflg = 0;
    let checkEndGame = false;

    // --- early return: non-base planet (installations only)
    if (target instanceof Planet && !target.isBase) {
        const attackerPos = attacker.ship.position;
        const targetPos = target.position;
        const distance = chebyshev(attackerPos, targetPos);

        emitPhaserEvent({
            by: { shipName: attacker.ship.name, side: attacker.ship.side },
            from: attackerPos,
            to: targetPos,
            distance,
            energySpent,
            target: { kind: "planet", name: target.name, side: target.side, position: target.position },
            result: "no_effect",
        });

        if (Math.random() < 0.25) {
            if (target.builds > 0) {
                target.builds = Math.max(0, target.builds - 1);
                const coords = ocdefCoords(attacker.settings.ocdef, attacker.ship.position, target.position);
                sendOutputMessage(attacker, {
                    SHORT: `Planet hit @${coords}: Builds -1`,
                    MEDIUM: `Phaser hit reduced builds on planet at ${coords} by 1 (now ${target.builds}).`,
                    LONG: `Phasers damaged planetary installations at ${coords}, reducing builds by 1 to ${target.builds}. Cannot destroy planet.`,
                });
                return { hita: 1, critdv: 0, critdm: 0, klflg: 0, checkEndGame: false };
            } else {
                sendMessageToClient(attacker, `Planet at full vulnerability; phasers cannot destroy it.`);
                return { hita: 0, critdv: 0, critdm: 0, klflg: 0, checkEndGame: false };
            }
        } else {
            sendMessageToClient(attacker, `Phaser hit on planet had no effect on installations.`);
            return { hita: 0, critdv: 0, critdm: 0, klflg: 0, checkEndGame: false };
        }
    }

    // --- common path (ship OR base)
    const attackerPos = attacker.ship.position;
    const targetPos =
        target instanceof Player && target.ship ? target.ship.position : (target as Planet).position;
    const distance = chebyshev(attackerPos, targetPos);

    const shooterDamaged =
        !!(attacker.ship?.devices?.phaser > 0) || !!(attacker.ship?.devices?.computer > 0);

    const targetIsShip = target instanceof Player && !!target.ship;
    const targetIsBase = target instanceof Planet && target.isBase;

    // Shield pools + max
    let rawShieldEnergy: number;
    let rawShieldMax: number;
    if (targetIsShip) {
        rawShieldEnergy = (target as Player).ship!.shieldEnergy;
        rawShieldMax = MAX_SHIELD_ENERGY;
    } else {
        rawShieldEnergy = (target as Planet).energy; // 0..1000 store for bases
        rawShieldMax = 1000;
    }

    const toPct1000 = (energy: number, max: number) =>
        max > 0 ? Math.max(0, Math.min(1000, (energy / max) * 1000)) : 0;
    const pct = (x: number, max: number) => {
        const raw = (Math.max(0, x) / Math.max(1, max)) * 100;
        return Math.max(0, Math.min(100, Math.round(raw)));
    };

    const prevShieldPct1000 = toPct1000(rawShieldEnergy, rawShieldMax);
    const shieldsBefore = targetIsShip ? (target as Player).ship!.shieldEnergy : (target as Planet).energy;

    // Use the actual **toggle**: ships use shieldsUp, bases behave as shielded.
    const targetShieldsUp = targetIsShip ? Boolean((target as Player).ship!.shieldsUp) : true;

    // ---- PHADAM-parity core (absorb+drain → hull)
    const core = phadamCore({
        targetIsBase,
        targetShieldsUp,
        rawShieldEnergy,
        rawShieldMax,
        distance,
        shooterDamaged,
        phit: phitForCore,
    });

    // Authoritative hull/energy damage AFTER shields
    hita = core.hita;

    hita = Math.max(0, Math.round(hita)); // keep integer ihita like FORTRAN

    // Optional global hull scale (for legacy-feel tuning)
    if (PHASER_HULL_SCALE !== 1) {
        hita = Math.round(hita * PHASER_HULL_SCALE);
    }

    // Safety: if shields are truly UP and were ~100% before, hull must be 0.
    const EPS = 0.005;
    const beforeFrac = Math.max(0, shieldsBefore) / Math.max(1, rawShieldMax);
    if (targetIsShip && (target as Player).ship!.shieldsUp && beforeFrac >= 1 - EPS && hita > 0) {
        hita = 0;
    }

    // Write back drained shields/energy
    if (targetIsShip) {
        (target as Player).ship!.shieldEnergy = Math.max(0, core.newShieldEnergy);
    } else {
        (target as Planet).energy = core.newShieldEnergy;
    }

    const shieldsAfter = targetIsShip ? (target as Player).ship!.shieldEnergy : (target as Planet).energy;

    if (targetIsShip && shieldsBefore !== shieldsAfter) {
        emitShieldsChanged(target as Player, shieldsBefore, shieldsAfter);
    }

    // --- Base collapse crit BEFORE hull (unchanged behavior)
    let baseKilledNow = false;
    if (targetIsBase) {
        const newShieldPct1000 = toPct1000(shieldsAfter, rawShieldMax); // post-drain, pre-hull
        if (prevShieldPct1000 > 0 && newShieldPct1000 === 0) {
            const rana = Math.random();
            const extra = 50 + Math.floor(100 * rana); // 50..149
            (target as Planet).energy = Math.max(0, (target as Planet).energy - extra);
            critdm = Math.max(critdm, 1);

            if (Math.random() < 0.1 || (target as Planet).energy <= 0) {
                klflg = 1;

                if (attacker.ship) {
                    const atkSide = attacker.ship.side;
                    const tgtSide = (target as Planet).side;
                    const sign = atkSide !== tgtSide ? 1 : -1;
                    (pointsManager as unknown as ScoringAPI).addDamageToBases?.(10000 * sign, attacker, atkSide);
                }

                const baseArray = (target as Planet).side === "FEDERATION" ? bases.federation : bases.empire;
                const idx = baseArray.indexOf(target as Planet);
                if (idx !== -1) baseArray.splice(idx, 1);

                const prevSide = (target as Planet).side;
                (target as Planet).isBase = false;
                (target as Planet).builds = 0;
                (target as Planet).energy = 0;
                handleUndockForAllShipsAfterPortDestruction(target as Planet);

                emitPlanetBaseRemoved(target as Planet, "collapse_phaser", attacker, prevSide);
                checkEndGame = true;
                baseKilledNow = true;
            }
        }
    }

    // --- Ship device crit BEFORE hull (ships only)
    if (!baseKilledNow && targetIsShip && hita > 0) {
        const crit = maybeApplyShipCriticalParity(target as Player, hita);
        if (crit.isCrit) {
            hita = crit.hita;
            critdv = crit.critdv;
            critdm = Math.max(critdm, crit.critdm);
            const deviceKeys = Object.keys((target as Player).ship!.devices);
            const deviceName = deviceKeys[critdv]?.toUpperCase?.() ?? "DEVICE";
            if (crit.critdm > 0) {
                addPendingMessage(target as Player, `CRITICAL HIT: ${deviceName} damaged by ${crit.critdm}!`);
            } else {
                addPendingMessage(target as Player, `CRITICAL HIT: ${deviceName} struck!`);
            }
        }
    }

    // --- Apply hull/energy (skip if base just died in collapse)
    if (!baseKilledNow) {
        if (targetIsShip) {
            const ihita = Math.max(0, Math.round(hita));
            (target as Player).ship!.damage += ihita;                 // KSDAM += ihita
            (target as Player).ship!.energy = Math.max(
                0,
                (target as Player).ship!.energy - hita * Math.random()   // KSNRGY -= hita * RND()
            );
        } else {
            // Bases lose only 1% of the computed hit (DECWAR parity)
            // Bases lose 1% of the computed hit, with a minimum of 1 when hita > 0
            const delta = hita > 0 ? Math.max(1, Math.floor(hita * 0.01)) : 0;
            (target as Planet).energy = Math.max(0, (target as Planet).energy - delta);
        }
    }

    // --- Destruction check
    const isDestroyed =
        (targetIsShip &&
            ((target as Player).ship!.energy <= 0 || (target as Player).ship!.damage >= SHIP_FATAL_DAMAGE)) ||
        (!targetIsShip && (target as Planet).isBase && (target as Planet).energy <= 0);

    if (isDestroyed && !baseKilledNow) {
        klflg = 1;
        if (targetIsShip) {
            // +/-5000 ship kill bonus
            if (attacker.ship) {
                const atkSide = attacker.ship.side;
                const tgtSide = (target as Player).ship!.side;
                const sign = atkSide !== tgtSide ? 1 : -1;
                (pointsManager as unknown as ScoringAPI).addDamageToEnemies?.(5000 * sign, attacker, atkSide);
            }

            emitShipDestroyed(
                (target as Player).ship!.name,
                (target as Player).ship!.side,
                { v: (target as Player).ship!.position.v, h: (target as Player).ship!.position.h },
                attackerRef(attacker),
                "combat"
            );

            // Ensure victim sees a direct line before removal
            try {
                sendMessageToClient(
                    target as Player,
                    `Your ship was destroyed by ${attacker.ship?.name ?? "an unknown attacker"}.`
                );
            } catch { /* ignore */ }

            removePlayerFromGame(target as Player);
            if (attacker.ship) {
                pointsManager.addEnemiesDestroyed(1, attacker, attacker.ship.side);
            }
        } else {
            // base died via hull after PHADAM
            if (attacker.ship) {
                const atkSide = attacker.ship.side;
                const tgtSide = (target as Planet).side;
                const sign = atkSide !== tgtSide ? 1 : -1;
                (pointsManager as unknown as ScoringAPI).addDamageToBases?.(10000 * sign, attacker, atkSide);
            }

            const baseArray = (target as Planet).side === "FEDERATION" ? bases.federation : bases.empire;
            const idx = baseArray.indexOf(target as Planet);
            if (idx !== -1) baseArray.splice(idx, 1);
            (target as Planet).isBase = false;
            (target as Planet).builds = 0;
            (target as Planet).energy = 0;
            handleUndockForAllShipsAfterPortDestruction(target as Planet);
            checkEndGame = true;

            const prevSide = (target as Planet).side;
            emitPlanetBaseRemoved(target as Planet, "collapse_phaser", attacker, prevSide);
        }
    }

    // --- Scoring on actually applied damage
    if (attacker.ship && hita > 0) {
        const atkSide = attacker.ship.side;
        if (!targetIsShip && (target as Planet).isBase) {
            const sign = atkSide !== (target as Planet).side ? 1 : -1;
            (pointsManager as unknown as ScoringAPI).addDamageToBases?.(Math.round(hita) * sign, attacker, atkSide);
        } else if (targetIsShip) {
            const sign = atkSide !== (target as Player).ship!.side ? 1 : -1;
            (pointsManager as unknown as ScoringAPI).addDamageToEnemies?.(Math.round(hita) * sign, attacker, atkSide);
        }
    }

    // --- Attacker messaging (absorption-aware; unchanged semantics)
    const coords = ocdefCoords(attacker.settings.ocdef, attacker.ship.position, targetPos);
    const fullyAbsorbed = Math.round(hita) === 0 && shieldsAfter !== shieldsBefore;

    if (fullyAbsorbed) {
        const beforePctForUi = pct(shieldsBefore, rawShieldMax);
        const afterPctForUi = pct(shieldsAfter, rawShieldMax);
        sendOutputMessage(attacker, {
            SHORT: `@${coords}: absorbed (${beforePctForUi}%→${afterPctForUi}%)`,
            MEDIUM: `Phaser hit absorbed @${coords} (${beforePctForUi}%→${afterPctForUi}% shields).`,
            LONG: `Phaser hit fully absorbed @${coords}. Shields dropped from ${beforePctForUi}% to ${afterPctForUi}%.`,
        });
        if (targetIsShip) {
            addPendingMessage(target as Player, `Phaser hit from ${attacker.ship!.name} absorbed by shields.`);
        }
    } else {
        sendOutputMessage(attacker, {
            SHORT: `Phaser hit @${coords}: ${Math.round(hita)}`,
            MEDIUM: `Phaser hit on target at ${coords} for ${Math.round(hita)} damage.`,
            LONG: `Phasers struck target at ${coords}, inflicting ${Math.round(hita)} damage. Critical: ${critdm > 0 ? "Yes" : "No"}.`,
        });
        if (targetIsShip) {
            addPendingMessage(target as Player, `Phaser hit from ${attacker.ship!.name} for ${Math.round(hita)} damage!`);
        }
    }

    // ----- authoritative event -----
    try {
        const by = { shipName: attacker.ship.name, side: attacker.ship.side };
        const from = attacker.ship.position;
        const to = targetIsShip ? (target as Player).ship!.position : (target as Planet).position;

        const targetRef =
            targetIsShip
                ? { kind: "ship" as const, name: (target as Player).ship!.name, side: (target as Player).ship!.side, position: { ...(target as Player).ship!.position } }
                : (target as Planet).isBase
                    ? { kind: "base" as const, name: (target as Planet).name, side: (target as Planet).side, position: { ...(target as Planet).position } }
                    : { kind: "planet" as const, name: (target as Planet).name, side: (target as Planet).side, position: { ...(target as Planet).position } };

        emitPhaserEvent({
            by,
            from,
            to,
            distance,
            energySpent,
            target: targetRef,
            result: Math.round(hita) > 0 ? "hit" : "no_effect",
            damage: Math.max(0, Math.round(hita)),
            shieldsBefore,
            shieldsAfter,
            crit: critdm > 0 ? { amount: critdm } : null,
            killed: klflg === 1,
        });
    } catch { /* never let telemetry break combat */ }

    return { hita, critdv, critdm, klflg, checkEndGame };
}

// ----- FORTRAN-style helpers -----
const FINT = (x: number) => (x >= 0 ? Math.floor(x) : Math.ceil(x)); // FORTRAN INT
const CLAMP = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * PHADAM-parity core: shield absorption + shield drain + final damage.
 * Uses Fortran shield scale 0..1000 internally and converts back.
 */
export function phadamCore(opts: {
    targetIsBase: boolean;
    targetShieldsUp: boolean;
    rawShieldEnergy: number;
    rawShieldMax: number;
    distance: number;
    shooterDamaged: boolean;
    phit: number;
}): { hita: number; newShieldEnergy: number } {
    const {
        targetIsBase,
        targetShieldsUp,
        rawShieldEnergy,
        rawShieldMax,
        distance,
        shooterDamaged,
        phit,
    } = opts;

    const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
    const toPct = (energy: number, max: number) => (max > 0 ? clamp((energy / max) * 1000, 0, 1000) : 0);
    const fromPct = (pct: number, max: number) => clamp((pct / 1000) * max, 0, max);

    // Read shield level (0..1000 fixed-point percent)
    let shieldPct = toPct(rawShieldEnergy, rawShieldMax);

    // “Shielded” only if a base OR shields are UP and >0%
    const treatedAsShielded = targetIsBase || (targetShieldsUp && shieldPct > 0);

    // powfac halves only when actually shielded
    const powfac = treatedAsShielded ? 40 : 80;

    // distance falloff
    // Parity with FORTRAN PHADAM: 0.90 + 0.02 * ran()
    const base = 0.90 + 0.02 * ran(); // controls fall off over distance

    let localHita = Math.pow(base, Math.max(0, distance));

    // device penalty on attacker
    if (shooterDamaged) localHita *= 0.8;

    // --- shield penetration and drain ---
    // use pre-drain for penetration
    let through = localHita;
    if (treatedAsShielded) {
        // only the fraction not covered by shields goes through
        through = (1000 - shieldPct) * localHita * 0.001;

        // shield drain uses absorption factor of max(shield%*0.001, 0.1)
        const absorptionFactor = Math.max(shieldPct * 0.001, 0.1);
        const drain = (localHita * powfac * phit * absorptionFactor + 10) * 0.03;
        shieldPct = clamp(shieldPct - drain, 0, 1000);
    }

    // final hull/energy damage
    const hita = Math.max(0, through * powfac * phit);

    // write back shields in caller's units
    const newShieldEnergy = fromPct(shieldPct, rawShieldMax);

    return { hita, newShieldEnergy };
}


export function maybeApplyShipCriticalParity(
    target: Player,
    baseHita: number
): {
    hita: number;          // final hit after halve + optional jitter
    critdv: number;        // device index chosen (-1 if none)
    critdm: number;        // device damage amount applied
    droppedShields: boolean;
    isCrit: boolean;
} {
    const ship = target.ship;
    if (!ship) {
        // No ship: cannot do device crit logic; just pass through unchanged.
        return { hita: Math.max(0, Math.round(baseHita)), critdv: -1, critdm: 0, droppedShields: false, isCrit: false };
    }

    // --- DECWAR crit threshold:
    // if (baseHita * (rand + 0.1)) < 1700 -> NO CRIT
    const rana = Math.random();
    if (baseHita * (rana + 0.1) < 1700) {
        return { hita: Math.max(0, Math.round(baseHita)), critdv: -1, critdm: 0, droppedShields: false, isCrit: false };
    }

    // --- CRIT path: halve, device damage = halved amount
    let hita = Math.floor(baseHita / 2);

    const deviceKeys = Object.keys(ship.devices) as Array<keyof typeof ship.devices>;
    if (deviceKeys.length === 0) {
        // still a crit, but no device to damage
        // jitter still applies because it's a crit
        const jitter = Math.floor((Math.random() - 0.5) * 1000); // ±500 on crits only
        hita = Math.max(0, hita + jitter);
        return { hita, critdv: -1, critdm: 0, droppedShields: false, isCrit: true };
    }

    const critdv = Math.floor(Math.random() * deviceKeys.length);
    const device = deviceKeys[critdv];

    const critdm = Math.max(0, hita);
    ship.devices[device] = (ship.devices[device] ?? 0) + critdm;

    // if it's the shields device, drop shields immediately
    let droppedShields = false;
    if (/shield/i.test(String(device))) {
        ship.shieldsUp = false;
        ship.shieldEnergy = 0;
        droppedShields = true;
    }

    // DECWAR: add ±500 jitter on crits
    const jitter = Math.floor((Math.random() - 0.5) * 1000);
    hita = Math.max(0, hita + jitter);

    return { hita, critdv, critdm, droppedShields, isCrit: true };
}

function applyInstallationPhaserToShip(opts: {
    attackerPlanet: Planet; target: Player; phit: number; distance: number;
}) {
    const { attackerPlanet, target, phit, distance } = opts;
    if (!target.ship) return { hita: 0, killed: false };

    const s = target.ship;

    const core = phadamCore({
        targetIsBase: false,
        targetShieldsUp: Boolean(s.shieldsUp),
        rawShieldEnergy: s.shieldEnergy,
        rawShieldMax: MAX_SHIELD_ENERGY,
        distance,
        shooterDamaged: false,   // planet devices can’t be “damaged”
        // Scale same as ship phasers for consistent visible damage
        phit: phit / PHADAM_PHIT_DIVISOR,
    });

    s.shieldEnergy = core.newShieldEnergy;

    let hita = core.hita;
    // Optional global hull scale (legacy/user-visible)
    if (PHASER_HULL_SCALE !== 1) {
        hita = Math.round(hita * PHASER_HULL_SCALE);
    }

    // Small ship-only jitter in *user* units (±25)
    if ((target instanceof Player) && (target as Player).ship && hita > 0) {
        const jitterUser = Math.floor((Math.random() - 0.5) * 50); // -25..+25
        hita = Math.max(0, hita + jitterUser);
    }

    s.energy -= hita;
    s.damage += hita / 2;

    const killed = s.energy <= 0 || s.damage >= SHIP_FATAL_DAMAGE;
    return { hita, killed };
}

export function planetPhaserDefense(triggeringPlayer: Player): void {
    if (!triggeringPlayer.ship) return;
    const isRomulanMove = !!triggeringPlayer.ship.romulanStatus?.isRomulan;
    const moverSide = triggeringPlayer.ship.side;
    const numply = players.filter(p => p.ship).length;

    for (const planet of planets) {
        if (planet.isBase) continue; // bases handled elsewhere
        // NOTE: Non-base planets can fire even with 0 energy/builds (DECWAR-style installs).
        // Do not early-return on energy==0.

        // Activation rules:
        const isNeutral = planet.side === "NEUTRAL";
        const isEnemy = planet.side !== "NEUTRAL" && planet.side !== moverSide;

        if (!isRomulanMove) {
            if (!isEnemy && !isNeutral) continue;          // own side's planets do NOT activate
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
            if (p.ship.romulanStatus?.cloaked) continue;
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
                if (p.ship) {
                    emitShipDestroyed(
                        p.ship.name,
                        p.ship.side,
                        { v: p.ship.position.v, h: p.ship.position.h },
                        /* by */ undefined,
                        "planet"
                    );
                }
                removePlayerFromGame(p);
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
    return `${attacker} @${attackerPos.v}-${attackerPos.h} makes ${dmg} unit phaser hit on ${target}, ${shields >= 0 ? "+" : ""}${shields}%`;
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
    return `${name} hit planet @${coords}, builds left: ${planet.builds}`;
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
    return `${base.side} base destroyed at ${coords}`;
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

function preparePhaserShot(
    attacker: Player,
    requestedPhit: number | undefined,
    extraCost: number = 0
): { phit: number; energySpent: number } {
    // Default PHACON phit (FORTRAN: 200 when unspecified)
    let phit = (requestedPhit ?? 0) > 0 ? requestedPhit! : 200;

    // FORTRAN parity: debit = phit + extraCost (no ×10)
    let energyCost = Math.floor(phit) + Math.max(0, Math.floor(extraCost));

    const ship = attacker.ship!;
    if (ship.energy < energyCost) {
        // Scale phit down to fit available energy after paying extraCost
        const availableForPhit = Math.max(0, ship.energy - Math.max(0, Math.floor(extraCost)));
        phit = Math.max(0, Math.floor(availableForPhit));   // <-- no /10
        energyCost = Math.floor(phit) + Math.max(0, Math.floor(extraCost));
    }

    // Deduct
    ship.energy = Math.max(0, ship.energy - energyCost);

    return { phit, energySpent: energyCost };
}