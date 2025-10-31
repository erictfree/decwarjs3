import { Player } from './player.js';
import { Side } from './settings.js';
import { Planet } from './planet.js';
import { bases, players, pointsManager, SHIP_FATAL_DAMAGE } from './game.js';
import { chebyshev } from './coords.js';
import { phadamCore } from './phaser.js';
import { maybeApplyShipCriticalParity } from './phaser.js';
import { applyDamage } from './torpedo.js';
import { MAX_SHIELD_ENERGY } from './settings.js';
import { addPendingMessage, sendMessageToClient } from './communication.js';
import { Ship } from './ship.js';
import { getRandom } from './util/random.js'; // deterministic RNG used elsewhere
import { emitShieldsChanged } from './api/events.js';
import { sendMessageToOthers } from './communication.js';

const BASE_PHASER_RANGE = 4; // bases fire out to 4 sectors (Chebyshev)

type RomulanStatus = {
    isRomulan: boolean;
    isRevealed: boolean;
    cloaked: boolean;
};

// Match the phaser module’s PHADAM input scale (ships divide by 20 before core).
const PHADAM_PHIT_DIVISOR = 20;

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
            const s = ship.ship!;
            const distance = chebyshev(base.position, s.position);
            if (distance > BASE_PHASER_RANGE) continue;
            if (s.romulanStatus?.cloaked) continue;

            // PHADAM (base -> ship): targetIsBase=false, shooterDamaged=false
            const shieldsBefore = s.shieldEnergy;
            const targetShieldsUp = Boolean(s.shieldsUp);

            const core = phadamCore({
                targetIsBase: false,
                targetShieldsUp,
                rawShieldEnergy: s.shieldEnergy,
                rawShieldMax: MAX_SHIELD_ENERGY,
                distance,
                shooterDamaged: false,
                // DECWAR parity: pass raw 200/numply; no extra scaling
                phit: basePhit,
            });

            let hita = core.hita;

            // Write back shield drain first
            s.shieldEnergy = core.newShieldEnergy;
            if (shieldsBefore !== s.shieldEnergy) {
                emitShieldsChanged(ship, shieldsBefore, s.shieldEnergy);
            }

            // Ship device crit BEFORE hull (threshold rule; jitter only on crits)
            if (hita > 0) {
                const crit = maybeApplyShipCriticalParity(ship, hita);
                if (crit.isCrit) {
                    hita = crit.hita;

                    const deviceKeys = Object.keys(s.devices);
                    const deviceName = deviceKeys[crit.critdv]?.toUpperCase?.() ?? "DEVICE";
                    if (crit.critdm > 0) {
                        addPendingMessage(ship, `BASE PHASERS CRIT: ${deviceName} damaged by ${crit.critdm}!`);
                    } else {
                        addPendingMessage(ship, `BASE PHASERS CRIT: ${deviceName} struck!`);
                    }
                } else {
                    // Non-crit: round like the Fortran path (no global jitter)
                    hita = Math.max(0, Math.round(hita));
                }
            }

            // Use pre-state to gate kill credit during this volley
            const wasAlive = s.energy > 0;

            // Apply hull/energy via shared resolver (so you keep one place for destruction rules)
            const damageRes = applyDamage(base, ship, hita, getRandom());

            // DECWAR-style message for the target captain
            const sectorText = distance === 1 ? "SECTOR" : "SECTORS";
            addPendingMessage(
                ship,
                `Base ${base.name} fires phaser! (${distance} ${sectorText})`
            );

            // === scoring parity (credit exactly this volley) ===
            const dealt = Math.max(0, Math.round(damageRes.hita));

            try {
                // scoring: base category + kill-only-once
                (pointsManager as any).addDamageToBases?.(dealt, /*by*/ undefined, base.side);
                if (wasAlive && damageRes.isDestroyed && ship.ship && !ship.ship.__killCredited) {
                    ship.ship.__killCredited = true;
                    (pointsManager as any).addEnemiesDestroyed?.(1, /*by*/ undefined, base.side);
                }
            } catch { /* okay if pointsManager is not present */ }
            // ===================================================
        }
    }
}

function hasRomulanStatus(s: Ship): s is Ship & { romulanStatus: RomulanStatus } {
    return typeof (s as unknown as { romulanStatus?: RomulanStatus }).romulanStatus !== "undefined";
}
