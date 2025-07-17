const { SlashCommandBuilder } = require('discord.js');
const { listBackups, formatBackupTree, sendReply } = require('../lib');

module.exports = {
  data: new SlashCommandBuilder().setName('list').setDescription('List available backups'),
  async execute(interaction) {
    require('../lib').debug('list command invoked');
    await interaction.deferReply();
    const objects = await listBackups();
    const out = formatBackupTree(objects);
    await sendReply(interaction, out || 'No backups');
    require('../lib').debug('list command completed');
  }
};
