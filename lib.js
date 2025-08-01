require('dotenv').config();
const fs = require('fs');
const cp = require('child_process');
const {
  EC2Client,
  DescribeInstancesCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  CreateTagsCommand,
  DescribeSecurityGroupsCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  AuthorizeSecurityGroupEgressCommand,
  waitUntilInstanceRunning
} = require('@aws-sdk/client-ec2');
const {
  S3Client,
  ListObjectsV2Command,
  GetBucketLocationCommand,
  GetObjectCommand
} = require('@aws-sdk/client-s3');
const { Client: SSHClient } = require('ssh2');

function log(...args) {
  if (process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true') {
    const ts = new Date().toISOString();
    const fmt = args.map(a => {
      if (typeof a === 'string' && !a.startsWith('`') && !a.endsWith('`') && !a.includes(' ')) {
        return `\`${a}\``;
      }
      return a;
    });
    console.log(ts, ...fmt);
  }
}

const templatePath = process.env.EC2_TEMPLATE || 'ec2_template.json';
const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));

const awsConfig = {
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
};

const ec2 = new EC2Client(awsConfig);
let s3 = new S3Client(awsConfig);

const state = { instanceId: null };

async function ensureBucketRegion() {
  if (!awsConfig.region) {
    const tmp = new S3Client({ ...awsConfig, region: 'us-east-1' });
    try {
      const resp = await tmp.send(
        new GetBucketLocationCommand({ Bucket: process.env.BACKUP_BUCKET })
      );
      awsConfig.region = resp.LocationConstraint || 'us-east-1';
      s3 = new S3Client(awsConfig);
      log('Detected bucket region', awsConfig.region);
    } catch {
      // fall back to default region
    }
  }
}

async function findRunningInstance() {
  log('Searching for running EC2 instance');
  const filters = [
    { Name: 'instance-state-name', Values: ['pending', 'running'] }
  ];
  for (const [k, v] of Object.entries(template.tags)) {
    filters.push({ Name: `tag:${k}`, Values: [v] });
  }
  const resp = await ec2.send(new DescribeInstancesCommand({ Filters: filters }));
  for (const res of resp.Reservations || []) {
    for (const inst of res.Instances || []) {
      log('Found running instance', inst.InstanceId);
      return inst;
    }
  }
  log('No running instance found');
  return null;
}

async function ensureSecurityGroup() {
  log('Ensuring security group', template.security_group_name);
  const resp = await ec2.send(
    new DescribeSecurityGroupsCommand({
      Filters: [{ Name: 'group-name', Values: [template.security_group_name] }]
    })
  );
  if (resp.SecurityGroups && resp.SecurityGroups.length) {
    log('Using existing security group', resp.SecurityGroups[0].GroupId);
    return resp.SecurityGroups[0].GroupId;
  }
  const create = await ec2.send(
    new CreateSecurityGroupCommand({
      Description: 'factorio-server',
      GroupName: template.security_group_name
    })
  );
  const sgId = create.GroupId;
  log('Created security group', sgId);
  if (template.ingress_ports && template.ingress_ports.length) {
    log('Authorizing ingress ports', template.ingress_ports.join(','));
    await ec2.send(
      new AuthorizeSecurityGroupIngressCommand({
        GroupId: sgId,
        IpProtocol: 'udp',
        FromPort: Math.min(...template.ingress_ports),
        ToPort: Math.max(...template.ingress_ports),
        CidrIp: '0.0.0.0/0'
      })
    );
  }
  if (template.egress_ports && template.egress_ports.length) {
    log('Authorizing egress traffic');
    await ec2.send(
      new AuthorizeSecurityGroupEgressCommand({
        GroupId: sgId,
        IpPermissions: [
          {
            IpProtocol: '-1',
            IpRanges: [{ CidrIp: '0.0.0.0/0' }]
          }
        ]
      })
    );
  }
  return sgId;
}

async function launchInstance(sgId, saveLabel) {
  log('Launching EC2 instance');
  const tags = Object.entries(template.tags).map(([Key, Value]) => ({ Key, Value }));
  if (saveLabel) {
    tags.push({ Key: 'SaveName', Value: saveLabel });
  }
  const tagSpecifications = [{
    ResourceType: 'instance',
    Tags: tags
  }];
  const resp = await ec2.send(new RunInstancesCommand({
    ImageId: template.ami,
    InstanceType: template.instance_type,
    KeyName: template.key_name,
    SecurityGroupIds: [sgId],
    TagSpecifications: tagSpecifications,
    MinCount: 1,
    MaxCount: 1
  }));
  log('Instance launched', resp.Instances[0].InstanceId);
  return resp.Instances[0].InstanceId;
}

async function waitForInstance(id) {
  log('Waiting for instance', id, 'to become ready');
  await waitUntilInstanceRunning({ client: ec2, maxWaitTime: 300 }, { InstanceIds: [id] });
  const desc = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [id] }));
  const ip = desc.Reservations[0].Instances[0].PublicIpAddress;
  log('Instance ready with IP', ip);
  return ip;
}

function waitForPing(ip) {
  log('Waiting for ping on', ip);
  return new Promise(resolve => {
    const check = () => {
      cp.exec(`ping -c 1 ${ip}`, err => {
        if (!err) return resolve();
        setTimeout(check, 2000);
      });
    };
    check();
  });
}

function connectSSH(ip, attempts = 10) {
  return new Promise(async (resolve, reject) => {
    const key = process.env.SSH_KEY_PATH;
    if (!key) return reject(new Error('SSH_KEY_PATH not set'));
    await waitForPing(ip);
    log('Connecting via SSH to', ip);
    const tryConnect = n => {
      const ssh = new SSHClient();
      ssh
        .on('ready', () => resolve(ssh))
        .on('error', err => {
          log('SSH connection error', err.message);
          ssh.end();
          if (n <= 1) return reject(err);
          setTimeout(() => tryConnect(n - 1), 2000);
        })
        .connect({
          host: ip,
          username: 'ec2-user',
          privateKey: fs.readFileSync(key),
        });
    };
    tryConnect(attempts);
  });
}

async function sshAndSetup(ip, backupFile, version) {
  log(
    'Setting up instance',
    ip,
    backupFile ? 'with backup ' + backupFile : '',
    version ? 'version ' + version : ''
  );
  const ssh = await connectSSH(ip);
  return new Promise((resolve, reject) => {
    const baseImage = process.env.DOCKER_IMAGE || 'factoriotools/factorio:latest';
    const lastColon = baseImage.lastIndexOf(':');
    const repo = lastColon === -1 ? baseImage : baseImage.slice(0, lastColon);
    const defaultTag = lastColon === -1 ? 'latest' : baseImage.slice(lastColon + 1);
    const image = `${repo}:${version || defaultTag}`;
    const ports = (template.ingress_ports || [])
      .map(p => `-p ${p}:${p}/udp`)
      .join(' ');
    const cmds = [
      'sudo yum install -y docker',
      'sudo service docker start',
      'sudo mkdir -p /opt/factorio'
    ];
    if (backupFile) {
      const regionFlag = process.env.AWS_REGION ? ` --region ${process.env.AWS_REGION}` : '';
      const creds = `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY}`;
      cmds.push(
        `${creds} aws s3 cp s3://${process.env.BACKUP_BUCKET}/${backupFile}${regionFlag} - | sudo tar xj -C /opt`
      );
    }
    cmds.push(
      `sudo docker run -d --name factorio --restart unless-stopped --pull always ${ports} -v /opt/factorio:/factorio ${image}`
    );
    const cmd = cmds.join(' && ');
    ssh.exec(cmd, (err, stream) => {
      if (err) {
        ssh.end();
        return reject(err);
      }
      let out = '';
      let exitCode = 0;
      stream.on('data', d => {
        out += d.toString();
      });
      stream.stderr.on('data', d => {
        out += d.toString();
      });
      stream.on('exit', code => {
        exitCode = code;
      });
      stream.on('close', () => {
        log(out.trim());
        ssh.end();
        if (exitCode === 0) {
          resolve();
        } else {
          reject(new Error(`Remote setup failed with code ${exitCode}`));
        }
      });
    });
  });
}

async function sshExec(ip, command) {
  log('sshExec', ip, command);
  const ssh = await connectSSH(ip);
  return new Promise((resolve, reject) => {
    let out = '';
    let exitCode = 0;
    ssh.exec(command, (err, stream) => {
      if (err) {
        ssh.end();
        return reject(err);
      }
      stream.on('data', d => {
        out += d.toString();
      });
      stream.stderr.on('data', d => {
        out += d.toString();
      });
      stream.on('exit', code => {
        exitCode = code;
      });
      stream.on('close', () => {
        log(out.trim());
        ssh.end();
        if (exitCode === 0) {
          resolve(out.trim());
        } else {
          reject(new Error(`Remote command failed with code ${exitCode}`));
        }
      });
    });
  });
}

async function listBackups() {
  await ensureBucketRegion();
  log('Listing backups from', process.env.BACKUP_BUCKET, 'in', awsConfig.region);
  try {
    const resp = await s3.send(
      new ListObjectsV2Command({ Bucket: process.env.BACKUP_BUCKET })
    );
    const list = resp.Contents || [];
    return list.filter(o => !o.Key.endsWith('.json'));
  } catch (err) {
    if (err.Code === 'PermanentRedirect') {
      const region = err.BucketRegion || err.Region;
      if (region) {
        awsConfig.region = region;
        log('S3 redirect, switching region to', region);
      } else {
        const tmp = new S3Client({ ...awsConfig, region: 'us-east-1' });
        const r = await tmp.send(
          new GetBucketLocationCommand({ Bucket: process.env.BACKUP_BUCKET })
        );
        awsConfig.region = r.LocationConstraint || 'us-east-1';
        log('Fetched bucket region', awsConfig.region);
      }
      s3 = new S3Client(awsConfig);
      const resp = await s3.send(
        new ListObjectsV2Command({ Bucket: process.env.BACKUP_BUCKET })
      );
      const list = resp.Contents || [];
      return list.filter(o => !o.Key.endsWith('.json'));
    }
    throw err;
  }
}

function flattenMetadata(obj, prefix = '') {
  const rows = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') {
      rows.push(...flattenMetadata(v, key));
    } else {
      rows.push([key, String(v)]);
    }
  }
  return rows;
}

function formatValue(val) {
  return String(val);
}

function formatMetadata(metadata) {
  if (!metadata || Object.keys(metadata).length === 0) {
    return undefined;
  }
  const lines = flattenMetadata(metadata).map(
    ([k, v]) => `${k}: ${formatValue(v)}`
  );
  return '```\n' + lines.join('\n') + '\n```';
}

function currentDateString() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}.${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

function backupFilename(name) {
  return `${name}.${currentDateString()}.tar.bz2`;
}

function backupCommands(name) {
  const file = backupFilename(name);
  const jsonFile = `${name}.${currentDateString()}.json`;
  const regionFlag = process.env.AWS_REGION ? ` --region ${process.env.AWS_REGION}` : '';
  const creds = `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY}`;
  log('Backup command for', name);
  return (
    `sudo docker stop factorio && ` +
    `sudo rm -rf /tmp/${file} &&` +
    `sudo tar cjf /tmp/${file} -C /opt factorio &&` +
    `${creds} aws s3 cp /opt/factorio/player-data.json s3://${process.env.BACKUP_BUCKET}/${jsonFile}${regionFlag} && ` +
    `${creds} aws s3 cp /tmp/${file} s3://${process.env.BACKUP_BUCKET}/${file}${regionFlag} && ` +
    `sudo rm /tmp/${file} && sudo docker start factorio`
  );
}

function parseBackupKey(key) {
  const m = key.match(/^(.*)\.(\d{4}\.\d{2}\.\d{2}(?:\.\d{2}\.\d{2})?)\.tar\.bz2$/);
  if (!m) return null;
  return { name: m[1], date: m[2] };
}

async function listBackupNames() {
  log('Listing backup names');
  const objects = await listBackups();
  const names = new Set();
  for (const o of objects) {
    const p = parseBackupKey(o.Key);
    if (p) names.add(p.name);
  }
  return Array.from(names);
}

async function getLatestBackupFile(name) {
  log('Fetching latest backup for', name);
  const objects = await listBackups();
  const filtered = objects
    .map(o => ({ meta: parseBackupKey(o.Key), obj: o }))
    .filter(x => x.meta && x.meta.name === name)
    .sort((a, b) => new Date(b.obj.LastModified) - new Date(a.obj.LastModified));
  return filtered.length ? filtered[0].obj.Key : null;
}

async function getBackupJson(id) {
  await ensureBucketRegion();
  const key = `${id}.json`;
  log('Fetching backup json', key);
  try {
    const resp = await s3.send(
      new GetObjectCommand({ Bucket: process.env.BACKUP_BUCKET, Key: key })
    );
    const text = await streamToString(resp.Body);
    return JSON.parse(text);
  } catch (e) {
    log('Failed to fetch backup json', e.message);
    return null;
  }
}

function formatBackupTree(objects) {
  const map = new Map();
  for (const o of objects) {
    const p = parseBackupKey(o.Key);
    if (!p) continue;
    if (!map.has(p.name)) map.set(p.name, []);
    map.get(p.name).push({ date: p.date, size: o.Size });
  }
  const lines = [];
  for (const [name, list] of map.entries()) {
    lines.push(name);
    list.sort((a, b) => (a.date < b.date ? 1 : -1));
    for (const item of list) {
      const mb = (item.size / 1024 / 1024).toFixed(1);
      lines.push(`  - ${item.date} (${mb} MB)`);
    }
  }
  return '```\n' + lines.join('\n') + '\n```';
}

  async function getSystemStats(ip) {
  try {
    log('Gathering system stats from', ip);
    const load = await sshExec(ip, 'cat /proc/loadavg');
    const mem = await sshExec(
      ip,
      `free -m | awk '/Mem:/ {print $3"/"$2" MB"}'`
    );
    const disk = await sshExec(
      ip,
      `(df -h /opt/factorio 2>/dev/null || df -h / 2>/dev/null) | tail -1 | awk '{print $3"/"$2" used"}'`
    );
    const result = { load: load.split(' ').slice(0,3).join(' '), memory: mem.trim(), disk: disk.trim() };
    log('Stats', result);
    return result;
  } catch (e) {
    log('Failed to get stats', e.message);
    return {};
  }
  }

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

  function splitMessage(text, limit = 2000) {
  if (text.length <= limit) return [text];
  let wrap = false;
  if (text.startsWith('```') && text.endsWith('```')) {
    wrap = true;
    text = text.slice(3, -3).trim();
    limit -= 6;
  }
  const lines = text.split('\n');
  const chunks = [];
  let buf = '';
  for (const line of lines) {
    if ((buf + line + '\n').length > limit) {
      chunks.push(buf.trimEnd());
      buf = '';
    }
    buf += line + '\n';
  }
  if (buf) chunks.push(buf.trimEnd());
  return wrap ? chunks.map(c => '```\n' + c + '\n```') : chunks;
}

async function sendDiscordMessage(interaction, method, content, options = {}) {
  if (typeof content !== 'string') {
    await interaction[method](content);
    return;
  }
  const parts = splitMessage(content);
  log('Sending', parts.length, 'message part(s) via', method);
  for (let i = 0; i < parts.length; i++) {
    const payload = { ...options, content: parts[i] };
    if (i === 0) {
      await interaction[method](payload);
    } else {
      await interaction.followUp(payload);
    }
  }
}

function sendReply(interaction, content, options) {
  let method = 'reply';
  if (interaction.deferred && !interaction.replied) {
    method = 'editReply';
  } else if (interaction.replied) {
    method = 'followUp';
  }
  log('sendReply using', method);
  return sendDiscordMessage(interaction, method, content, options);
}

const sendFollowUp = (interaction, content, options) => {
  log('sendFollowUp');
  return sendDiscordMessage(interaction, 'followUp', content, options);
};

module.exports = {
  ec2,
  s3,
  template,
  state,
  findRunningInstance,
  ensureSecurityGroup,
  launchInstance,
  waitForInstance,
  sshExec,
  sshAndSetup,
  backupCommands,
  listBackups,
  listBackupNames,
  getLatestBackupFile,
  getBackupJson,
  parseBackupKey,
  formatBackupTree,
  formatMetadata,
  getSystemStats,
  CreateTagsCommand,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
  sendReply,
  sendFollowUp,
  log
};
