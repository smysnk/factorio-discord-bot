const { SlashCommandBuilder } = require('discord.js');
const { ec2, findRunningInstance, sshExec, backupCommands, CreateTagsCommand, sendReply, sendFollowUp } = require('../lib');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('save')
    .setDescription('Save the server with a name')
    .addStringOption(o => o.setName('name').setDescription('Save name').setAutocomplete(true).setRequired(true)),
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    const backups = await require('../lib').listBackups();
    const filtered = backups
      .map(o => o.Key)
      .filter(b => b.startsWith(focused))
      .slice(0, 25);
    await interaction.respond(filtered.map(b => ({ name: b, value: b })));
  },
  async execute(interaction) {
    require('../lib').debug('save command invoked');
    await interaction.deferReply();
    const inst = await findRunningInstance();
    if (!inst) {
      await sendReply(interaction, 'No running server');
      return;
    }
    const name = interaction.options.getString('name');
    const ip = inst.PublicIpAddress;
    await ec2.send(new CreateTagsCommand({ Resources: [inst.InstanceId], Tags: [{ Key: 'SaveName', Value: name }] }));
    await sendReply(interaction, `Saving as ${name}...`);
    if (ip) {
      await sshExec(ip, backupCommands(name));
    }
    await sendFollowUp(interaction, 'Save complete');
    require('../lib').debug('save command completed');
  }
};
