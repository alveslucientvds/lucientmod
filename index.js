require("dotenv").config();

const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  AuditLogEvent,
  ChannelType,
  EmbedBuilder
} = require("discord.js");
const { joinVoiceChannel, getVoiceConnection } = require("@discordjs/voice");

const app = express();

/* =========================
   UPTIMEROBOT WEB SERVER
========================= */
app.get("/", (req, res) => {
  res.status(200).send("Bot aktif 🔥");
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Web server çalışıyor. Port: ${process.env.PORT || 3000}`);
});

/* =========================
   CLIENT
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User]
});

const PREFIX = process.env.PREFIX || ".";
const TOKEN = process.env.TOKEN;

if (!TOKEN) {
  console.error("TOKEN bulunamadı. .env dosyasını kontrol et.");
  process.exit(1);
}

/* =========================
   CACHE
========================= */
const deletedMessageCache = new Map();

/* =========================
   HELPER FUNCTIONS
========================= */
function getLogChannel(guild, name) {
  return guild.channels.cache.find(
    (c) =>
      c.name === name &&
      (c.type === ChannelType.GuildText || c.isTextBased?.())
  );
}

function createLogEmbed({
  title,
  description,
  color = 0x2b2d31,
  executor = null
}) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();

  if (executor) {
    embed.setThumbnail(executor.displayAvatarURL({ dynamic: true, size: 1024 }));
    embed.setFooter({
      text: `${executor.tag} tarafından işlem yapıldı`
    });
  }

  return embed;
}

async function fetchAuditLog(guild, type) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 6 });
    return logs.entries.first() || null;
  } catch (err) {
    console.error("Audit log alınamadı:", err);
    return null;
  }
}

function parseDuration(input) {
  if (!input) return null;

  const match = input.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}

function formatTimeout(ms) {
  if (!ms || ms <= 0) return "Kaldırıldı";

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days) parts.push(`${days} gün`);
  if (hours) parts.push(`${hours} saat`);
  if (minutes) parts.push(`${minutes} dakika`);
  if (seconds && parts.length === 0) parts.push(`${seconds} saniye`);

  return parts.join(", ");
}

function getTargetMember(message, arg) {
  if (!arg) return null;

  const mentioned = message.mentions.members.first();
  if (mentioned) return mentioned;

  return message.guild.members.cache.get(arg) || null;
}

function truncate(text, max = 1000) {
  if (!text) return "İçerik yok.";
  return text.length > max ? text.slice(0, max) + "..." : text;
}

/* =========================
   READY
========================= */
client.once("ready", () => {
  console.log(`${client.user.tag} olarak giriş yapıldı.`);
  client.user.setPresence({
    activities: [{ name: "Sunucuyu koruyor 🔥" }],
    status: "online"
  });
});

/* =========================
   COMMANDS
========================= */
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild || message.author.bot) return;

    // Mesaj cache
    deletedMessageCache.set(message.id, {
      authorTag: message.author.tag,
      authorId: message.author.id,
      content: message.content || "Mesaj içeriği yok / embed / dosya olabilir.",
      channelId: message.channel.id
    });

    setTimeout(() => {
      deletedMessageCache.delete(message.id);
    }, 5 * 60 * 1000);

    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const command = args.shift()?.toLowerCase();

    /* ========== KICK ========== */
    if (command === "kick") {
      if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) {
        return message.reply("Kick yetkin yok.");
      }

      const member = getTargetMember(message, args[0]);
      if (!member) return message.reply("Bir kullanıcı etiketle veya ID gir.");

      if (member.id === message.author.id) {
        return message.reply("Kendini kickleyemezsin.");
      }

      if (!member.kickable) {
        return message.reply("Bu kullanıcıyı kickleyemiyorum.");
      }

      const reason = args.slice(1).join(" ") || "Sebep belirtilmedi.";

      try {
        await member.kick(reason);
        return message.reply(`✅ ${member.user.tag} sunucudan atıldı.`);
      } catch (err) {
        console.error("Kick hatası:", err);
        return message.reply("Kick işlemi sırasında hata oluştu.");
      }
    }

    /* ========== BAN ========== */
    if (command === "ban") {
      if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
        return message.reply("Ban yetkin yok.");
      }

      const rawArg = args[0];
      if (!rawArg) return message.reply("Bir kullanıcı etiketle veya ID gir.");

      let member = getTargetMember(message, rawArg);

      if (!member) {
        try {
          member = await message.guild.members.fetch(rawArg);
        } catch (_) {
          member = null;
        }
      }

      const targetId = member?.id || rawArg;
      const reason = args.slice(1).join(" ") || "Sebep belirtilmedi.";

      if (targetId === message.author.id) {
        return message.reply("Kendini banlayamazsın.");
      }

      try {
        await message.guild.members.ban(targetId, { reason });
        return message.reply("✅ Kullanıcı banlandı.");
      } catch (err) {
        console.error("Ban hatası:", err);
        return message.reply("Ban işlemi sırasında hata oluştu.");
      }
    }

    /* ========== TIMEOUT ========== */
    if (command === "timeout") {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        return message.reply("Zaman aşımı yetkin yok.");
      }

      const member = getTargetMember(message, args[0]);
      if (!member) return message.reply("Bir kullanıcı etiketle veya ID gir.");

      if (member.id === message.author.id) {
        return message.reply("Kendine zaman aşımı atamazsın.");
      }

      const durationInput = args[1];
      const duration = parseDuration(durationInput);

      if (!duration) {
        return message.reply("Süreyi doğru gir. Örnek: `.timeout @kişi 10m spam`");
      }

      const reason = args.slice(2).join(" ") || "Sebep belirtilmedi.";

      try {
        await member.timeout(duration, reason);
        return message.reply(`✅ ${member.user.tag} kullanıcısına ${durationInput} zaman aşımı uygulandı.`);
      } catch (err) {
        console.error("Timeout hatası:", err);
        return message.reply("Timeout işlemi sırasında hata oluştu.");
      }
    }

    /* ========== JOIN ========== */
    if (command === "join") {
      const voiceChannel = message.member.voice.channel;
      if (!voiceChannel) {
        return message.reply("Önce bir ses kanalına girmen lazım.");
      }

      try {
        const existing = getVoiceConnection(message.guild.id);
        if (existing) existing.destroy();

        joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: voiceChannel.guild.id,
          adapterCreator: voiceChannel.guild.voiceAdapterCreator,
          selfDeaf: true,
          selfMute: false
        });

        return message.reply(`✅ Ses kanalına girdim: **${voiceChannel.name}**`);
      } catch (err) {
        console.error("Join hatası:", err);
        return message.reply("Ses kanalına girerken hata oluştu.");
      }
    }

    /* ========== LEAVE ========== */
    if (command === "leave") {
      try {
        const connection = getVoiceConnection(message.guild.id);
        if (!connection) {
          return message.reply("Zaten herhangi bir ses kanalında değilim.");
        }

        connection.destroy();
        return message.reply("✅ Ses kanalından ayrıldım.");
      } catch (err) {
        console.error("Leave hatası:", err);
        return message.reply("Ses kanalından ayrılırken hata oluştu.");
      }
    }
  } catch (err) {
    console.error("messageCreate genel hata:", err);
  }
});

/* =========================
   MESSAGE DELETE LOG
========================= */
client.on("messageDelete", async (message) => {
  try {
    if (!message.guild) return;

    const logChannel = getLogChannel(message.guild, "message-log");
    if (!logChannel) return;

    const cached = deletedMessageCache.get(message.id);

    const authorTag = message.author?.tag || cached?.authorTag || "Bilinmiyor";
    const authorId = message.author?.id || cached?.authorId || "Bilinmiyor";
    const content =
      message.content ||
      cached?.content ||
      "Mesaj içeriği alınamadı.";

    const embed = new EmbedBuilder()
      .setTitle("Mesaj Silindi")
      .setColor(0xff0000)
      .setDescription(
        `**Mesajı atan:** ${authorTag} (${authorId})\n` +
        `**Kanal:** <#${message.channel?.id || cached?.channelId || "0"}>\n` +
        `**Silinen mesaj:**\n${truncate(content)}`
      )
      .setTimestamp();

    if (message.author) {
      embed.setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 1024 }));
      embed.setFooter({ text: message.author.tag });
    }

    await logChannel.send({ embeds: [embed] }).catch(() => {});
  } catch (err) {
    console.error("messageDelete hatası:", err);
  }
});

/* =========================
   BAN LOG
========================= */
client.on("guildBanAdd", async (ban) => {
  try {
    const logChannel = getLogChannel(ban.guild, "ban-log");
    if (!logChannel) return;

    const audit = await fetchAuditLog(ban.guild, AuditLogEvent.MemberBanAdd);
    const executor = audit?.executor || null;
    const reason = audit?.reason || "Sebep belirtilmedi.";

    const embed = createLogEmbed({
      title: "Kullanıcı Banlandı",
      description:
        `**Banlanan kişi:** ${ban.user.tag} (${ban.user.id})\n` +
        `**Banlayan kişi:** ${executor ? `${executor.tag} (${executor.id})` : "Bilinmiyor"}\n` +
        `**Sebep:** ${reason}`,
      color: 0xff0000,
      executor
    });

    await logChannel.send({ embeds: [embed] }).catch(() => {});
  } catch (err) {
    console.error("guildBanAdd hatası:", err);
  }
});

/* =========================
   MEMBER UPDATE
   - Timeout log
   - Role log
========================= */
client.on("guildMemberUpdate", async (oldMember, newMember) => {
  try {
    /* ===== TIMEOUT LOG ===== */
    const oldTimeout = oldMember.communicationDisabledUntilTimestamp || null;
    const newTimeout = newMember.communicationDisabledUntilTimestamp || null;

    if (oldTimeout !== newTimeout) {
      const logChannel = getLogChannel(newMember.guild, "timeout-log");
      if (logChannel) {
        const audit = await fetchAuditLog(newMember.guild, AuditLogEvent.MemberUpdate);
        const executor = audit?.executor || null;

        let durationText = "Kaldırıldı";
        if (newTimeout && newTimeout > Date.now()) {
          durationText = formatTimeout(newTimeout - Date.now());
        }

        const embed = createLogEmbed({
          title: "Zaman Aşımı İşlemi",
          description:
            `**Zaman aşımı atılan kişi:** ${newMember.user.tag} (${newMember.user.id})\n` +
            `**İşlemi yapan kişi:** ${executor ? `${executor.tag} (${executor.id})` : "Bilinmiyor"}\n` +
            `**Süre:** ${durationText}`,
          color: 0xffa500,
          executor
        });

        await logChannel.send({ embeds: [embed] }).catch(() => {});
      }
    }

    /* ===== ROLE LOG ===== */
    const oldRoles = oldMember.roles.cache;
    const newRoles = newMember.roles.cache;

    const addedRoles = newRoles.filter((role) => !oldRoles.has(role.id));
    const removedRoles = oldRoles.filter((role) => !newRoles.has(role.id));

    if (addedRoles.size > 0 || removedRoles.size > 0) {
      const logChannel = getLogChannel(newMember.guild, "rol-log");
      if (!logChannel) return;

      const audit = await fetchAuditLog(newMember.guild, AuditLogEvent.MemberRoleUpdate);
      const executor = audit?.executor || null;

      for (const role of addedRoles.values()) {
        if (role.name === "@everyone") continue;

        const embed = createLogEmbed({
          title: "Rol Verildi",
          description:
            `**Kullanıcı:** ${newMember.user.tag} (${newMember.user.id})\n` +
            `**Verilen rol:** ${role.name}\n` +
            `**Rolü veren kişi:** ${executor ? `${executor.tag} (${executor.id})` : "Bilinmiyor"}`,
          color: 0x00ff00,
          executor
        });

        await logChannel.send({ embeds: [embed] }).catch(() => {});
      }

      for (const role of removedRoles.values()) {
        if (role.name === "@everyone") continue;

        const embed = createLogEmbed({
          title: "Rol Alındı",
          description:
            `**Kullanıcı:** ${newMember.user.tag} (${newMember.user.id})\n` +
            `**Alınan rol:** ${role.name}\n` +
            `**Rolü alan kişi:** ${executor ? `${executor.tag} (${executor.id})` : "Bilinmiyor"}`,
          color: 0xff9900,
          executor
        });

        await logChannel.send({ embeds: [embed] }).catch(() => {});
      }
    }
  } catch (err) {
    console.error("guildMemberUpdate hatası:", err);
  }
});

/* =========================
   CHANNEL LOGS
========================= */
client.on("channelCreate", async (channel) => {
  try {
    if (!channel.guild) return;

    const logChannel = getLogChannel(channel.guild, "kanal-log");
    if (!logChannel) return;

    const audit = await fetchAuditLog(channel.guild, AuditLogEvent.ChannelCreate);
    const executor = audit?.executor || null;

    const embed = createLogEmbed({
      title: "Kanal Oluşturuldu",
      description:
        `**Kanal:** ${channel.name}\n` +
        `**Tür:** ${channel.type}\n` +
        `**Oluşturan kişi:** ${executor ? `${executor.tag} (${executor.id})` : "Bilinmiyor"}\n` +
        `**Değişiklik:** Yeni kanal oluşturuldu`,
      color: 0x00ff00,
      executor
    });

    await logChannel.send({ embeds: [embed] }).catch(() => {});
  } catch (err) {
    console.error("channelCreate hatası:", err);
  }
});

client.on("channelDelete", async (channel) => {
  try {
    if (!channel.guild) return;

    const logChannel = getLogChannel(channel.guild, "kanal-log");
    if (!logChannel) return;

    const audit = await fetchAuditLog(channel.guild, AuditLogEvent.ChannelDelete);
    const executor = audit?.executor || null;

    const embed = createLogEmbed({
      title: "Kanal Silindi",
      description:
        `**Kanal:** ${channel.name}\n` +
        `**Tür:** ${channel.type}\n` +
        `**Silen kişi:** ${executor ? `${executor.tag} (${executor.id})` : "Bilinmiyor"}\n` +
        `**Değişiklik:** Kanal silindi`,
      color: 0xff0000,
      executor
    });

    await logChannel.send({ embeds: [embed] }).catch(() => {});
  } catch (err) {
    console.error("channelDelete hatası:", err);
  }
});

client.on("channelUpdate", async (oldChannel, newChannel) => {
  try {
    if (!newChannel.guild) return;

    const logChannel = getLogChannel(newChannel.guild, "kanal-log");
    if (!logChannel) return;

    const changes = [];

    if (oldChannel.name !== newChannel.name) {
      changes.push(`**İsim:** \`${oldChannel.name}\` → \`${newChannel.name}\``);
    }

    if ("topic" in oldChannel && oldChannel.topic !== newChannel.topic) {
      changes.push(`**Konu:** \`${oldChannel.topic || "Yok"}\` → \`${newChannel.topic || "Yok"}\``);
    }

    if ("nsfw" in oldChannel && oldChannel.nsfw !== newChannel.nsfw) {
      changes.push(`**NSFW:** \`${oldChannel.nsfw}\` → \`${newChannel.nsfw}\``);
    }

    if ("rateLimitPerUser" in oldChannel && oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) {
      changes.push(`**Yavaş mod:** \`${oldChannel.rateLimitPerUser || 0}\` → \`${newChannel.rateLimitPerUser || 0}\` saniye`);
    }

    if ("parentId" in oldChannel && oldChannel.parentId !== newChannel.parentId) {
      changes.push(`**Kategori:** \`${oldChannel.parent?.name || "Yok"}\` → \`${newChannel.parent?.name || "Yok"}\``);
    }

    if (!changes.length) return;

    const audit = await fetchAuditLog(newChannel.guild, AuditLogEvent.ChannelUpdate);
    const executor = audit?.executor || null;

    const embed = createLogEmbed({
      title: "Kanal Güncellendi",
      description:
        `**Kanal:** ${newChannel.name}\n` +
        `**Düzenleyen kişi:** ${executor ? `${executor.tag} (${executor.id})` : "Bilinmiyor"}\n\n` +
        `**Yapılan değişiklikler:**\n${changes.join("\n")}`,
      color: 0x0099ff,
      executor
    });

    await logChannel.send({ embeds: [embed] }).catch(() => {});
  } catch (err) {
    console.error("channelUpdate hatası:", err);
  }
});

/* =========================
   VOICE LOG
   sağ tık -> bağlantısını kes
========================= */
client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    if (oldState.channelId && !newState.channelId) {
      const guild = oldState.guild;
      const logChannel = getLogChannel(guild, "voice-log");
      if (!logChannel) return;

      const audit = await fetchAuditLog(guild, AuditLogEvent.MemberDisconnect);
      const executor = audit?.executor || null;
      const target = audit?.target || null;

      if (target && target.id !== oldState.id) return;
      if (!executor) return;

      const embed = createLogEmbed({
        title: "Ses Bağlantısı Kesildi",
        description:
          `**Bağlantısı kesilen kişi:** ${oldState.member?.user?.tag || "Bilinmiyor"} (${oldState.id})\n` +
          `**Bağlantıyı kesen kişi:** ${executor.tag} (${executor.id})\n` +
          `**Eski kanal:** ${oldState.channel?.name || "Bilinmiyor"}`,
        color: 0xff0000,
        executor
      });

      await logChannel.send({ embeds: [embed] }).catch(() => {});
    }
  } catch (err) {
    console.error("voiceStateUpdate hatası:", err);
  }
});

/* =========================
   ANTI CRASH
========================= */
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("uncaughtExceptionMonitor", (err, origin) => {
  console.error("Uncaught Exception Monitor:", err, origin);
});

process.on("multipleResolves", (type, promise, value) => {
  console.error("Multiple Resolves:", type, value);
});

client.on("error", (err) => {
  console.error("Discord Client Error:", err);
});

client.on("warn", (info) => {
  console.warn("Discord Warning:", info);
});

client.on("shardError", (error) => {
  console.error("Shard Error:", error);
});

client.on("disconnect", () => {
  console.warn("Bot bağlantısı koptu.");
});

client.on("reconnecting", () => {
  console.log("Bot yeniden bağlanıyor...");
});

/* =========================
   LOGIN
========================= */
client.login(TOKEN).catch((err) => {
  console.error("Login hatası:", err);
});