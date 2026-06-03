import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT || 8787);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clients = new Map();
const rooms = new Map();

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(root, pathname));

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': contentType(filePath) });
    response.end(content);
  });
});

server.on('upgrade', (request, socket) => {
  if (request.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }

  const key = request.headers['sec-websocket-key'];
  const accept = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  attachClient(socket, request);
});

function attachClient(socket, request) {
  const id = crypto.randomUUID();
  const networkRoom = `network:${hashNetwork(getIp(request))}`;
  const client = { id, socket, name: 'Sans nom', rooms: new Set([networkRoom]), code: '' };
  clients.set(id, client);
  addToRoom(networkRoom, id);
  sendFrame(socket, { type: 'welcome', id });

  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let parsed;
    while ((parsed = readFrame(buffer))) {
      buffer = buffer.subarray(parsed.length);
      if (parsed.opcode === 8) {
        socket.end();
        return;
      }
      if (parsed.opcode === 1) {
        handleMessage(client, parsed.payload.toString('utf8'));
      }
    }
  });

  socket.on('close', () => removeClient(client));
  socket.on('error', () => removeClient(client));
}

function handleMessage(client, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (message.type === 'hello' || message.type === 'rename') {
    client.name = sanitizeName(message.name);
    broadcastRooms(client.rooms);
  }

  if (message.type === 'refresh') {
    broadcastRooms(client.rooms);
  }

  if (message.type === 'join-code') {
    const code = sanitizeCode(message.code);
    if (!code) return;
    client.code = code;
    const room = `code:${code}`;
    client.rooms.add(room);
    addToRoom(room, client.id);
    broadcastRooms(client.rooms);
  }

  if (message.type === 'signal') {
    const target = clients.get(message.to);
    if (!target) return;
    sendFrame(target.socket, { type: 'signal', from: client.id, payload: message.payload });
  }
}

function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = Boolean(second & 0x80);
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    length = Number(bigLength);
    offset += 8;
  }

  let mask;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }

  return { opcode, payload, length: offset + length };
}

function sendFrame(socket, payload) {
  if (socket.destroyed) return;
  const data = Buffer.from(JSON.stringify(payload));
  let header;

  if (data.length < 126) {
    header = Buffer.from([0x81, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }

  socket.write(Buffer.concat([header, data]));
}

function addToRoom(room, id) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(id);
}

function broadcastRooms(roomNames) {
  for (const room of roomNames) {
    const members = rooms.get(room);
    if (!members) continue;
    const peers = [...members]
      .map((id) => clients.get(id))
      .filter(Boolean)
      .map((client) => ({ id: client.id, name: client.name, code: client.code }));

    for (const id of members) {
      const client = clients.get(id);
      if (client) sendFrame(client.socket, { type: 'peers', peers });
    }
  }
}

function removeClient(client) {
  if (!clients.has(client.id)) return;
  clients.delete(client.id);
  for (const room of client.rooms) {
    const members = rooms.get(room);
    if (!members) continue;
    members.delete(client.id);
    if (!members.size) rooms.delete(room);
  }
  broadcastRooms(client.rooms);
}

function getIp(request) {
  const forwarded = request.headers['x-forwarded-for'];
  const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
  return (ip || request.socket.remoteAddress || 'unknown').replace('::ffff:', '');
}

function hashNetwork(ip) {
  const parts = ip.split('.');
  const isPrivateIpv4 = parts.length === 4 && (
    parts[0] === '10' ||
    (parts[0] === '172' && Number(parts[1]) >= 16 && Number(parts[1]) <= 31) ||
    (parts[0] === '192' && parts[1] === '168') ||
    parts[0] === '127'
  );
  const network = isPrivateIpv4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0` : ip;
  return crypto.createHash('sha256').update(network).digest('hex').slice(0, 18);
}

function sanitizeName(name) {
  return String(name || 'Sans nom').trim().slice(0, 28) || 'Sans nom';
}

function sanitizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function contentType(filePath) {
  const extension = path.extname(filePath);
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
  }[extension] || 'application/octet-stream';
}

server.listen(port, '0.0.0.0', () => {
  const publicUrl =
    process.env.RENDER_EXTERNAL_URL ||
    'https://clemdrop.onrender.com';

  console.log(`Clemdrop is running on ${publicUrl}`);
  console.log(`Listening on port ${port}`);
});