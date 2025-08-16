const { SlashCommandBuilder } = require('discord.js');
const {
  ec2,
  findRunningInstance,
  sshExec,
  rconSave,
  backupCommands,
  CreateTagsCommand,
  sendReply,
  sendFollowUp,
  listBackupNames,
  log
} = require('../lib');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('save')
    .setDescription('Save the server with an optional name')
    .addStringOption(o =>
      o
        .setName('name')
        .setDescription('Save name')
        .setAutocomplete(true)
        .setRequired(false)
    ),
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    const names = await listBackupNames();
    const filtered = names
      .filter(n => n.startsWith(focused))
      .slice(0, 24);
    const options = (focused
      ? [focused, ...filtered.filter(n => n !== focused)]
      : filtered
    ).map(n => ({ name: n, value: n })).slice(0, 25);
    await interaction.respond(options);
  },
  async execute(interaction) {
    log('save command invoked');
    await interaction.deferReply();
    const inst = await findRunningInstance();
    if (!inst) {
      await sendReply(interaction, 'No running server');
      return;
    }
    const inputName = interaction.options.getString('name');
    const tag = (inst.Tags || []).find(t => t.Key === 'SaveName');
    const name = inputName || (tag ? tag.Value : `backup-${Date.now()}`);
    const ip = inst.PublicIpAddress;
    if (inputName) {
      await ec2.send(
        new CreateTagsCommand({ Resources: [inst.InstanceId], Tags: [{ Key: 'SaveName', Value: inputName }] })
      );
    }
    await sendReply(interaction, `Saving as \`${name}\`...`);
    if (ip) {
      await rconSave(ip);
      await sshExec(ip, backupCommands(name));
    }
    await sendFollowUp(interaction, 'Save complete');
    log('save command completed');
  }
};
