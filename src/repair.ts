import { Player } from './player.js';
import { sendMessageToClient, putClientOnHold, releaseClient } from './communication.js';
import {
    MAX_SHIP_ENERGY,
    MAX_SHIELD_ENERGY,
    ENERGY_REPAIR_AMOUNT,
    ENERGY_REPAIR_COST,
    SHIELD_REPAIR_AMOUNT,
    SHIELD_REPAIR_COST,
    OutputSetting,
} from './settings.js';
import { DeviceName } from './ship.js';
import { Command } from './command.js';
//import { starbasePhaserDefense } from './base.js'; TODO: Add this back in

export function repairCommand(player: Player, command: Command, done?: () => void): void {
    if (!player.ship) {
        sendMessageToClient(player, "You cannot repair — you have no ship.");
        done?.();
        return;
    }

    const mode: OutputSetting = player.settings.output ?? "LONG";

    const defaultRepair = player.ship.docked ? 100 : 50;
    const repairAmount = command.args.length > 0 ? parseInt(command.args[0], 10) : defaultRepair;

    if (isNaN(repairAmount) || repairAmount <= 0) {
        sendMessageToClient(player, "Invalid repair amount. Usage: RE [<units>]");
        done?.();
        return;
    }

    const damagedDevices = Object.entries(player.ship.devices)
        .filter(entry => entry[1] > 0) as [DeviceName, number][];

    if (
        damagedDevices.length === 0 &&
        player.ship.energy >= MAX_SHIP_ENERGY &&
        player.ship.shieldEnergy >= MAX_SHIELD_ENERGY
    ) {
        sendMessageToClient(player, "All systems are fully operational. No repairs needed.");
        done?.();
        return;
    }

    const delaySeconds = (repairAmount * 0.08) * (player.ship.docked ? 0.5 : 1);
    putClientOnHold(player, "Repairing...");

    const timer = setTimeout(() => {
        const repaired: string[] = [];
        let totalDeviceRepair = 0;

        if (!player.ship) {
            sendMessageToClient(player, "You cannot repair — you have no ship.");
            done?.();
            return;
        }

        for (const [device, damage] of damagedDevices) {
            const repair = Math.min(repairAmount, damage);
            player.ship.devices[device] -= repair;
            totalDeviceRepair += repair;

            if (mode === "SHORT") {
                sendMessageToClient(player, `${device}+${repair}`);
            } else if (mode === "MEDIUM") {
                sendMessageToClient(player, `${device} repaired ${repair}`);
            } else {
                sendMessageToClient(player, `${device} repaired ${repair} units.`);
            }
        }

        if (player.ship.shieldEnergy < MAX_SHIELD_ENERGY) {
            if (player.ship.energy >= SHIELD_REPAIR_COST) {
                player.ship.energy -= SHIELD_REPAIR_COST;
                const restored = Math.min(SHIELD_REPAIR_AMOUNT, MAX_SHIELD_ENERGY - player.ship.shieldEnergy);
                player.ship.shieldEnergy += restored;
                repaired.push("shields");
            } else {
                if (mode !== "SHORT") {
                    sendMessageToClient(player, "Insufficient energy to repair shields.");
                }
            }
        }

        if (player.ship.energy < MAX_SHIP_ENERGY && player.ship.energy >= ENERGY_REPAIR_COST) {
            const restored = Math.min(ENERGY_REPAIR_AMOUNT, MAX_SHIP_ENERGY - player.ship.energy);
            player.ship.energy += restored;
            repaired.push("energy");
        }

        if (totalDeviceRepair > 0 || repaired.length > 0) {
            if (mode === "SHORT") {
                sendMessageToClient(player, `+${totalDeviceRepair} ${repaired.join(", ")}`);
            } else if (mode === "MEDIUM") {
                sendMessageToClient(player, `Repair complete: ${totalDeviceRepair} units. Restored: ${repaired.join(", ")}`);
            } else {
                sendMessageToClient(player, `Repair completed. Devices repaired: ${totalDeviceRepair} units. Restored: ${repaired.join(", ")}`);
            }
        } else {
            sendMessageToClient(player, "Repair completed. No systems needed repair.");
        }

        releaseClient(player);
        done?.();
    }, delaySeconds * 1000);

    player.currentCommandTimer = timer;
    // starbasePhaserDefense(player);

    if (mode !== "SHORT") {
        sendMessageToClient(player, `Beginning repair of ${repairAmount} units... (${delaySeconds.toFixed(1)}s)`);
    }
}

/**
 * Auto-repair that runs after every time-consuming move (FORTRAN REPAIR with il=3).
 * Silently subtracts the normal per-turn repair from EACH damaged device.
 * Note: FORTRAN repsiz=300 corresponds to 30 real units; we use 30 here.
 * Docking does NOT accelerate this path (il==3 is not promoted to docked speed).
 */
export function autoRepairTick(player: Player): void {
    if (!player.ship) return;
    const NORMAL_TURN_REPAIR = 30; // DECWAR manual: "normal repair rate of 30 units per turn"
    let any = false;
    for (const [device, dmg] of Object.entries(player.ship.devices)) {
        const cur = typeof dmg === "number" ? dmg : 0;
        if (cur > 0) {
            const newVal = Math.max(0, cur - NORMAL_TURN_REPAIR);
            // @ts-expect-error: DeviceName index is valid at runtime
            player.ship.devices[device] = newVal;
            any = true;
        }
    }
    // No messages and no pause (matches FORTRAN REPAIR il=3 behavior).
}
