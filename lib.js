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
  GetBucketLocationCommand
} = require('@aws-sdk/client-s3');
const { Client: SSHClient } = require('ssh2');

function debug(...args) {
  if (process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true') {
    console.log(...args);
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
      debug('Detected bucket region', awsConfig.region);
    } catch {
      // fall back to default region
    }
  }
}

async function findRunningInstance() {
  const filters = [
    { Name: 'instance-state-name', Values: ['pending', 'running'] }
  ];
  for (const [k, v] of Object.entries(template.tags)) {
    filters.push({ Name: `tag:${k}`, Values: [v] });
  }
  const resp = await ec2.send(new DescribeInstancesCommand({ Filters: filters }));
  for (const res of resp.Reservations || []) {
    for (const inst of res.Instances || []) {
      return inst;
    }
  }
  return null;
}

async function ensureSecurityGroup() {
  const resp = await ec2.send(
    new DescribeSecurityGroupsCommand({
      Filters: [{ Name: 'group-name', Values: [template.security_group_name] }]
    })
  );
  if (resp.SecurityGroups && resp.SecurityGroups.length) {
    return resp.SecurityGroups[0].GroupId;
  }
  const create = await ec2.send(
    new CreateSecurityGroupCommand({
      Description: 'factorio-server',
      GroupName: template.security_group_name
    })
  );
  const sgId = create.GroupId;
  if (template.ingress_ports && template.ingress_ports.length) {
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
  return resp.Instances[0].InstanceId;
}

async function waitForInstance(id) {
  await waitUntilInstanceRunning({ client: ec2, maxWaitTime: 300 }, { InstanceIds: [id] });
  const desc = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [id] }));
  return desc.Reservations[0].Instances[0].PublicIpAddress;
}

function waitForPing(ip) {
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
    const tryConnect = n => {
      const ssh = new SSHClient();
      ssh
        .on('ready', () => resolve(ssh))
        .on('error', err => {
          debug(err);
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

async function sshAndSetup(ip, backupFile) {
  const ssh = await connectSSH(ip);
  return new Promise((resolve, reject) => {
    const image = process.env.DOCKER_IMAGE || 'factoriotools/factorio:latest';
    const ports = (template.ingress_ports || [])
      .map(p => `-p ${p}:${p}/udp`)
      .join(' ');
    const cmds = [
      'sudo yum install -y docker',
      'sudo service docker start',
      'sudo mkdir -p /opt/factorio'
    ];
    if (backupFile) {
      const header = process.env.BACKUP_DOWNLOAD_AUTH_HEADER || '';
      const base = process.env.BACKUP_DOWNLOAD_URL || '';
      cmds.push(
        `curl -L ${header ? `-H \"${header}\"` : ''} \"${base}/${backupFile}\" | tar xj -C /opt/factorio`
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
      stream.on('close', () => {
        ssh.end();
        resolve();
      });
    });
  });
}

async function sshExec(ip, command) {
  debug('sshExec', ip, command);
  const ssh = await connectSSH(ip);
  return new Promise((resolve, reject) => {
    let out = '';
    ssh.exec(command, (err, stream) => {
      if (err) {
        ssh.end();
        return reject(err);
      }
      stream.on('data', d => { out += d.toString(); });
      stream.stderr.on('data', d => { out += d.toString(); });
      stream.on('close', () => {
        ssh.end();
        resolve(out.trim());
      });
    });
  });
}

async function listBackups() {
  await ensureBucketRegion();
  debug('Listing backups from', process.env.BACKUP_BUCKET, 'in', awsConfig.region);
  try {
    const resp = await s3.send(
      new ListObjectsV2Command({ Bucket: process.env.BACKUP_BUCKET })
    );
    return resp.Contents || [];
  } catch (err) {
    if (err.Code === 'PermanentRedirect') {
      const region = err.BucketRegion || err.Region;
      if (region) {
        awsConfig.region = region;
        debug('S3 redirect, switching region to', region);
      } else {
        const tmp = new S3Client({ ...awsConfig, region: 'us-east-1' });
        const r = await tmp.send(
          new GetBucketLocationCommand({ Bucket: process.env.BACKUP_BUCKET })
        );
        awsConfig.region = r.LocationConstraint || 'us-east-1';
        debug('Fetched bucket region', awsConfig.region);
      }
      s3 = new S3Client(awsConfig);
      const resp = await s3.send(
        new ListObjectsV2Command({ Bucket: process.env.BACKUP_BUCKET })
      );
      return resp.Contents || [];
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
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

function backupFilename(name) {
  return `${name}.${currentDateString()}.tar.bz2`;
}

function backupCommands(name) {
  const file = backupFilename(name);
  const jsonFile = `${name}.${currentDateString()}.json`;
  const uploadBase = process.env.BACKUP_UPLOAD_URL || '';
  const header = process.env.BACKUP_UPLOAD_AUTH_HEADER || '';
  const regionFlag = process.env.AWS_REGION ? ` --region ${process.env.AWS_REGION}` : '';
  return (
    `sudo docker stop factorio && ` +
    `tar cjf /tmp/${file} -C /opt factorio && ` +
    `aws s3 cp /opt/factorio/player-data.json s3://${process.env.BACKUP_BUCKET}/${jsonFile}${regionFlag} && ` +
    `curl -H \"${header}\" -T /tmp/${file} \"${uploadBase}/${file}\" && ` +
    `rm /tmp/${file} && sudo docker start factorio`
  );
}

function parseBackupKey(key) {
  const m = key.match(/^(.*)\.(\d{4}\.\d{2}\.\d{2})\.tar\.bz2$/);
  if (!m) return null;
  return { name: m[1], date: m[2] };
}

async function listBackupNames() {
  const objects = await listBackups();
  const names = new Set();
  for (const o of objects) {
    const p = parseBackupKey(o.Key);
    if (p) names.add(p.name);
  }
  return Array.from(names);
}

async function getLatestBackupFile(name) {
  const objects = await listBackups();
  const filtered = objects
    .map(o => ({ meta: parseBackupKey(o.Key), obj: o }))
    .filter(x => x.meta && x.meta.name === name)
    .sort((a, b) => new Date(b.obj.LastModified) - new Date(a.obj.LastModified));
  return filtered.length ? filtered[0].obj.Key : null;
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
    const load = await sshExec(ip, 'cat /proc/loadavg');
    const mem = await sshExec(
      ip,
      `free -m | awk '/Mem:/ {print $3"/"$2" MB"}'`
    );
    const disk = await sshExec(
      ip,
      `(df -h /opt/factorio 2>/dev/null || df -h / 2>/dev/null) | tail -1 | awk '{print $3"/"$2" used"}'`
    );
    return { load: load.split(' ').slice(0,3).join(' '), memory: mem.trim(), disk: disk.trim() };
  } catch (e) {
    return {};
  }
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
  return sendDiscordMessage(interaction, method, content, options);
}

const sendFollowUp = (interaction, content, options) =>
  sendDiscordMessage(interaction, 'followUp', content, options);

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
  formatBackupTree,
  formatMetadata,
  getSystemStats,
  CreateTagsCommand,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
  sendReply,
  sendFollowUp,
  debug
};
