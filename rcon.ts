require('dotenv').config();
const net = require('net');
const cp = require('child_process');

async function waitForPort(port, attempts = 10) {
  return new Promise((resolve, reject) => {
    const tryConnect = n => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolve();
      });
      socket.on('error', err => {
        socket.destroy();
        if (n <= 1) return reject(err);
        setTimeout(() => tryConnect(n - 1), 200);
      });
    };
    tryConnect(attempts);
  });
}

function encode(id, type, body) {
  const bodyBuf = Buffer.from(body, 'utf8');
  const len = bodyBuf.length + 10;
  const buf = Buffer.alloc(len + 4);
  buf.writeInt32LE(len, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  buf.writeInt16LE(0, 12 + bodyBuf.length);
  return buf;
}

async function sendRcon(host, port, password, command) {
  const key = process.env.SSH_KEY_PATH;
  if (!key) throw new Error('SSH_KEY_PATH not set');
  const args = [
    '-i',
    key,
    '-o',
    'StrictHostKeyChecking=no',
    '-L',
    `${port}:localhost:${port}`,
    `${process.env.SSH_USER || 'ec2-user'}@${host}`,
    '-N'
  ];
  const tunnel = cp.spawn('ssh', args);
  tunnel.on('error', err => tunnel.kill());
  await waitForPort(port);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(encode(1, 3, password));
    });
    let authenticated = false;
    const cleanup = () => {
      socket.end();
      tunnel.kill();
    };
    socket.on('data', data => {
      if (!authenticated) {
        authenticated = true;
        socket.write(encode(2, 2, command));
      } else {
        cleanup();
        resolve(data.toString('utf8', 12, data.length - 2));
      }
    });
    socket.on('error', err => {
      cleanup();
      reject(err);
    });
  });
}

export { sendRcon };
