// server.ts (excerpt) — run your telnet server as usual, then:
import { startApiServer } from "./api/server.js";
import type { GameStateProvider } from "./api/provider.js";

import { planets, stars, blackholes, bases, players } from "./game.js";
import {
  toSummaryDTO,
  toPlayerDTO,
  toPlanetDTO,
  toStarDTO,
  toBlackholeDTO,
  toBaseDTO,
} from "./api/dto.js";
import type { Ship } from "./ship.js";

// Build the read-only provider against your live state
const provider: GameStateProvider = {
  getSummary: () =>
    toSummaryDTO({
      players,
      planets,
      stars,
      blackholes,
      federationBases: bases.federation,
      empireBases: bases.empire,
    }),

  listPlayers: () =>
    players
      .filter((p): p is Player & { ship: Ship } => Boolean(p.ship))
      .map(toPlayerDTO),

  listPlanets: () => planets.map(toPlanetDTO),
  listStars: () => stars.map(toStarDTO),
  listBlackholes: () => blackholes.map(toBlackholeDTO),
  listBases: () => [...bases.federation, ...bases.empire].map(toBaseDTO),
};

// Start the API if desired (env or explicit)
if (process.env.API_PORT) {
  startApiServer(provider);
}



import * as net from 'net';
import { config } from 'dotenv';
import { Player } from './player.js';
import { limbo } from './game.js';
import { queueCommands } from './command.js';
import { MAX_PLAYERS } from './settings.js';
import { swapPlayerForBackhole } from './gripe.js';
import { parseAndExecutePGCommand } from './pregame.js';
import { removePlayerFromGame } from './game.js';

config();

const IAC = 255;
//const IP = 244;
const SE = 240;
const DO = 253;
const DONT = 254;
const WILL = 251;
const WONT = 252;
const SB = 250;

const ECHO = 1;
const SUPPRESS_GO_AHEAD = 3;
const LINEMODE = 34;

export const clients: Map<net.Socket, Player> = new Map();

const server = net.createServer((socket) => {
  if (players.length >= MAX_PLAYERS) {
    socket.write("Server is full.\r\n");
    socket.end();
    return;
  }

  const player = new Player(socket);
  clients.set(socket, player);
  //players.push(player);

  // Negotiate raw mode: suppress line mode and client-side echo
  socket.write(Buffer.from([IAC, WILL, SUPPRESS_GO_AHEAD]));
  socket.write(Buffer.from([IAC, WILL, ECHO]));
  socket.write(Buffer.from([IAC, WONT, LINEMODE]));

  // Welcome and initial SUM command
  //socket.write(`[DECWARJS Version ${gameSettings.version}, ${gameSettings.date}]\r\n`);
  socket.write(`Now entering DECWARJS Pre-game; type\r\nACtivate to enter game.\r\n`);
  socket.write(player.getPrompt());
  //socket.write('\r\n' + player.getPrompt() + ' ');
  //parseAndExecuteCommand(player, 'SUM');

  let skipLF = false;

  socket.on('data', (chunk: Buffer) => {
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];

      // Telnet IAC sequences — silently skip
      if (byte === IAC) {
        const command = chunk[i + 1];

        if (command === IAC) {
          // Literal 255
          i++; // skip extra 255
          continue;
        }

        if (
          command === DO || command === DONT ||
          command === WILL || command === WONT
        ) {
          // IAC DO/WILL/WONT/DONT option
          i += 2; // skip IAC, command, and option
          continue;
        }

        if (command === SB) {
          // IAC SB ... IAC SE
          i += 2; // skip IAC and SB and option
          // Skip until IAC SE
          while (i < chunk.length) {
            if (chunk[i] === IAC && chunk[i + 1] === SE) {
              i += 2;
              break;
            }
            i++;
          }
          continue;
        }

        // All other IAC commands (like IP, NOP, SE, etc.)
        i += 1; // skip IAC and command
        continue;
      }

      // Ctrl-C (ASCII 3)
      if (byte === 3) {
        handleControlC(player, socket);
        continue;
      }

      // Ctrl-U (ASCII 21) — clear entire input line
      if (byte === 21) {
        if (!player.ready) continue;
        const erase = '\b \b'.repeat(player.inputBuffer.length);
        socket.write(erase);
        player.inputBuffer = '';
        continue;
      }

      // Backspace/Delete (ASCII 8 or 127)
      if (byte === 8 || byte === 127) {
        if (player.inputBuffer.length > 0) {
          player.inputBuffer = player.inputBuffer.slice(0, -1);
          socket.write('\b \b');
        }
        continue;
      }

      // ESC key (ASCII 27) — recall next command from history
      if (byte === 27 && (chunk[i + 1] === undefined || chunk[i + 1] < 32)) {
        if (!player.ready) continue;
        const erase = '\b \b'.repeat(player.inputBuffer.length);
        socket.write(erase);
        const command = player.getNextHistory() || '';
        player.inputBuffer = command;
        socket.write(command);
        continue;
      }

      // Enter (CR or LF)
      if ((byte === 13 || (byte === 10 && !skipLF)) && !player.multiLine || (player.multiLine && byte === 0x1A)) {
        if (player.inputBuffer === '') {    // handle empty line by user
          socket.write('\r\n\r\n' + player.getPrompt());
          continue;
        }
        player.lastActivity = Date.now();
        if (byte === 13) skipLF = true;
        const line = player.inputBuffer.trim();
        player.inputBuffer = '';
        socket.write('\r\n\r\n');

        if (player.isOnHold) {
          socket.write(player.getPrompt());
          continue;
        }

        if (player.currentPrompt) {
          const cb = player.callBack;
          player.callBack = undefined;
          player.currentPrompt = undefined;
          cb?.(player, line);
        } else if (line) {
          if (players.includes(player)) { // why?
            player.addToHistory(line);
            queueCommands(player, line);
            //parseAndExecuteCommand(player, line);
          } else {
            parseAndExecutePGCommand(player, line);
          }
        }
        continue;
      }

      if (player.multiLine && (byte === 13 || byte === 10)) {
        player.inputBuffer += '\n';
        socket.write('\r\n');
        continue;
      }

      // Skip LF if part of CRLF
      if (byte === 10 && skipLF) {
        skipLF = false;
        continue;
      }

      // Printable characters (ASCII 32–126)
      if (byte >= 32 && byte <= 126) {
        if (!player.ready) {
          player.ready = true;
          //socket.write('\r\n' + player.getPrompt() + ' ');
        }

        const char = String.fromCharCode(byte);
        player.inputBuffer += char;
        socket.write(char);
      }
    }
  });


  socket.on('close', () => {
    clients.delete(socket);
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err.message);
    clients.delete(socket);
  });
});

function handleControlC(player: Player, socket: net.Socket): void {
  let atCommandPrompt: boolean = true;

  if (player.multiLine) {
    socket.write(`^C Use ^Z to end.\r\n`);
    return;
  }

  if (player.currentCommandTimer || player.commandQueue.length > 0) {
    atCommandPrompt = false;
  }


  player.inputBuffer = "";

  // 2. Cancel the current timer if any
  if (player.currentCommandTimer) {
    clearTimeout(player.currentCommandTimer);
    player.currentCommandTimer = null;
  }

  // 3. Clear the queued commands
  player.commandQueue = [];

  // 4. Reset processing flag (in case a command never called `done`)
  player.processingCommand = false;
  player.multiLine = false;
  player.currentPrompt = undefined;
  player.isOnHold = false;


  if (limbo.includes(player)) {
    swapPlayerForBackhole(player);
  }

  // 5. Notify user + reprint prompt
  if (atCommandPrompt) {
    if (player.ship && player.ship.condition == "RED") {
      socket.write("Use QUIT to terminate while under RED alert.\r\n");
      socket.write(`${player.getPrompt()} `);
    } else {
      removePlayerFromGame(player);
      socket.write(`^C\r\n${player.getPrompt()} `);
    }
  } else {
    if (player.ready) {
      socket.write('\r\x1b[K'); // Clear line
      socket.write('\x07\x07\x07\x07'); // Optional bells
      socket.write('Commands cancelled.\r\n');
      socket.write(`${player.getPrompt()} `);
    }
  }
}

const PORT = 23;
server.listen(PORT, () => console.log(`Telnet server running on port ${PORT}`));


// function isSocketActive(socket: net.Socket): boolean {
//     return !socket.destroyed && socket.writable;
// }

// Optional: try a no-op write to check silently
export function isSocketLive(socket: net.Socket): boolean {
  return (!socket.destroyed && socket.writable && socket.readable);
}