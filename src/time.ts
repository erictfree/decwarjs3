import { Player } from './player.js';
import { sendMessageToClient } from './communication.js';
const gameStartTime = Date.now();

export function timeCommand(player: Player): void {
    const nowMs = Date.now();

    const secsSinceGameStart = (nowMs - gameStartTime) / 1000;
    const secsSinceJoin = (nowMs - player.joinTime) / 1000;
    const processUptimeSec = process.uptime();

    const currentTime = new Date(nowMs).toLocaleTimeString('en-US', {
        hour12: false
    });

    const timeLine = (label: string, value: string | number) => `  ${label.padEnd(22)}${value}`;
    // Add random 2 digits to stardate for a "fancy" stardate as a number
    // Galactic stardate is seconds since game start divided by 100, plus random 2 digits at the end
    //const baseStardate = secsSinceGameStart / 100;

    sendMessageToClient(player, timeLine("Stardate:", player.stardate));
    sendMessageToClient(player, timeLine("Game's elapsed time:", formatDuration(secsSinceGameStart)));
    sendMessageToClient(player, timeLine("Ship's elapsed time:", formatDuration(secsSinceJoin)));
    sendMessageToClient(player, timeLine("Current time (UTC):", currentTime));
    sendMessageToClient(player, timeLine("Job's total run time:", formatDuration(processUptimeSec)));
    sendMessageToClient(player, "");
}

export function formatDuration(totalSeconds: number): string {
    const days = Math.floor(totalSeconds / 86400);
    totalSeconds %= 86400;

    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);

    const hms = [
        hours.toString().padStart(2, '0'),
        minutes.toString().padStart(2, '0'),
        seconds.toString().padStart(2, '0')
    ].join(':');

    return days > 0
        ? `${days}d ${hms}`
        : hms;
}