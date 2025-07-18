const { SlashCommandBuilder } = require('discord.js');
const { listBackups, parseBackupKey, formatMetadata, getBackupJson, sendReply, log } = require('../lib');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('describe')
    .setDescription('Describe a backup')
    .addStringOption(o =>
      o.setName('id').setDescription('Backup name and date').setAutocomplete(true).setRequired(true)
    ),
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    const objects = await listBackups();
    const names = new Set();
    for (const o of objects) {
      const p = parseBackupKey(o.Key);
      if (p) names.add(`${p.name}.${p.date}`);
    }
    const filtered = Array.from(names)
      .filter(n => n.startsWith(focused))
      .slice(0, 25);
    await interaction.respond(filtered.map(n => ({ name: n, value: n })));
  },
  async execute(interaction) {
    log('describe command invoked');
    await interaction.deferReply();
    const id = interaction.options.getString('id');
    const data = await getBackupJson(id);
    const out = formatMetadata(data);
    await sendReply(interaction, out || 'No data');
    log('describe command completed');
  }
};
