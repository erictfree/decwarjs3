import { Player } from './player.js';
import { players } from './game.js';
import { sendMessageToClient } from './communication.js';

export function usersCommand(requestingPlayer: Player): void {
    if (!players || players.length === 0) {
        sendMessageToClient(requestingPlayer, "No players are currently in the game.");
        return;
    }

    if (!requestingPlayer.ship) {
        sendMessageToClient(requestingPlayer, "You must be in a ship to use this command.");
        return;
    }

    const formatLine = (p: Player): string => {
        const ship = (p.ship?.name ?? "???").padEnd(10, ' ');
        const captain = (p.settings.name || ship).padEnd(15, ' ');
        const ip = (ip4Pretty(p.socket.remoteAddress || "???")).padEnd(15, ' ');
        return `${ship} ${captain} ${ip}`;
    };

    const federationPlayers = players.filter(p => p.ship?.side === "FEDERATION");
    const empirePlayers = players.filter(p => p.ship?.side === "EMPIRE");

    // let output = "Ship       Captain         Location\r\n";
    // output += "---------- --------------- ---------------\r\n";

    let output = "";

    for (const p of federationPlayers) {
        output += formatLine(p) + "\r\n";
    }

    if (empirePlayers.length > 0 && federationPlayers.length > 0) {
        output += "----\r\n";  // Divider
    }

    for (const p of empirePlayers) {
        output += formatLine(p) + "\r\n";
    }

    const romulanPlayers = players.filter(p => p.ship?.romulanStatus.isRomulan);
    if (romulanPlayers.length > 0) {
        output += "----\r\n";  // Divider
    }
    for (const p of romulanPlayers) {
        output += formatLine(p) + "\r\n";
    }

    sendMessageToClient(requestingPlayer, output);
}

function ip4Pretty(ip: string): string {
    if (ip.startsWith('::ffff:')) {
        return ip.replace('::ffff:', '');
    } else if (ip === '::1') {
        return "127.0.0.1";
    } else {
        return ip;
    }
}