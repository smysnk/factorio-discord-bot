const { SlashCommandBuilder } = require('discord.js');
const { template, findRunningInstance, getSystemStats, formatMetadata } = require('../lib');

module.exports = {
  data: new SlashCommandBuilder().setName('status').setDescription('Get server status'),
  async execute(interaction) {
    const inst = await findRunningInstance();
    if (inst) {
      const ip = inst.PublicIpAddress;
      const stats = ip ? await getSystemStats(ip) : {};
      const meta = {
        'Instance ID': inst.InstanceId,
        'Instance Type': inst.InstanceType,
        'Availability Zone': inst.Placement.AvailabilityZone,
        'IP Address': ip,
        'Security Groups': inst.SecurityGroups.map(g => g.GroupName).join(', '),
        'Open Ports': (template.ingress_ports || []).join(', '),
        Load: stats.load,
        Memory: stats.memory,
        'Disk /opt/factorio': stats.disk
      };
      const table = formatMetadata(meta);
      await interaction.reply(table || 'No data');
    } else {
      await interaction.reply('No running servers');
    }
  }
};
