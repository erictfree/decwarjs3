import { sendMessageToClient } from './communication.js';
import { Player } from './player.js';
import { players, limbo, stardate, blackholes } from './game.js';
import { Blackhole } from './blackhole.js';
import * as fs from 'fs';


//export function gripeCommand(player: Player, command: Command, done?: () => void): void {
export function gripeCommand(player: Player): void {
    if (player.ship && player.ship.condition == "RED") {
        sendMessageToClient(player, 'You are not permitted to GRIPE\nwhile under RED alert!');
        return;
    }
    player.currentPrompt = "Enter gripe, end with ^Z\r\n";
    //sendMessageToClient(player, player.currentPrompt, true, false);
    if (player.alive) {
        swapBackholeForPlayer(player);
    }
    player.multiLine = true;
    player.callBack = (pl, resp) => {
        pl.multiLine = false;
        const nowMs = Date.now();
        const currentDateTime = new Date(nowMs).toLocaleString('en-US', {
            hour12: false
        });
        fs.appendFileSync('DECWAR.GRP', `${currentDateTime} ${stardate} ${pl.ship?.name || 'Unknown'}: ${resp}\r\n`);
        if (limbo.includes(player) && player.alive) {
            swapPlayerForBackhole(player);
        }
        sendMessageToClient(player, 'Your gripe has been noted.', true, true);
    }
}

export function swapBackholeForPlayer(player: Player): void {
    if (!player.ship) {
        return;
    }
    const { v, h } = player.ship.position;

    // 1. Create and store the new black hole
    const bh = new Blackhole(v, h);
    blackholes.push(bh);
    limbo.push(player);

    // 2. Remove player from global players list
    const index = players.indexOf(player);
    if (index !== -1) {
        players.splice(index, 1);
    }
}

export function swapPlayerForBackhole(player: Player): void {
    if (!player.ship) {
        return;
    }
    const { v, h } = player.ship.position;

    // Find the black hole at the player's location
    const blackHoleIndex = blackholes.findIndex(bh => bh.position.v === v && bh.position.h === h);

    // If a black hole is found, remove it
    if (blackHoleIndex !== -1) {
        blackholes.splice(blackHoleIndex, 1);
    }
    const index = limbo.indexOf(player);
    if (index !== -1) {
        limbo.splice(index, 1);
    }
    players.push(player);
}
