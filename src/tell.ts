import { Player } from './player.js';
import { Command } from './command.js';
import { players } from './game.js';
import { addPendingMessage, sendMessageToClient } from './communication.js';
import { SHIPNAMES } from './settings.js';
import { matchesPattern } from './util/util.js';

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
    let recipients = players.filter(p => p.alive);

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

    // --- Deliver messages ---
    for (const recipient of recipients) {
        if (recipient !== player) {
            if (recipient.radioOn) {
                addPendingMessage(recipient, `<< ${player.ship.name} (TELL): ${message}`);
            }
        }
    }
    sendMessageToClient(player, `>> To ${targetDesc}: ${message}`);
}