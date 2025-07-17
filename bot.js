require('dotenv').config();
const fs = require('fs');
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  Events
} = require('discord.js');
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
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { Client: SSHClient } = require('ssh2');

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
const s3 = new S3Client(awsConfig);

const channelId = process.env.DISCORD_CHANNEL_ID;
const guildId = process.env.DISCORD_GUILD_ID;
let instanceId = null;

const bot = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('Start the Factorio server')
    .addStringOption(o =>
      o
        .setName('name')
        .setDescription('Optional save label')
        .setRequired(false)
        .setAutocomplete(true)
    ),
  new SlashCommandBuilder().setName('stop').setDescription('Stop the Factorio server'),
  new SlashCommandBuilder().setName('list').setDescription('List available backups'),
  new SlashCommandBuilder().setName('status').setDescription('Get server status'),
  new SlashCommandBuilder()
    .setName('save')
    .setDescription('Save the server with a name')
    .addStringOption(option =>
      option.setName('name').setDescription('Save name').setAutocomplete(true).setRequired(true)
    )
];

bot.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${bot.user.tag}`);
  const data = commands.map(c => c.toJSON());
  if (guildId) {
    await bot.application.commands.set(data, guildId);
  } else {
    await bot.application.commands.set(data);
  }
});

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

function sshAndSetup(ip, backupFile) {
  return new Promise((resolve, reject) => {
    const key = process.env.SSH_KEY_PATH;
    if (!key) return reject(new Error('SSH_KEY_PATH not set'));
    const ssh = new SSHClient();
    ssh
      .on('ready', () => {
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
      })
      .on('error', reject)
      .connect({
        host: ip,
        username: 'ec2-user',
        privateKey: fs.readFileSync(key),
        hostVerifier: () => true
      });
  });
}

function sshExec(ip, command) {
  return new Promise((resolve, reject) => {
    const key = process.env.SSH_KEY_PATH;
    if (!key) return reject(new Error('SSH_KEY_PATH not set'));
    const ssh = new SSHClient();
    let out = '';
    ssh.on('ready', () => {
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
    }).on('error', reject).connect({
      host: ip,
      username: 'ec2-user',
      privateKey: fs.readFileSync(key),
      hostVerifier: () => true
    });
  });
}

async function listBackups() {
  const resp = await s3.send(
    new ListObjectsV2Command({ Bucket: process.env.BACKUP_BUCKET })
  );
  return resp.Contents || [];
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
  const rows = flattenMetadata(metadata).map(([k, v]) => [k, formatValue(v)]);
  const headers = ['Key', 'Value'];
  const col1 = Math.max(headers[0].length, ...rows.map(r => r[0].length));
  const col2 = Math.max(headers[1].length, ...rows.map(r => r[1].length));
  const sep = `+${'-'.repeat(col1 + 2)}+${'-'.repeat(col2 + 2)}+`;
  const lines = [
    sep,
    `| ${headers[0].padEnd(col1)} | ${headers[1].padEnd(col2)} |`,
    sep,
    ...rows.map(r => `| ${r[0].padEnd(col1)} | ${r[1].padEnd(col2)} |`),
    sep,
  ];
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
  return (
    `sudo docker stop factorio && ` +
    `tar cjf /tmp/${file} -C /opt factorio && ` +
    `aws s3 cp /opt/factorio/player-data.json s3://${process.env.BACKUP_BUCKET}/${jsonFile} && ` +
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
    const mem = await sshExec(ip, 'free -m | awk \'/Mem:/ {print $3"/"$2" MB"}\'');
    const disk = await sshExec(ip, 'df -h /opt/factorio | tail -1 | awk \'{print $3"/"$2" used"}\'');
    return { load: load.split(' ').slice(0,3).join(' '), memory: mem.trim(), disk: disk.trim() };
  } catch (e) {
    return {};
  }
}

bot.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.channelId !== channelId) return;

  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'save') {
      const focused = interaction.options.getFocused();
      const backups = await listBackups();
      const filtered = backups
        .map(o => o.Key)
        .filter(b => b.startsWith(focused))
        .slice(0, 25);
      await interaction.respond(filtered.map(b => ({ name: b, value: b })));
    } else if (interaction.commandName === 'start') {
      const focused = interaction.options.getFocused();
      const names = await listBackupNames();
      const filtered = names.filter(n => n.startsWith(focused)).slice(0, 25);
      await interaction.respond(filtered.map(n => ({ name: n, value: n })));
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'start') {
      await interaction.reply('Checking for existing server...');
      const existing = await findRunningInstance();
      if (existing) {
        await interaction.followUp('Server already running');
        return;
      }
      const saveLabel = interaction.options.getString('name');
      await interaction.followUp('Launching EC2 instance...');
      const sgId = await ensureSecurityGroup();
      instanceId = await launchInstance(sgId, saveLabel);
      const ip = await waitForInstance(instanceId);
      const backupFile = saveLabel ? await getLatestBackupFile(saveLabel) : null;
      await interaction.followUp(
        `Instance launched with IP ${ip}${backupFile ? ', restoring backup...' : ', installing docker...'}`
      );
      await sshAndSetup(ip, backupFile);
      await interaction.followUp(`Factorio server running at ${ip}`);
    } else if (interaction.commandName === 'stop') {
      let inst = instanceId ? await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] })) : null;
      inst = inst ? inst.Reservations[0].Instances[0] : await findRunningInstance();
      if (!inst) {
        await interaction.reply('No running server');
        return;
      }
      const ip = inst.PublicIpAddress;
      const tag = (inst.Tags || []).find(t => t.Key === 'SaveName');
      const name = tag ? tag.Value : `backup-${Date.now()}`;
      await interaction.reply(`Stopping server and saving as ${name}...`);
      if (ip) {
        await sshExec(ip, backupCommands(name));
      }
      await ec2.send(new TerminateInstancesCommand({ InstanceIds: [inst.InstanceId] }));
      instanceId = null;
      await interaction.followUp('Server terminated');
    } else if (interaction.commandName === 'list') {
      const objects = await listBackups();
      const out = formatBackupTree(objects);
      await interaction.reply(out || 'No backups');
    } else if (interaction.commandName === 'status') {
      const inst = await findRunningInstance();
      if (inst) {
        const ip = inst.PublicIpAddress;
        const stats = ip ? await getSystemStats(ip) : {};
        const meta = {
          'Instance ID': inst.InstanceId,
          'Instance Type': inst.InstanceType,
          'Availability Zone': inst.Placement.AvailabilityZone,
          'IP Address': ip,
          'Security Groups': inst.SecurityGroups.map(g => g.GroupName).join(', '),
          'Open Ports': (template.ingress_ports || []).join(', '),
          Load: stats.load,
          Memory: stats.memory,
          'Disk /opt/factorio': stats.disk
        };
        const table = formatMetadata(meta);
        await interaction.reply(table || 'No data');
      } else {
        await interaction.reply('No running servers');
      }
    } else if (interaction.commandName === 'save') {
      const inst = await findRunningInstance();
      if (!inst) {
        await interaction.reply('No running server');
        return;
      }
      const name = interaction.options.getString('name');
      const ip = inst.PublicIpAddress;
      await ec2.send(
        new CreateTagsCommand({ Resources: [inst.InstanceId], Tags: [{ Key: 'SaveName', Value: name }] })
      );
      await interaction.reply(`Saving as ${name}...`);
      if (ip) {
        await sshExec(ip, backupCommands(name));
      }
      await interaction.followUp('Save complete');
    }
  } catch (err) {
    console.error(err);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: 'Error: ' + err.message, ephemeral: true });
    } else {
      await interaction.reply({ content: 'Error: ' + err.message, ephemeral: true });
    }
  }
});

bot.login(process.env.DISCORD_TOKEN);
