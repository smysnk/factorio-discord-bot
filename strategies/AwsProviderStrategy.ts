import { ChatInputCommandInteraction } from 'discord.js';
import { ProviderStrategy } from './ProviderStrategy';
import {
  ec2,
  state,
  template,
  findRunningInstance,
  ensureSecurityGroup,
  launchInstance,
  waitForInstance,
  sshExec,
  sshAndSetup,
  rconSave,
  backupCommands,
  getSystemStats,
  formatMetadata,
  sendReply,
  sendFollowUp,
  parseBackupKey,
  getLatestBackupFile,
  CreateTagsCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
  log
} from '../lib';

export class AwsProviderStrategy implements ProviderStrategy {
  async start(
    interaction: ChatInputCommandInteraction,
    backup?: string | null,
    version?: string | null
  ): Promise<void> {
    log('aws start invoked');
    await sendReply(interaction, 'Checking for existing server...');
    const existing = await findRunningInstance();
    if (existing) {
      await sendFollowUp(interaction, 'Server already running');
      return;
    }
    await sendFollowUp(interaction, 'Launching EC2 instance...');
    const sgId = await ensureSecurityGroup();
    const parsed = backup ? parseBackupKey(backup) : null;
    const saveLabel = parsed ? parsed.name : backup || undefined;
    const id = await launchInstance(sgId, saveLabel);
    state.instanceId = id;
    const ec2Ip = await waitForInstance(id);
    const backupFile = backup
      ? backup.endsWith('.tar.bz2')
        ? backup
        : await getLatestBackupFile(backup)
      : null;
    await sendFollowUp(
      interaction,
      `Instance launched with IP \`${ec2Ip}\`${
        backupFile ? `, restoring backup \`${backup}\`...` : ', installing docker...'
      }`
    );
    const cmds = [
      'sudo yum install -y docker',
      'sudo service docker start',
      'sudo mkdir -p /opt/factorio',
      'sudo dd if=/dev/zero of=/swapfile bs=1M count=2048',
      'sudo chmod 600 /swapfile',
      'sudo mkswap /swapfile',
      'sudo swapon /swapfile',
      'echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab'
    ];
    await sshAndSetup(ec2Ip, backupFile, version || undefined, cmds);
    await sendFollowUp(interaction, `Factorio server running at \`${ec2Ip}\``);
  }

  async stop(interaction: ChatInputCommandInteraction): Promise<void> {
    let inst = state.instanceId
      ? (
          await ec2.send(
            new DescribeInstancesCommand({ InstanceIds: [state.instanceId] })
          )
        ).Reservations[0].Instances[0]
      : await findRunningInstance();
    if (!inst) {
      await sendReply(interaction, 'No running server');
      return;
    }
    const ec2Ip = inst.PublicIpAddress;
    const tag = (inst.Tags || []).find(t => t.Key === 'SaveName');
    const name = tag ? tag.Value : `backup-${Date.now()}`;
    await sendReply(interaction, `Stopping server and saving as ${name}...`);
    if (ec2Ip) {
      await rconSave(ec2Ip);
      await sshExec(ec2Ip, backupCommands(name));
    }
    await ec2.send(new TerminateInstancesCommand({ InstanceIds: [inst.InstanceId] }));
    state.instanceId = null;
    await sendFollowUp(interaction, 'Server terminated');
  }

  async status(interaction: ChatInputCommandInteraction): Promise<void> {
    const inst = await findRunningInstance();
    if (inst) {
      const ec2Ip = inst.PublicIpAddress;
      const stats = ec2Ip ? await getSystemStats(ec2Ip) : {} as any;
      const meta: Record<string, string | undefined> = {
        'Instance ID': inst.InstanceId,
        'Instance Type': inst.InstanceType,
        'Availability Zone': inst.Placement.AvailabilityZone,
        'IP Address': ec2Ip,
        'Security Groups': inst.SecurityGroups.map(g => g.GroupName).join(', '),
        'Open Ports': (template.ingress_ports || []).join(', '),
        Load: (stats as any).load,
        Memory: (stats as any).memory,
        'Disk /opt/factorio': (stats as any).disk,
      };
      const table = formatMetadata(meta);
      await sendReply(interaction, table || 'No data');
    } else {
      await sendReply(interaction, 'No running servers');
    }
  }

  async save(
    interaction: ChatInputCommandInteraction,
    name?: string | null
  ): Promise<void> {
    const inst = await findRunningInstance();
    if (!inst) {
      await sendReply(interaction, 'No running server');
      return;
    }
    const inputName = name;
    const tag = (inst.Tags || []).find(t => t.Key === 'SaveName');
    const saveName = inputName || (tag ? tag.Value : `backup-${Date.now()}`);
    const ec2Ip = inst.PublicIpAddress;
    if (inputName) {
      await ec2.send(
        new CreateTagsCommand({
          Resources: [inst.InstanceId],
          Tags: [{ Key: 'SaveName', Value: inputName }],
        })
      );
    }
    await sendReply(interaction, `Saving as \`${saveName}\`...`);
    if (ec2Ip) {
      await sshExec(ec2Ip, backupCommands(saveName));
    }
    await sendFollowUp(interaction, 'Save complete');
  }
}
