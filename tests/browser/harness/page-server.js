'use strict';

const http = require('http');
const net = require('net');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startPageServer(pagePort) {
  const pageServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>Bosun Helper browser test</title></head><body></body></html>');
  });
  await new Promise((resolve, reject) => {
    pageServer.once('error', reject);
    pageServer.listen(pagePort, '127.0.0.1', resolve);
  });
  return pageServer;
}

module.exports = { reservePort, startPageServer };
