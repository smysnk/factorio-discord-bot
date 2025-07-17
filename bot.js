require('dotenv').config();
const fs = require('fs');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { sendReply, sendFollowUp, debug } = require('./lib');
const path = require('path');

const channelId = process.env.DISCORD_CHANNEL_ID;
const guildId = process.env.DISCORD_GUILD_ID;

const bot = new Client({ intents: [GatewayIntentBits.Guilds] });

const commandFiles = fs.readdirSync(path.join(__dirname, 'commands')).filter(f => f.endsWith('.js'));
const commands = new Map();

for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  commands.set(command.data.name, command);
}

bot.once(Events.ClientReady, async () => {
  debug(`Logged in as ${bot.user.tag}`);
  const data = Array.from(commands.values()).map(c => c.data.toJSON());
  if (guildId) {
    await bot.application.commands.set(data, guildId);
  } else {
    await bot.application.commands.set(data);
  }
});

bot.on(Events.InteractionCreate, async interaction => {
  if (interaction.channelId !== channelId) return;

  const command = commands.get(interaction.commandName);
  if (!command) return;

  if (interaction.isAutocomplete()) {
    if (command.autocomplete) {
      await command.autocomplete(interaction);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(err);
    const msg = 'Error: ' + err.message;
    await sendReply(interaction, msg, { ephemeral: true });
  }
});

bot.login(process.env.DISCORD_TOKEN);
