import { players } from "./game.js";
import { chebyshev } from "./coords.js";
import { Player } from "./player.js";

export type OutputVariants = {
    SHORT: string;
    MEDIUM: string;
    LONG: string;
};

export function addPendingMessage(player: Player, message: string): void {
    player.pendingMessages.push(message);
}

export function sendPendingMessages(player: Player): void {
    sendMessageToClient(player, '\r\n', false, false);
    const len = player.pendingMessages.length;
    for (let i = 0; i < len; i++) {
        const message = player.pendingMessages[i];
        if (i === len - 1) {
            sendMessageToClient(player, message, true, true);
        } else {
            sendMessageToClient(player, message, true, false);
        }
    }
    player.pendingMessages = [];
}

export function sendAllPendingMessages(): void {
    for (const player of players) {
        if (player.pendingMessages.length > 0) {
            sendPendingMessages(player);
        }
    }
}

export function sendMessageToClient(
    player: Player,
    message: string,
    returns = true,  // put return in output
    command = false   // if command then print prompt after
): void {
    if (!player.socket) return; // bots don't have a socket
    try {
        //player.socket.write('\r\x1b[K');

        if (returns) player.socket.write(`${message}\r\n`);
        else player.socket.write(`${message}`);
        if (command && !player.isOnHold) player.socket.write(`${player.getPrompt()}${player.inputBuffer}`);
    } catch (err: unknown) {
        console.error('Error in sendMessageToClient:', err instanceof Error ? err.message : String(err));
    }
}

export function sendMessageToOthers(player: Player, message: string, range: number = 10): void {
    if (!player.ship) return;
    const origin = player.ship.position;

    for (const other of players) {
        if (other === player || !other.ship || !other.radioOn) continue;

        if (chebyshev(origin, other.ship.position) <= range) {
            sendMessageToClient(other, "\r\n" + message, true, true);
        }
    }
}

export function sendMessageToOthersWithFormat(
    origin: Player,
    formatter: (recipient: Player) => string
): void {
    players.forEach((recipient) => {
        if (recipient !== origin && recipient.ship) {
            const msg = formatter(recipient);
            addPendingMessage(recipient, msg);
        }
    });
}

export function sendOutputMessage(player: Player, variants: OutputVariants): void {
    const level = player.settings.output;
    const message = variants[level] ?? variants.LONG;
    sendMessageToClient(player, message);
}

// export function safeBroadcastMessage(
//     message: string,
//     returns = true,
//     command = true
// ): void {
//     for (const [socket, clientState] of clients.entries()) {
//         try {
//             socket.write('\r\x1b[K');
//             if (returns) socket.write(`${message}\r\n`);
//             else socket.write(`${message}`);
//             if (command) socket.write(` ${clientState.inputBuffer}`);
//         } catch (err: unknown) {
//             console.error('Error in safeBroadcastMessage:', err instanceof Error ? err.message : String(err));
//         }
//     }
// }

export function putClientOnHold(player: Player, message: string): void {
    player.isOnHold = true;
    if (message !== "") {
        sendMessageToClient(player, message, false, false);
    }
}

export function releaseClient(player: Player, message: string | null = null): void {
    player.isOnHold = false;
    if (message) {
        sendMessageToClient(player, message);
    }
}