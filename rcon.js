const net = require('net');

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
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.write(encode(1, 3, password));
    });
    let authenticated = false;
    socket.on('data', data => {
      if (!authenticated) {
        authenticated = true;
        socket.write(encode(2, 2, command));
      } else {
        socket.end();
        resolve(data.toString('utf8', 12, data.length - 2));
      }
    });
    socket.on('error', err => {
      socket.end();
      reject(err);
    });
  });
}

module.exports = { sendRcon };
