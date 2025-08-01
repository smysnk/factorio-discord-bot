const { SlashCommandBuilder } = require('discord.js');
const lib = require('../lib');
const { log } = lib;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('start')
    .setDescription('Start the Factorio server')
    .addStringOption(o =>
      o
        .setName('name')
        .setDescription('Optional backup key (name.date)')
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption(o =>
      o
        .setName('version')
        .setDescription('Optional Factorio version tag')
        .setRequired(false)
    ),
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    const backups = await lib.listBackups();
    const filtered = backups
      .map(o => o.Key)
      .filter(k => k.startsWith(focused))
      .slice(0, 25);
    await interaction.respond(
      filtered.map(k => {
        const p = lib.parseBackupKey(k);
        const name = p ? `${p.name}.${p.date}` : k;
        return { name, value: k };
      })
    );
  },
  async execute(interaction) {
    log('start command invoked');
    await interaction.deferReply();
    await lib.sendReply(interaction, 'Checking for existing server...');
    const existing = await lib.findRunningInstance();
    if (existing) {
      await lib.sendFollowUp(interaction, 'Server already running');
      return;
    }
    const backup = interaction.options.getString('name');
    const version = interaction.options.getString('version');
    await lib.sendFollowUp(interaction, 'Launching EC2 instance...');
    const sgId = await lib.ensureSecurityGroup();
    const parsed = backup ? lib.parseBackupKey(backup) : null;
    const saveLabel = parsed ? parsed.name : backup;
    const id = await lib.launchInstance(sgId, saveLabel);
    lib.state.instanceId = id;
    const ip = await lib.waitForInstance(id);
    const backupFile = backup
      ? backup.endsWith('.tar.bz2')
        ? backup
        : await lib.getLatestBackupFile(backup)
      : null;
    await lib.sendFollowUp(
      interaction,
      `Instance launched with IP ${ip}${backupFile ? `, restoring backup ${backup}...` : ', installing docker...'}`
    );
    await lib.sshAndSetup(ip, backupFile, version);
    await lib.sendFollowUp(interaction, `Factorio server running at ${ip}`);
    log('start command completed');
  }
};
