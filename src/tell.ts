import { Player } from './player.js';
import { Command } from './command.js';
import { players } from './game.js';
import { addPendingMessage, sendMessageToClient } from './communication.js';
import { SHIPNAMES } from './settings.js';
import { matchesPattern } from './util/util.js';
// 👇 NEW: event emitter for chat/comms
import { emitCommsSent } from './api/events.js';

export function tellCommand(player: Player, command: Command): void {
    if (!player.ship) {
        sendMessageToClient(player, "You must be in a ship to use TELL.");
        return;
    }

    if (!player.ship.isDeviceOperational("radio")) return;

    if (!command.raw.includes(';')) {
        sendMessageToClient(player, "TEll All|FEderation|HUman|EMpire|Klingon|ENemy|FRiendly|<shipnames>;<msg>");
        return;
    }

    const [targetPart, ...msgParts] = command.raw.split(";");
    const message = msgParts.join(";").trim();

    if (!player.radioOn) {
        sendMessageToClient(player, "Captain, your radio is off.");
        return;
    }

    if (!message) {
        sendMessageToClient(player, "Message required after semicolon.");
        return;
    }

    const targetTokens = targetPart.trim().split(/\s+/).slice(1).map(t => t.toUpperCase());
    let targetDesc = targetTokens.join(" ");
    let recipients = players.filter(p => p.ship);

    const keyword = targetTokens[0];

    // --- Handle broadcast group keywords ---
    const matchGroup =
        matchesPattern(keyword, "All") ? "ALL" :
            matchesPattern(keyword, "FEderation") ? "FEDERATION" :
                matchesPattern(keyword, "EMpire") ? "EMPIRE" :
                    matchesPattern(keyword, "Human") ? "HUMAN" :
                        matchesPattern(keyword, "Klingon") ? "KLINGON" :
                            matchesPattern(keyword, "ENemy") ? "ENEMY" :
                                matchesPattern(keyword, "FRiendly") ? "FRIENDLY" :
                                    null;

    if (matchGroup) {
        switch (matchGroup) {
            case "ALL":
                recipients = players.filter(p => p.ship);
                targetDesc = "ALL";
                break;
            case "FEDERATION":
            case "HUMAN":
                recipients = recipients.filter(p => p.ship && p.ship.side === "FEDERATION");
                targetDesc = matchGroup;
                break;
            case "EMPIRE":
            case "KLINGON":
                recipients = recipients.filter(p => p.ship && p.ship.side === "EMPIRE");
                targetDesc = matchGroup;
                break;
            case "ENEMY":
                recipients = recipients.filter(p => p.ship && player.ship && p.ship.side !== player.ship.side);
                targetDesc = "ENEMY";
                break;
            case "FRIENDLY":
                recipients = recipients.filter(p => p.ship && player.ship && p.ship.side === player.ship.side);
                targetDesc = "FRIENDLY";
                break;
        }
    } else {
        // --- Handle ship name targeting ---
        const matchedShips: Player[] = [];
        for (const target of targetTokens) {
            const matches = recipients.filter(p => p.ship?.name?.toUpperCase().startsWith(target));
            if (matches.length === 1) {
                matchedShips.push(matches[0]);
            } else if (SHIPNAMES.some(name => name.startsWith(target))) {
                sendMessageToClient(player, `Ship ${SHIPNAMES.find(name => name.startsWith(target))} not in game`);
            } else {
                sendMessageToClient(player, `Unknown target: ${target}`);
            }
        }
        recipients = matchedShips;
    }

    if (recipients.length === 0) {
        sendMessageToClient(player, `No reachable ${matchGroup}'s for TELL.`);
        return;
    }

    // --- Emit ONE comms event describing what was sent ---
    try {
        if (matchGroup) {
            let to:
                | { kind: "GLOBAL" }
                | { kind: "SIDE"; side: "FEDERATION" | "EMPIRE" };

            if (matchGroup === "ALL") {
                to = { kind: "GLOBAL" };
            } else if (matchGroup === "FEDERATION" || matchGroup === "HUMAN") {
                to = { kind: "SIDE", side: "FEDERATION" };
            } else if (matchGroup === "EMPIRE" || matchGroup === "KLINGON") {
                to = { kind: "SIDE", side: "EMPIRE" };
            } else if (matchGroup === "FRIENDLY") {
                // Narrow Side → "FEDERATION" | "EMPIRE"
                const mySide = player.ship!.side === "FEDERATION" ? "FEDERATION" : "EMPIRE" as const;
                to = { kind: "SIDE", side: mySide };
            } else { // ENEMY
                const enemySide = player.ship!.side === "FEDERATION" ? "EMPIRE" : "FEDERATION" as const;
                to = { kind: "SIDE", side: enemySide };
            }

            emitCommsSent(player, to, message);
        } else {
            // ship-directed: emit one event per explicit ship
            for (const r of recipients) {
                if (!r.ship) continue;
                emitCommsSent(player, { kind: "SHIP", shipName: r.ship.name, side: r.ship.side === "FEDERATION" ? "FEDERATION" : "EMPIRE" }, message);
            }
        }
    } catch {
        // never let telemetry break gameplay
    }

    // --- Deliver messages (unchanged behavior) ---
    for (const recipient of recipients) {
        if (recipient !== player) {
            if (recipient.radioOn) {
                addPendingMessage(recipient, `<< ${player.ship.name} (TELL): ${message}`);
            }
        }
    }
    sendMessageToClient(player, `>> To ${targetDesc}: ${message}`);
}
