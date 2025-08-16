const { SlashCommandBuilder } = require('discord.js');
const { ec2, findRunningInstance, sshExec, rconSave, backupCommands, CreateTagsCommand, sendReply, sendFollowUp, listBackups, log } = require('../lib');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('save')
    .setDescription('Save the server with a name')
    .addStringOption(o => o.setName('name').setDescription('Save name').setAutocomplete(true).setRequired(true)),
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    const backups = await listBackups();
    const filtered = backups
      .map(o => o.Key)
      .filter(b => b.startsWith(focused))
      .slice(0, 25);
    await interaction.respond(filtered.map(b => ({ name: b, value: b })));
  },
  async execute(interaction) {
    log('save command invoked');
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
      await rconSave(ip);
      await sshExec(ip, backupCommands(name));
    }
    await sendFollowUp(interaction, 'Save complete');
    log('save command completed');
  }
};
