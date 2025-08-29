import { ChatInputCommandInteraction } from 'discord.js';
import { ProviderStrategy } from './ProviderStrategy';
import { sshExec, sshAndSetup, sendReply, sendFollowUp, rconSave, backupCommands, getSystemStats, formatMetadata, getLatestBackupFile, log } from '../lib';

export class BareMetalProviderStrategy implements ProviderStrategy {
  constructor(private ip: string) {}

  async start(interaction: ChatInputCommandInteraction, backup?: string | null, version?: string | null): Promise<void> {
    log('bare metal start invoked');
    await sendReply(interaction, `Using existing server at \`${this.ip}\`...`);
    try {
      const running = await sshExec(this.ip, 'sudo docker ps -q -f name=factorio');
      if (running) {
        await sendFollowUp(interaction, 'Server already running');
        return;
      }
    } catch {
      // ignore and attempt setup
    }
    const backupFile = backup
      ? backup.endsWith('.tar.bz2')
        ? backup
        : await getLatestBackupFile(backup)
      : null;
    await sendFollowUp(
      interaction,
      backupFile ? `Restoring backup \`${backup}\`...` : 'Installing docker...'
    );
    await sshAndSetup(this.ip, backupFile, version || undefined);
    await sendFollowUp(interaction, `Factorio server running at \`${this.ip}\``);
  }

  async stop(interaction: ChatInputCommandInteraction): Promise<void> {
    const name = `backup-${Date.now()}`;
    await sendReply(interaction, `Stopping server and saving as ${name}...`);
    await rconSave(this.ip);
    await sshExec(this.ip, `${backupCommands(name)} && sudo docker stop factorio`);
    await sendFollowUp(interaction, 'Server stopped');
  }

  async status(interaction: ChatInputCommandInteraction): Promise<void> {
    const stats = await getSystemStats(this.ip);
    const meta: Record<string, string | undefined> = {
      'IP Address': this.ip,
      Load: stats.load,
      Memory: stats.memory,
      'Disk factorio data': stats.disk,
    };
    const table = formatMetadata(meta);
    await sendReply(interaction, table || 'No data');
  }

  async save(interaction: ChatInputCommandInteraction, name?: string | null): Promise<void> {
    const saveName = name || `backup-${Date.now()}`;
    await sendReply(interaction, `Saving as \`${saveName}\`...`);
    await sshExec(this.ip, backupCommands(saveName));
    await sendFollowUp(interaction, 'Save complete');
  }
}
