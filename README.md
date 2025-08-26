# Factorio Discord Bot

This project contains a simple Discord bot that can manage a Factorio game server hosted on AWS EC2 or on an existing machine accessible via SSH. The bot is implemented in **TypeScript** using `discord.js`, the AWS SDK, `ssh2` and `dotenv`. These dependencies must be installed in your environment along with valid credentials stored in a `.env` file.

## Configuration

1. Copy `.env.example` to `.env` and fill in the required values.
   Set `SERVER_IP`, `SSH_KEY_PATH` (and optionally `SSH_USER`) to point at an existing server if you do not want the bot to launch EC2 instances.
2. Adjust `ec2_template.json` to match the EC2 instance you want to launch.
   The bot automatically loads variables from `.env` when it starts.
3. Set `DOCKER_IMAGE` to the Factorio Docker image you wish to run
   (e.g. `factoriotools/factorio:latest`).
4. Ensure `BACKUP_BUCKET` is an accessible S3 bucket. Backups are uploaded and
   restored using `aws s3 cp`. The commands include your `AWS_ACCESS_KEY_ID`
   and `AWS_SECRET_ACCESS_KEY` from `.env` so the remote instance can access the
   bucket. Existing objects with the same key are overwritten automatically.
5. Set `DEBUG_LOG=1` to print time-stamped debugging output to the console. The bot logs major actions and command events when this flag is enabled.

## Running the Bot

Install the required packages and run with `npm start`:

```bash
npm install
npm start
```

The bot uses slash commands which are registered automatically on startup. Use
`/start` to launch the server, optionally selecting a prior backup name to
restore. The `/save` and `/stop` commands create a dated archive and player data
file which are uploaded to the configured S3 bucket before shutting down (for
`/stop`). Backups are stored using filenames of the form
`<name>.YYYY.MM.DD.HH.MM.tar.bz2`. Use `DISCORD_CHANNEL_ID` to restrict the channel and
`DISCORD_GUILD_ID` to limit registration to a single guild.
