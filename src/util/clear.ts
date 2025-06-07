import { Player } from '../player.js';
import { sendMessageToClient } from '../communication.js';

export function clearCommand(player: Player): void {
    sendMessageToClient(player, '\x1b[2J\x1b[H');
}

