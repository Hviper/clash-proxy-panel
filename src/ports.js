'use strict';

const net = require('net');

function checkPort(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ port: Number(port), host });

    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function checkPorts(ports, host = '127.0.0.1', timeout = 800) {
  const unique = Array.from(new Set(ports.map(Number).filter((p) => Number.isInteger(p) && p > 0)));
  const results = await Promise.all(unique.map((port) => checkPort(port, host, timeout)));
  const map = {};
  unique.forEach((port, index) => {
    map[String(port)] = results[index];
  });
  return map;
}

module.exports = { checkPort, checkPorts };
