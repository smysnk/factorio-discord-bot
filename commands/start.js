const { SlashCommandBuilder } = require('discord.js');
const lib = require('../lib');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('start')
    .setDescription('Start the Factorio server')
    .addStringOption(o =>
      o.setName('name').setDescription('Optional save label').setRequired(false).setAutocomplete(true)
    ),
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    const names = await lib.listBackupNames();
    const filtered = names.filter(n => n.startsWith(focused)).slice(0, 25);
    await interaction.respond(filtered.map(n => ({ name: n, value: n })));
  },
  async execute(interaction) {
    await interaction.deferReply();
    await lib.sendReply(interaction, 'Checking for existing server...');
    const existing = await lib.findRunningInstance();
    if (existing) {
      await lib.sendFollowUp(interaction, 'Server already running');
      return;
    }
    const saveLabel = interaction.options.getString('name');
    await lib.sendFollowUp(interaction, 'Launching EC2 instance...');
    const sgId = await lib.ensureSecurityGroup();
    const id = await lib.launchInstance(sgId, saveLabel);
    lib.state.instanceId = id;
    const ip = await lib.waitForInstance(id);
    const backupFile = saveLabel ? await lib.getLatestBackupFile(saveLabel) : null;
    await lib.sendFollowUp(
      interaction,
      `Instance launched with IP ${ip}${backupFile ? ', restoring backup...' : ', installing docker...'}`
    );
    await lib.sshAndSetup(ip, backupFile);
    await lib.sendFollowUp(interaction, `Factorio server running at ${ip}`);
  }
};
