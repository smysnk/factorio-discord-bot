const { SlashCommandBuilder } = require('discord.js');
const { listBackups, formatBackupTree, sendReply, log } = require('../lib');

module.exports = {
  data: new SlashCommandBuilder().setName('list').setDescription('List available backups'),
  async execute(interaction) {
    log('list command invoked');
    await interaction.deferReply();
    const objects = await listBackups();
    const out = formatBackupTree(objects);
    await sendReply(interaction, out || 'No backups');
    log('list command completed');
  }
};
