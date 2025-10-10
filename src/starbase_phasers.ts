import { Player } from './player.js';
import { Side } from './settings.js';
import { Planet } from './planet.js';
import { bases, players } from './game.js';
import { chebyshev } from './coords.js';
import { phadamCore } from './phaser.js';
import { applyShipCriticalParity } from './phaser.js';
import { applyDamage } from './torpedo.js';
import { MAX_SHIELD_ENERGY } from './settings.js';
import { CRIT_CHANCE } from './phaser.js';
import { addPendingMessage } from './communication.js';
import { Ship } from './ship.js';
import { pointsManager } from './game.js';
import { getRandom } from './util/random.js'; // deterministic RNG used elsewhere

type RomulanStatus = {
    isRomulan: boolean;
    isRevealed: boolean;
    cloaked: boolean;
};



// // --- BASPHA parity: enemy bases fire once per sweep ------------------
// function isVisibleToBase(p: Player): boolean {
//     // If you have real cloaking/visibility, use that here:
//     return !(p.ship && (p.ship as any).isCloaked);
// }

// --- BASPHA parity: enemy bases fire once per sweep ------------------
function isVisibleToBase(p: Player): boolean {
    const s = p.ship;
    // Preserve prior behavior: players without a ship were treated as "visible"
    if (!s) return true;

    // Invisible only if truly cloaked and not currently revealed
    if (hasRomulanStatus(s)) {
        return !(s.romulanStatus.cloaked && !s.romulanStatus.isRevealed);
    }

    // No romulan status → visible
    return true;
}

function baseIsOperational(p: Planet): boolean {
    // Today: all registry entries are operational.
    // Future: add e.g. `return p.isBase && !p.destroyed;`
    return p.isBase === true;
}

function enemyBasesFor(side: Side): Planet[] {
    if (side === "ROMULAN") {
        return [...bases.federation, ...bases.empire].filter(baseIsOperational);
    }
    const enemySide: Side = (side === "FEDERATION") ? "EMPIRE" : "FEDERATION";
    const arr = (enemySide === "FEDERATION") ? bases.federation : bases.empire;
    return arr.filter(baseIsOperational);
}

export function basphaFireOnce(mover: Player, numply: number): void {
    if (!mover?.ship) return;

    // Fortran BASPHA: phit = floor(200 / numply)
    const basePhit = Math.max(1, Math.floor(200 / Math.max(1, numply)));

    const allTargets = players.filter(
        p => p?.ship && p.ship.energy > 0 && isVisibleToBase(p)
    );

    const basesToFire = enemyBasesFor(mover.ship.side);

    for (const base of basesToFire) {
        // Each base selects enemies of its own side (important if mover is ROMULAN)
        const targets = allTargets.filter(p => p.ship!.side !== base.side);

        for (const ship of targets) {
            const distance = chebyshev(base.position, ship.ship!.position);
            if (distance > 4) continue; // Fortran: ldis(..., 4)

            // PHADAM (base -> ship): targetIsBase=false, shooterDamaged=false
            const core = phadamCore({
                targetIsBase: false,
                rawShieldEnergy: ship.ship!.shieldEnergy,
                rawShieldMax: MAX_SHIELD_ENERGY,
                distance,
                shooterDamaged: false,
                phit: basePhit,
            });

            let hita = core.hita;

            // write back shield drain
            ship.ship!.shieldEnergy = core.newShieldEnergy;

            // Ship device crit + ±500 jitter BEFORE hull (same as players)
            if (getRandom() < CRIT_CHANCE) {
                const crit = applyShipCriticalParity(ship, hita);
                hita = crit.hita;
                const deviceKeys = Object.keys(ship.ship!.devices);
                const deviceName = deviceKeys[crit.critdv]?.toUpperCase?.() ?? "DEVICE";
                addPendingMessage(ship, `BASE PHASERS CRIT: ${deviceName} damaged by ${crit.critdm}!`);
            }

            // use current "alive" gate as pre-state to avoid double kill credit within the sweep
            const wasAlive = ship.ship!.energy > 0;

            // apply hull/energy damage & destruction via shared resolver (deterministic rng)
            const res = applyDamage(base, ship, hita, getRandom());

            // === scoring parity (credit exactly this volley) ===
            const dealt = Math.max(0, Math.round(res.hita));
            try {
                pointsManager.addDamageToEnemies(dealt, /*player*/ undefined, base.side);
                if (wasAlive && res.isDestroyed) {
                    pointsManager.addEnemiesDestroyed(1, /*player*/ undefined, base.side);
                }
            } catch {
                // pointsManager may be absent in some builds; ignore
            }
            // ===================================================
        }
    }
}


function hasRomulanStatus(s: Ship): s is Ship & { romulanStatus: RomulanStatus } {
    return typeof (s as unknown as { romulanStatus?: RomulanStatus }).romulanStatus !== "undefined";
}