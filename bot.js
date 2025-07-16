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
let backupName = null;

const bot = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder().setName('start').setDescription('Start the Factorio server'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop the Factorio server'),
  new SlashCommandBuilder().setName('list').setDescription('List available backups'),
  new SlashCommandBuilder().setName('status').setDescription('Get server status'),
  new SlashCommandBuilder()
    .setName('name')
    .setDescription('Set backup name')
    .addStringOption(option =>
      option.setName('backup').setDescription('Backup name').setAutocomplete(true).setRequired(true)
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
    { Name: 'instance-state-name', Values: ['pending', 'running'] },
    { Name: 'availability-zone', Values: [template.availability_zone] }
  ];
  for (const [k, v] of Object.entries(template.tags)) {
    filters.push({ Name: `tag:${k}`, Values: [v] });
  }
  const resp = await ec2.send(new DescribeInstancesCommand({ Filters: filters }));
  for (const res of resp.Reservations || []) {
    for (const inst of res.Instances || []) {
      return inst.InstanceId;
    }
  }
  return null;
}

async function createSecurityGroup() {
  const resp = await ec2.send(new CreateSecurityGroupCommand({
    Description: 'factorio-server',
    GroupName: template.security_group_name
  }));
  const sgId = resp.GroupId;
  if (template.ingress_ports && template.ingress_ports.length) {
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({
      GroupId: sgId,
      IpProtocol: 'udp',
      FromPort: Math.min(...template.ingress_ports),
      ToPort: Math.max(...template.ingress_ports),
      CidrIp: '0.0.0.0/0'
    }));
  }
  if (template.egress_ports && template.egress_ports.length) {
    await ec2.send(new AuthorizeSecurityGroupEgressCommand({
      GroupId: sgId,
      IpPermissions: [{
        IpProtocol: '-1',
        IpRanges: [{ CidrIp: '0.0.0.0/0' }]
      }]
    }));
  }
  return sgId;
}

async function launchInstance(sgId) {
  const tagSpecifications = [{
    ResourceType: 'instance',
    Tags: Object.entries(template.tags).map(([Key, Value]) => ({ Key, Value }))
  }];
  const resp = await ec2.send(new RunInstancesCommand({
    ImageId: template.ami,
    InstanceType: template.instance_type,
    KeyName: template.key_name,
    SecurityGroupIds: [sgId],
    TagSpecifications: tagSpecifications,
    MinCount: 1,
    MaxCount: 1,
    Placement: { AvailabilityZone: template.availability_zone }
  }));
  return resp.Instances[0].InstanceId;
}

async function waitForInstance(id) {
  await waitUntilInstanceRunning({ client: ec2, maxWaitTime: 300 }, { InstanceIds: [id] });
  const desc = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [id] }));
  return desc.Reservations[0].Instances[0].PublicIpAddress;
}

function sshAndSetup(ip) {
  return new Promise((resolve, reject) => {
    const key = process.env.SSH_KEY_PATH;
    if (!key) return reject(new Error('SSH_KEY_PATH not set'));
    const ssh = new SSHClient();
    ssh.on('ready', () => {
      ssh.exec('sudo yum install -y docker && sudo service docker start', (err, stream) => {
        if (err) {
          ssh.end();
          return reject(err);
        }
        stream.on('close', () => {
          ssh.end();
          resolve();
        });
      });
    }).on('error', reject).connect({ host: ip, username: 'ec2-user', privateKey: fs.readFileSync(key) });
  });
}

async function listBackups() {
  const resp = await s3.send(new ListObjectsV2Command({ Bucket: process.env.BACKUP_BUCKET }));
  return (resp.Contents || []).map(o => o.Key);
}

bot.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.channelId !== channelId) return;

  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'name') {
      const focused = interaction.options.getFocused();
      const backups = await listBackups();
      const filtered = backups.filter(b => b.startsWith(focused)).slice(0, 25);
      await interaction.respond(filtered.map(b => ({ name: b, value: b })));
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
      await interaction.followUp('Launching EC2 instance...');
      const sgId = await createSecurityGroup();
      instanceId = await launchInstance(sgId);
      const ip = await waitForInstance(instanceId);
      await interaction.followUp(`Instance launched with IP ${ip}, installing docker...`);
      await sshAndSetup(ip);
      await interaction.followUp(`Factorio server running at ${ip}`);
    } else if (interaction.commandName === 'stop') {
      if (!instanceId) {
        await interaction.reply('No running server');
        return;
      }
      await interaction.reply('Stopping server...');
      await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
      instanceId = null;
      await interaction.followUp('Server terminated');
    } else if (interaction.commandName === 'list') {
      const backups = await listBackups();
      await interaction.reply('Available backups: ' + backups.join(', '));
    } else if (interaction.commandName === 'status') {
      const inst = await findRunningInstance();
      if (inst) {
        await interaction.reply(`Server running: ${inst}`);
      } else {
        await interaction.reply('No running servers');
      }
    } else if (interaction.commandName === 'name') {
      backupName = interaction.options.getString('backup');
      await interaction.reply(`Backup name set to ${backupName}`);
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
