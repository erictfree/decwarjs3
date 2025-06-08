import {
    sendMessageToClient,
    putClientOnHold,
    releaseClient,
    sendOutputMessage,
    addPendingMessage
} from "./communication.js";
import { Ship, applyDeviceDamage } from "./ship.js";
import { bresenhamLine } from "./coords.js";
import { GRID_WIDTH, GRID_HEIGHT, WARP_DELAY_MIN_MS, WARP_DELAY_RANGE, IMPULSE_DELAY_MS, IMPULSE_DELAY_RANGE } from "./settings.js";
import { isInBounds, getCoordsFromCommandArgs, findObjectAtPosition, ocdefCoords, isAdjacent, getTrailingPosition } from "./coords.js";
import { Player } from "./player.js";
import { Command } from "./command.js";

import { disconnectTractor } from "./tractor.js";

export function moveCommand(player: Player, command: Command, done?: () => void): void {

    if (!player.ship) {
        sendMessageToClient(player, "You must be in a ship to use this command.");
        done?.();
        return;
    }

    const args = command.args;
    const ship = player.ship;

    if (!player.ship.isDeviceOperational("warp")) {
        done?.();
        return;
    }

    if (!args.length) {
        sendMessageToClient(player, "Usage: MOVE/IMPULSE [A|R|C] <vpos> <hpos> OR MOVE C <ship>");
        done?.();
        return;
    }

    const { position: { v: targetVInput, h: targetHInput }, mode, error } = getCoordsFromCommandArgs(
        player,
        args,
        ship.position.v,
        ship.position.h,
        true
    );

    if (error) {
        sendOutputMessage(player, {
            SHORT: "MOVE > BAD COORD",
            MEDIUM: `Bad MOVE input (${mode})`,
            LONG: `Invalid MOVE command: ${error} in ${mode}`
        });
        done?.();
        return;
    }

    if (!isInBounds(targetVInput, targetHInput)) {
        sendOutputMessage(player, {
            SHORT: "MOVE > OUT OF BOUNDS",
            MEDIUM: "Invalid MOVE target sector.",
            LONG: `Target sector must be within 1–${GRID_WIDTH}.`
        });
        done?.();
        return;
    }

    const startV = ship.position.v;
    const startH = ship.position.h;
    const dv = Math.abs(targetVInput - startV);
    const dh = Math.abs(targetHInput - startH);
    const warp = Math.max(dv, dh);

    if (warp === 0) {
        sendOutputMessage(player, {
            SHORT: "MOVE > SAME",
            MEDIUM: "Already there.",
            LONG: "You're already at that position."
        });
        done?.();
        return;
    }

    if (warp > 6) {
        sendOutputMessage(player, {
            SHORT: "MOVE > WARP MAX",
            MEDIUM: "Warp too far. Max 6.",
            LONG: "Warp factor too high. Maximum warp is 6 sectors."
        });
        done?.();
        return;
    }

    maybeDamageFromWarp(ship, warp);

    let multiplier = 1;
    if (ship.shieldsUp) {
        multiplier = 2;
    }
    if (ship.tractorPartner) {
        multiplier = 3;
    }

    const energyCost = warp * warp * multiplier;

    if (ship.energy < energyCost) {
        sendOutputMessage(player, {
            SHORT: `MOVE > NO E`,
            MEDIUM: `Energy too low: need ${energyCost}`,
            LONG: `Not enough energy. Needed: ${energyCost}, Available: ${ship.energy}`
        });
        done?.();
        return;
    }

    if (ship.docked) {
        ship.docked = false;
        sendMessageToClient(player, "You have undocked from the base.");
    }

    // —— Collision Detection ——  
    const destination = { v: targetVInput, h: targetHInput };
    let prevPoint = { v: startV, h: startH };
    let collisionDetected = false;

    for (const pt of bresenhamLine(startV, startH, destination.v, destination.h)) {
        const { v, h } = pt;
        if (v === startV && h === startH) continue;

        if (findObjectAtPosition(v, h)) {
            destination.h = prevPoint.h;
            destination.v = prevPoint.v;
            collisionDetected = true;
            break;
        }

        prevPoint = pt;
    }

    const originalEnergy = ship.energy;
    ship.energy -= energyCost;
    //updateShipCondition(player);  TODO    

    maybeMisnavigate(player, destination);

    const delayMs = WARP_DELAY_MIN_MS + Math.random() * WARP_DELAY_RANGE;
    const formattedTarget = ocdefCoords(player.settings.ocdef, player.ship.position, { v: destination.v, h: destination.h });

    putClientOnHold(player, `Warping to ${formattedTarget} (warp ${warp})...`);

    const message = collisionDetected
        ? "Navigation Officer: Collision averted, Captain!"
        : `${ship.name} now in sector ${formattedTarget}.`;

    const timer = setTimeout(() => {
        // Check again just before moving
        if (findObjectAtPosition(destination.v, destination.h)) {
            releaseClient(player);
            ship.energy = originalEnergy;
            sendMessageToClient(player, "Warp aborted: sector is now occupied.");
        } else {
            releaseClient(player);
            ship.position = { v: destination.v, h: destination.h };
            sendMessageToClient(player, message);
            if (ship.tractorPartner) tractorShip(ship);
        }
        done?.();
    }, delayMs);
    player.currentCommandTimer = timer;
    //starbasePhaserDefense(player); TODO
}

function maybeDamageFromWarp(ship: Ship, warpDistance: number): void {
    if (warpDistance <= 4) return;

    if (warpDistance >= 5) {
        sendMessageToClient(ship.player, `Warning: warp factor ${warpDistance} may damage engines`);
        let damage = 0;
        if (warpDistance === 5 && Math.random() < 0.2) {
            damage = 100;
        } else if (warpDistance >= 6 && Math.random() < 0.5) {
            damage = 200;
        }

        if (damage > 0) {
            const status = damage >= 300 ? "destroyed" : "damaged";
            applyDeviceDamage(ship, damage, ["warp"]);
            sendMessageToClient(ship.player, `Warp engines ${status}`);
        }
    }
}

export function impulseCommand(player: Player, command: Command, done?: () => void): void {
    if (!player.ship) {
        sendMessageToClient(player, "You must be in a ship to use this command.");
        done?.();
        return;
    }

    const ship = player.ship;

    if (!ship.isDeviceOperational("impulse")) {
        done?.();
        return;
    }

    const { position: { v: targetVInput, h: targetHInput }, mode, error } = getCoordsFromCommandArgs(
        player,
        command.args,
        ship.position.v,
        ship.position.h,
        false // COMPUTED not allowed for IMPULSE
    );

    if (error) {
        sendOutputMessage(player, {
            SHORT: "IMP > BAD COORD",
            MEDIUM: `Bad IMPULSE input (${mode})`,
            LONG: `Invalid IMPULSE command: ${error} in ${mode}`
        });
        done?.();
        return;
    }

    const destination = { v: targetVInput, h: targetHInput };

    // DECWAR: only cardinal directions allowed
    if (!isInBounds(targetVInput, targetHInput)) {
        sendOutputMessage(player, {
            SHORT: "IMP > RANGE",
            MEDIUM: "Not in bounds.",
            LONG: "IMPULSE move must be to a sector within the grid."
        });
        done?.();
        return;
    }

    // DECWAR: only cardinal directions allowed
    if (!isAdjacent(ship.position, destination)) {
        sendOutputMessage(player, {
            SHORT: "IMP > RANGE",
            MEDIUM: "Not adjacent.",
            LONG: "IMPULSE move must be to an adjacent sector."
        });
        done?.();
        return;
    }

    if (findObjectAtPosition(destination.v, destination.h)) {
        sendOutputMessage(player, {
            SHORT: "IMP > OCCUPIED",
            MEDIUM: "Impulse failed: blocked.",
            LONG: "IMPULSE failed: destination sector is occupied."
        });
        done?.();
        return;
    }

    let energyCost = 1;
    if (ship.shieldsUp) {
        energyCost *= 2;
    }
    // TODO tractor?

    if (ship.energy < energyCost) {
        sendOutputMessage(player, {
            SHORT: "IMP > NO E",
            MEDIUM: "Not enough energy.",
            LONG: "IMPULSE failed: not enough energy."
        });
        done?.();
        return;
    }

    if (ship.docked) {
        ship.docked = false;
        sendMessageToClient(player, "You have undocked.");
    }

    ship.energy -= energyCost;

    // updateShipCondition(player);  TODO

    maybeMisnavigate(player, destination);  // TODO TEST

    putClientOnHold(player, "Impulse power...");


    const delayMs = IMPULSE_DELAY_MS + Math.random() * IMPULSE_DELAY_RANGE;

    const timer = setTimeout(() => {
        releaseClient(player);
        if (findObjectAtPosition(destination.v, destination.h)) {
            sendOutputMessage(player, {
                SHORT: "IMP > NOW BLOCKED",
                MEDIUM: "Impulse failed: now occupied.",
                LONG: "IMPULSE failed: destination sector is now occupied."
            });
            done?.();
            return;
        }

        const coords = ocdefCoords(player.settings.ocdef, ship.position, destination);
        ship.position = destination;
        sendMessageToClient(player, `IMPULSE complete to sector ${coords}`);

        // tractorShip(ship);  TODO??
        done?.();
    }, delayMs);

    player.currentCommandTimer = timer;
    // starbasePhaserDefense(player);  TODO
}

function maybeMisnavigate(player: Player, destination: { v: number; h: number }): void {
    if (!player.ship) return;
    const ship = player.ship;

    if (ship.devices.computer >= 300) {
        sendMessageToClient(player, "Navigation is inexact: computer inoperative.");

        const offsetV = Math.floor(Math.random() * 3) - 1;
        const offsetH = Math.floor(Math.random() * 3) - 1; // -1 to +1

        destination.v = Math.max(1, Math.min(GRID_HEIGHT, destination.v + offsetV));
        destination.h = Math.max(1, Math.min(GRID_WIDTH, destination.h + offsetH));
    }
}

function tractorShip(ship: Ship): void {
    if (!ship.tractorPartner) return;

    const trailingPosition = getTrailingPosition(ship.position, ship.tractorPartner.position);
    if (!trailingPosition) {
        disconnectTractor(ship);
    } else {
        ship.tractorPartner.position = trailingPosition;
        const coords = ocdefCoords(ship.tractorPartner.player.settings.ocdef, ship.tractorPartner.position, trailingPosition);
        sendMessageToClient(ship.tractorPartner.player, `${ship.name} has moved to ${coords}.`);
        addPendingMessage(ship.tractorPartner.player, `You were tractored to @${trailingPosition.v}-${trailingPosition.h}}.`);
    }
}

