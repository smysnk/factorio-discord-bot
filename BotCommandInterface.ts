import { ChatInputCommandInteraction } from 'discord.js';

export interface BotCommandInterface {
  start(interaction: ChatInputCommandInteraction, backup?: string | null, version?: string | null): Promise<void>;
  stop(interaction: ChatInputCommandInteraction): Promise<void>;
  status(interaction: ChatInputCommandInteraction): Promise<void>;
  save(interaction: ChatInputCommandInteraction, name?: string | null): Promise<void>;
}
