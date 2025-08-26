const { SlashCommandBuilder } = require('discord.js');
const { ec2, state, findRunningInstance, sshExec, rconSave, backupCommands, TerminateInstancesCommand, DescribeInstancesCommand, sendReply, sendFollowUp, log } = require('../lib');

module.exports = {
  data: new SlashCommandBuilder().setName('stop').setDescription('Stop the Factorio server'),
  async execute(interaction) {
    log('stop command invoked');
    await interaction.deferReply();
    let inst = state.instanceId
      ? (await ec2.send(new DescribeInstancesCommand({ InstanceIds: [state.instanceId] }))).Reservations[0].Instances[0]
      : await findRunningInstance();
    if (!inst) {
      await sendReply(interaction, 'No running server');
      return;
    }
    const ip = inst.PublicIpAddress;
    const tag = (inst.Tags || []).find(t => t.Key === 'SaveName');
    const name = tag ? tag.Value : `backup-${Date.now()}`;
    await sendReply(interaction, `Stopping server and saving as ${name}...`);
    if (ip) {
      await rconSave(ip);
      await sshExec(ip, backupCommands(name));
    }
    await ec2.send(new TerminateInstancesCommand({ InstanceIds: [inst.InstanceId] }));
    state.instanceId = null;
    await sendFollowUp(interaction, 'Server terminated');
    log('stop command completed');
  }
};
