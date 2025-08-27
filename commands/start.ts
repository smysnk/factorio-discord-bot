import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { listBackups, parseBackupKey, log } from '../lib';
import { BotCommandInterface } from '../BotCommandInterface';

export default {
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
  async autocomplete(interaction: any) {
    const focused = interaction.options.getFocused();
    const backups = await listBackups();
    const filtered = backups
      .map((o: any) => o.Key)
      .filter((k: string) => k.startsWith(focused))
      .slice(0, 25);
    await interaction.respond(
      filtered.map((k: string) => {
        const p = parseBackupKey(k);
        const name = p ? `${p.name}.${p.date}` : k;
        return { name, value: k };
      })
    );
  },
  async execute(interaction: ChatInputCommandInteraction, bot: BotCommandInterface) {
    log('start command invoked');
    await interaction.deferReply();
    const backup = interaction.options.getString('name');
    const version = interaction.options.getString('version');
    await bot.start(interaction, backup, version);
    log('start command completed');
  }
};
