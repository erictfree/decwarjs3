import { sendMessageToClient } from './communication.js';
import { Player } from './player.js';
import fs from 'fs';
import path from 'path';

let newsLog: string[] = [];

export function newsCommand(player: Player): void {
    if (newsLog.length === 0) {
        const filePath = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'help/news.txt');
        const raw = fs.readFileSync(filePath, 'utf8');
        newsLog = raw.split(/\r?\n/);
    }

    if (newsLog.length === 0) {
        sendMessageToClient(player, "No news at this time.");
        return;
    }

    for (const line of newsLog) {
        sendMessageToClient(player, `${line}`);
    }
    sendMessageToClient(player, "");
}
