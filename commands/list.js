const { SlashCommandBuilder } = require('discord.js');
const { listBackups, formatBackupTree } = require('../lib');

module.exports = {
  data: new SlashCommandBuilder().setName('list').setDescription('List available backups'),
  async execute(interaction) {
    const objects = await listBackups();
    const out = formatBackupTree(objects);
    await interaction.reply(out || 'No backups');
  }
};
