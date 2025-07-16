require('dotenv').config();
const fs = require('fs');
const { Client, GatewayIntentBits } = require('discord.js');
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
let instanceId = null;
let backupName = null;

const bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

bot.once('ready', () => {
  console.log(`Logged in as ${bot.user.tag}`);
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

bot.on('messageCreate', async (msg) => {
  if (msg.channel.id !== channelId) return;
  if (!msg.content.startsWith('!')) return;
  const args = msg.content.slice(1).split(/\s+/);
  const command = args.shift().toLowerCase();
  try {
    if (command === 'start') {
      await msg.channel.send('Checking for existing server...');
      const existing = await findRunningInstance();
      if (existing) {
        await msg.channel.send('Server already running');
        return;
      }
      await msg.channel.send('Launching EC2 instance...');
      const sgId = await createSecurityGroup();
      instanceId = await launchInstance(sgId);
      const ip = await waitForInstance(instanceId);
      await msg.channel.send(`Instance launched with IP ${ip}, installing docker...`);
      await sshAndSetup(ip);
      await msg.channel.send(`Factorio server running at ${ip}`);
    } else if (command === 'stop') {
      if (!instanceId) return;
      await msg.channel.send('Stopping server...');
      await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
      instanceId = null;
      await msg.channel.send('Server terminated');
    } else if (command === 'list') {
      const backups = await listBackups();
      await msg.channel.send('Available backups: ' + backups.join(', '));
    } else if (command === 'status') {
      const inst = await findRunningInstance();
      if (inst) {
        await msg.channel.send(`Server running: ${inst}`);
      } else {
        await msg.channel.send('No running servers');
      }
    } else if (command === 'name') {
      if (instanceId && args[0]) {
        backupName = args[0];
        await msg.channel.send(`Backup name set to ${backupName}`);
      }
    }
  } catch (err) {
    console.error(err);
    await msg.channel.send('Error: ' + err.message);
  }
});

bot.login(process.env.DISCORD_TOKEN);
