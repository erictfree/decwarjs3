
import { sendMessageToClient } from './communication.js';
import { Command } from './command.js';
import { MAX_SHIELD_ENERGY, settings } from './settings.js';
import { Player } from './player.js';
import { ocdefCoords } from './coords.js';

/**
 * Syntax: STATUS [<codes>]
 * Codes: C (Condition), L (Location), T (Torpedoes), E (Energy),
 *        D (Damage), SH (Shields), RA (Radio), PH (Phasers cooldown)
 * No args: full report in order: Condition, Location, Torps, Energy,
 *          Damage, Shields, Radio.
 */
export function statusCommand(player: Player, command: Command): void {
    const args = command.args.map(a => a.toUpperCase());
    const mode: "SHORT" | "MEDIUM" | "LONG" = player.settings.output ?? "LONG";
    //const coordsMode = player.settings.ocdef ?? "ABSOLUTE";

    if (!player.ship) {
        sendMessageToClient(player, "You must be in a ship to use STATUS.");
        return;
    }

    const allFields = ['condition', 'location', 'torpedoes', 'energy', 'damage', 'shields', 'radio', 'phasers'];

    let fields: string[];
    if (args.length === 0) {
        fields = allFields;
    } else {
        fields = allFields.filter(field =>
            args.some(arg => arg.length > 1 && field.toLowerCase().startsWith(arg)) ? field : false
        );
    }

    console.log(fields);

    // Always display stardate first
    switch (mode) {
        case "SHORT":
            sendMessageToClient(player, `SD${settings.stardate}`);
            break;
        case "MEDIUM":
            sendMessageToClient(player, `SDate    ${settings.stardate}`);
            break;
        case "LONG":
        default:
            sendMessageToClient(player, `Stardate   ${settings.stardate}`);
            break;
    }

    const shortParts: string[] = [];
    const conditionStr = player.ship.computeCondition();

    for (const field of fields) {
        switch (field) {
            case 'condition': {
                const isDocked = player.ship.docked;
                const flag = conditionStr[0]; // R, Y, G
                const text = isDocked ? `D+${flag}` : flag;
                if (mode === "SHORT") shortParts.push(text);
                else if (mode === "MEDIUM") sendMessageToClient(player, `Cond   ${conditionStr}`);
                else sendMessageToClient(player, `Condition  ${conditionStr}`);
                break;
            }
            case 'location': {
                const coordText = ocdefCoords(player.settings.ocdef, player.ship.position, player.ship.position);

                if (mode === "SHORT") shortParts.push(coordText);
                else if (mode === "MEDIUM") sendMessageToClient(player, `Loc    ${coordText}`);
                else sendMessageToClient(player, `Location   ${coordText}`);
                break;
            }
            case 'torpedoes': {
                const t = `T${player.ship.torpedoes}`;
                if (mode === "SHORT") shortParts.push(t);
                else if (mode === "MEDIUM") sendMessageToClient(player, `Torps    ${player.ship.torpedoes}`);
                else sendMessageToClient(player, `Torpedoes  ${player.ship.torpedoes}`);
                break;
            }
            case 'energy': {
                const e = `E${Math.round(player.ship.energy)}`;
                if (mode === "SHORT") shortParts.push(e);
                else if (mode === "MEDIUM") sendMessageToClient(player, `Ener   ${player.ship.energy.toFixed(1)}`);
                else sendMessageToClient(player, `Energy     ${player.ship.energy.toFixed(1)}`);
                break;
            }
            case 'damage': {
                const d = `D${Math.round(player.ship.damage)}`;
                if (mode === "SHORT") shortParts.push(d);
                else if (mode === "MEDIUM") sendMessageToClient(player, `Dam     ${player.ship.damage.toFixed(1)}`);
                else sendMessageToClient(player, `Damage     ${player.ship.damage.toFixed(1)}`);
                break;
            }
            case 'shields': {
                const curr = player.ship.level;
                const pct = Math.round((curr / MAX_SHIELD_ENERGY) * 100);
                const status = player.ship.shieldsUp ? "UP" : "DN";
                if (mode === "SHORT") shortParts.push(`SH+${pct}/${status}`);
                else if (mode === "MEDIUM") sendMessageToClient(player, `Shlds  +${pct.toFixed(1)}% ${curr.toFixed(1)} units (${status})`);
                else sendMessageToClient(player, `Shields    +${pct.toFixed(1)}%   ${curr.toFixed(1)} units (${status})`);
                break;
            }
            case 'radio': {
                const r = player.radioOn ? "ROn" : "ROff";
                if (mode === "SHORT") shortParts.push(r);
                else if (mode === "MEDIUM") sendMessageToClient(player, `Radio  ${player.radioOn ? "On" : "Off"}`);
                else sendMessageToClient(player, `Radio      ${player.radioOn ? "On" : "Off"}`);
                break;
            }
            case 'phasers': {
                const now = Date.now();
                const [ph1, ph2] = player.ship.cooldowns.phasersAvailableAt;
                const nextReady = Math.min(ph1, ph2);
                const ready = now >= nextReady;
                if (mode === "SHORT") {
                    shortParts.push(ready ? "PHok" : `PH${Math.ceil((nextReady - now) / 1000)}s`);
                } else {
                    const message = ready
                        ? "Phasrs     ready"
                        : `Phasrs     cooling down (${Math.ceil((nextReady - now) / 1000)}s)`;
                    sendMessageToClient(player, message);
                }
                break;
            }
        }
    }

    if (mode === "SHORT") {
        sendMessageToClient(player, shortParts.join(" "));
    }
}
