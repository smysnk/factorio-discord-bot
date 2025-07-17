const { SlashCommandBuilder } = require('discord.js');
const cp = require('child_process');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sync')
    .setDescription('Sync repository with remote'),
  async execute(interaction) {
    await interaction.reply('Syncing repository...');
    cp.exec('git pull --no-edit', (err, stdout, stderr) => {
      if (err) {
        interaction.followUp('Pull failed: ' + (stderr || err.message));
        return;
      }
      if (/CONFLICT/.test(stdout) || /CONFLICT/.test(stderr)) {
        interaction.followUp('Merge conflicts detected. Push aborted.');
        return;
      }
      cp.exec('git push', (err2, stdout2, stderr2) => {
        if (err2) {
          interaction.followUp('Push failed: ' + (stderr2 || err2.message));
        } else {
          interaction.followUp('Repository synced and pushed.');
        }
      });
    });
  }
};
