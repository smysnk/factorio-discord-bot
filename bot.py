import json
import os
import asyncio
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from dotenv import load_dotenv

load_dotenv()

import boto3  # type: ignore
import discord  # type: ignore
from discord.ext import commands  # type: ignore
import paramiko  # type: ignore


@dataclass
class EC2Template:
    availability_zone: str
    security_group_name: str
    ingress_ports: List[int]
    egress_ports: List[int]
    ami: str
    key_name: str
    instance_type: str
    tags: Dict[str, str] = field(default_factory=dict)

    @classmethod
    def load(cls, path: str) -> "EC2Template":
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return cls(**data)


class FactorioBot(commands.Bot):
    def __init__(self, template_path: str):
        intents = discord.Intents.default()
        super().__init__(command_prefix="!", intents=intents)
        self.template = EC2Template.load(template_path)
        self.ec2 = boto3.client(
            "ec2",
            aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
            aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
            region_name=os.getenv("AWS_REGION"),
        )
        self.s3 = boto3.client(
            "s3",
            aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
            aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
            region_name=os.getenv("AWS_REGION"),
        )
        self.channel_id = int(os.getenv("DISCORD_CHANNEL_ID", "0"))
        self.instance_id: Optional[str] = None
        self.backup_name: Optional[str] = None

    async def on_ready(self):
        print(f"Logged in as {self.user}")

    # Utility methods
    def _find_running_instance(self) -> Optional[str]:
        filters = [
            {"Name": "instance-state-name", "Values": ["pending", "running"]},
            {"Name": "availability-zone", "Values": [self.template.availability_zone]},
        ]
        for k, v in self.template.tags.items():
            filters.append({"Name": f"tag:{k}", "Values": [v]})
        resp = self.ec2.describe_instances(Filters=filters)
        for reservation in resp.get("Reservations", []):
            for instance in reservation.get("Instances", []):
                return instance["InstanceId"]
        return None

    def _create_security_group(self) -> str:
        resp = self.ec2.create_security_group(
            Description="factorio-server",
            GroupName=self.template.security_group_name,
        )
        sg_id = resp["GroupId"]
        if self.template.ingress_ports:
            self.ec2.authorize_security_group_ingress(
                GroupId=sg_id,
                IpProtocol="udp",
                FromPort=min(self.template.ingress_ports),
                ToPort=max(self.template.ingress_ports),
                CidrIp="0.0.0.0/0",
            )
        if self.template.egress_ports:
            self.ec2.authorize_security_group_egress(
                GroupId=sg_id,
                IpProtocol="-1",
                FromPort=0,
                ToPort=65535,
                CidrIp="0.0.0.0/0",
            )
        return sg_id

    def _launch_instance(self, sg_id: str) -> str:
        tag_spec = [
            {
                "ResourceType": "instance",
                "Tags": [{"Key": k, "Value": v} for k, v in self.template.tags.items()],
            }
        ]
        resp = self.ec2.run_instances(
            ImageId=self.template.ami,
            InstanceType=self.template.instance_type,
            KeyName=self.template.key_name,
            SecurityGroupIds=[sg_id],
            TagSpecifications=tag_spec,
            MinCount=1,
            MaxCount=1,
            Placement={"AvailabilityZone": self.template.availability_zone},
        )
        return resp["Instances"][0]["InstanceId"]

    async def _wait_for_instance(self, instance_id: str) -> str:
        waiter = self.ec2.get_waiter("instance_running")
        waiter.wait(InstanceIds=[instance_id])
        desc = self.ec2.describe_instances(InstanceIds=[instance_id])
        ip = desc["Reservations"][0]["Instances"][0]["PublicIpAddress"]
        return ip

    def _ssh_and_setup(self, ip: str):
        key_file = os.getenv("SSH_KEY_PATH")
        if not key_file:
            raise RuntimeError("SSH_KEY_PATH not set")
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(ip, username="ec2-user", key_filename=key_file)
        cmds = [
            "sudo yum install -y docker",
            "sudo service docker start",
        ]
        for cmd in cmds:
            ssh.exec_command(cmd)
        ssh.close()

    # Discord commands
    @commands.command()
    async def start(self, ctx: commands.Context, name: Optional[str] = None):
        if ctx.channel.id != self.channel_id:
            return
        await ctx.send("Checking for existing server...")
        inst = self._find_running_instance()
        if inst:
            await ctx.send("Server already running")
            return
        await ctx.send("Launching EC2 instance...")
        sg_id = self._create_security_group()
        self.instance_id = self._launch_instance(sg_id)
        ip = await self._wait_for_instance(self.instance_id)
        await ctx.send(f"Instance launched with IP {ip}, installing docker...")
        self._ssh_and_setup(ip)
        # Backup operations omitted for brevity
        await ctx.send(f"Factorio server running at {ip}")

    @commands.command()
    async def name(self, ctx: commands.Context, backup: str):
        if self.instance_id:
            self.backup_name = backup
            await ctx.send(f"Backup name set to {backup}")

    @commands.command()
    async def stop(self, ctx: commands.Context):
        if ctx.channel.id != self.channel_id or not self.instance_id:
            return
        await ctx.send("Stopping server...")
        self.ec2.terminate_instances(InstanceIds=[self.instance_id])
        self.instance_id = None
        await ctx.send("Server terminated")

    @commands.command()
    async def list(self, ctx: commands.Context):
        bucket = os.getenv("BACKUP_BUCKET")
        resp = self.s3.list_objects_v2(Bucket=bucket)
        names = [obj["Key"] for obj in resp.get("Contents", [])]
        await ctx.send("Available backups: " + ", ".join(names))

    @commands.command()
    async def status(self, ctx: commands.Context):
        inst = self._find_running_instance()
        if inst:
            await ctx.send(f"Server running: {inst}")
        else:
            await ctx.send("No running servers")


def main():
    template = os.getenv("EC2_TEMPLATE", "ec2_template.json")
    bot = FactorioBot(template)
    token = os.getenv("DISCORD_TOKEN")
    bot.add_command(bot.start)
    bot.add_command(bot.stop)
    bot.add_command(bot.list)
    bot.add_command(bot.status)
    bot.add_command(bot.name)
    bot.run(token)


if __name__ == "__main__":
    main()
