const { SlashCommandBuilder } = require('discord.js');
const https = require('https');

function fetchGithubStatus() {
  return new Promise((resolve, reject) => {
    https
      .get('https://www.githubstatus.com/api/v2/status.json', res => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', err => reject(err));
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('githubstatus')
    .setDescription('Show GitHub service status'),
  async execute(interaction) {
    try {
      const json = await fetchGithubStatus();
      let body = `GitHub status: ${json.status.indicator} - ${json.status.description}`;
      const maxBytes = 2000;
      if (Buffer.byteLength(body, 'utf8') > maxBytes) {
        body = body.slice(0, maxBytes - 3) + '...';
      }
      await interaction.reply(body);
    } catch (err) {
      await interaction.reply('Error fetching GitHub status');
    }
  }
};
