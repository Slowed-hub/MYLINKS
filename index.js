require('dotenv').config();
const {
    Client,
    IntentsBitField,
    PermissionsBitField,
    REST,
    Routes,
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} = require('discord.js');
const Database = require('better-sqlite3');

// ======== INIT BOT & DB ========
const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.MessageContent
    ]
});

const db = new Database('./bot.db');

// Tables
db.prepare(`CREATE TABLE IF NOT EXISTS subscribers (userId TEXT PRIMARY KEY, free INTEGER, addedAt INTEGER)`).run();
db.prepare(`CREATE TABLE IF NOT EXISTS activeMessages (channelId TEXT PRIMARY KEY, messageId TEXT)`).run();
db.prepare(`CREATE TABLE IF NOT EXISTS serverLanguages (guildId TEXT PRIMARY KEY, lang TEXT)`).run();

// ======== CONFIG ========
const BANNER_URL = "https://i.ibb.co/JW5SyCs6/to-the-Verse.png";
const OPEN_DURATION_MS = 3900415;
const CLOSE_DURATION_MS = 7200767;
const CYCLE_DURATION_MS = OPEN_DURATION_MS + CLOSE_DURATION_MS;
const INITIAL_OPEN_TIME = new Date('2026-07-21T19:37:38.379+02:00').getTime();

const thresholds = [
    { min: 0, max: 12*60*1000, colors: ['green','green','green','green','green'] },
    { min: 12*60*1000, max: 24*60*1000, colors: ['green','green','green','green','empty'] },
    { min: 24*60*1000, max: 36*60*1000, colors: ['green','green','green','empty','empty'] },
    { min: 36*60*1000, max: 48*60*1000, colors: ['green','green','empty','empty','empty'] },
    { min: 48*60*1000, max: 60*60*1000, colors: ['green','empty','empty','empty','empty'] },
    { min: 60*60*1000, max: 65*60*1000, colors: ['empty','empty','empty','empty','empty'] },
    { min: 65*60*1000, max: 89*60*1000, colors: ['red','red','red','red','red'] },
    { min: 89*60*1000, max: 113*60*1000, colors: ['green','red','red','red','red'] },
    { min: 113*60*1000, max: 137*60*1000, colors: ['green','green','red','red','red'] },
    { min: 137*60*1000, max: 161*60*1000, colors: ['green','green','green','red','red'] },
    { min: 161*60*1000, max: 185*60*1000, colors: ['green','green','green','green','red'] }
];

const activeMessages = new Map();
const serverLanguages = new Map();

// ======== RATE LIMITING ========
const rateLimits = new Map();
const RATE_LIMIT_MS = 5000; // 5 secondes entre chaque commande par utilisateur

function isRateLimited(userId) {
    const now = Date.now();
    const last = rateLimits.get(userId) || 0;
    if (now - last < RATE_LIMIT_MS) return true;
    rateLimits.set(userId, now);
    return false;
}

// ======== SANITIZE ========
function sanitize(str) {
    return str
        .replace(/@everyone/g, '@​everyone')
        .replace(/@here/g, '@​here')
        .replace(/[*_`~|>]/g, c => `\${c}`)
        .slice(0, 32); // limite à 32 chars max
}

const translations = {
    fr: {
        OPEN: 'HANGAR OUVERT',
        CLOSED: 'HANGAR FERMÉ',
        RESTART: 'RESTART',
        CLOSES_IN: 'Ferme dans :',
        OPENS_IN: 'Ouvre dans :',
        OFFLINE_FOR: 'Hors ligne pendant :',
        TIMER_STARTED: 'Minuteur démarré !',
        TIMER_STOPPED: 'Minuteur arrêté dans ce canal.',
        NO_PERMS: 'Erreur : Je n\'ai pas les permissions nécessaires.',
        LANG_SET: 'Langue définie sur le français.',
        AUTO_LANG: 'Langue auto-détectée : Français 🇫🇷',
        NO_LICENSE: "❌ Vous n'avez pas accès au minuteur.",
        NEXT_OPENINGS: 'Prochaines Ouvertures :',
        MY_LINKS: 'MY LINKS'
    },
    en: {
        OPEN: 'HANGAR OPEN',
        CLOSED: 'HANGAR CLOSED',
        RESTART: 'RESTART',
        CLOSES_IN: 'Closes in:',
        OPENS_IN: 'Opens in:',
        OFFLINE_FOR: 'Offline for:',
        TIMER_STARTED: 'Timer started!',
        TIMER_STOPPED: 'Timer stopped in this channel.',
        NO_PERMS: 'Error: I do not have the required permissions.',
        LANG_SET: 'Language set to English.',
        AUTO_LANG: 'Auto-detected language: English 🇬🇧',
        NO_LICENSE: "❌ You don't have access to the timer.",
        NEXT_OPENINGS: 'Next Openings:',
        MY_LINKS: 'MY LINKS'
    }
};

// ======== UTILS ========
function isOwner(userId) { return userId === process.env.DISCORD_OWNER_ID; }
function hasRequiredPermissions(channel) {
    return channel.permissionsFor(client.user).has([
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ManageMessages,
        PermissionsBitField.Flags.EmbedLinks
    ]);
}

// ======== SUBSCRIBERS ========
function addSubscriber(userId, free = false) {
    db.prepare('INSERT OR REPLACE INTO subscribers (userId, free, addedAt) VALUES (?, ?, ?)').run(userId, free ? 1 : 0, Date.now());
}
function removeSubscriber(userId) { db.prepare('DELETE FROM subscribers WHERE userId = ?').run(userId); }
function getSubscribers() { return db.prepare('SELECT * FROM subscribers').all(); }
function isSubscriber(userId) { return db.prepare('SELECT 1 FROM subscribers WHERE userId = ?').get(userId) !== undefined; }

// ======== TIMER & PHASE ========
function getCurrentPhaseAndNextChange(currentTime) {
    const elapsed = Math.max(0, currentTime - INITIAL_OPEN_TIME);
    const timeInCycle = elapsed % CYCLE_DURATION_MS;
    let status, label, dot, countdownLabel, nextChange;

    if (timeInCycle < OPEN_DURATION_MS) {
        status = 'ONLINE'; label = 'OPEN'; dot = '🟢'; countdownLabel = 'CLOSES_IN';
        nextChange = INITIAL_OPEN_TIME + Math.floor(elapsed / CYCLE_DURATION_MS) * CYCLE_DURATION_MS + OPEN_DURATION_MS;
    } else {
        status = 'OFFLINE'; label = 'CLOSED'; dot = '🔴'; countdownLabel = 'OPENS_IN';
        nextChange = INITIAL_OPEN_TIME + (Math.floor(elapsed / CYCLE_DURATION_MS) + 1) * CYCLE_DURATION_MS;
    }
    return { status, label, dot, countdownLabel, nextChange, timeInCycle };
}

function formatRemaining(remainingMs, status) {
    const minutes = Math.floor(remainingMs / 60000);
    const hours = Math.floor(minutes / 60);
    return status === 'OFFLINE' ? (hours > 0 ? `${hours}h${minutes%60}` : `${minutes}m`) : `${minutes}m`;
}

function getCircleEmojis(timeInCycle) {
    const t = thresholds.find(t => timeInCycle >= t.min && timeInCycle < t.max);
    return t ? t.colors.map(c => c === 'green' ? '🟢' : c === 'red' ? '🔴' : '⚫') : ['⚫','⚫','⚫','⚫','⚫'];
}

function getNextOpenings(count = 4) {
    const now = Date.now();
    const elapsed = Math.max(0, now - INITIAL_OPEN_TIME);
    const cyclesSinceStart = Math.floor(elapsed / CYCLE_DURATION_MS);
    return Array.from({length: count}, (_, i) => {
        const eventTime = new Date(INITIAL_OPEN_TIME + (cyclesSinceStart + i + 1) * CYCLE_DURATION_MS);
        return eventTime.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    });
}

// ======== BUTTONS & EMBED ========
function createOpeningButtons(nextOpens) {
    const row = new ActionRowBuilder();
    nextOpens.forEach((timeLabel, i) => {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`opening_${i}`)
                .setLabel(timeLabel)
                .setStyle(ButtonStyle.Primary)
                .setDisabled(true)
        );
    });
    const linkRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('MY LINKS')
            .setStyle(ButtonStyle.Link)
            .setURL('https://hub.pyam-timer.uk/'),
        new ButtonBuilder()
            .setLabel('FLEETOPS')
            .setStyle(ButtonStyle.Link)
            .setURL('https://fleetops-c7j.pages.dev/')
    );

    return [row, linkRow];
}

function buildTimerEmbed(t, circles, label, dot, countdownLabel, countdown, status) {
    return new EmbedBuilder()
        .setImage(BANNER_URL)
        .setColor(status === 'ONLINE' ? 0x00ff00 : status === 'OFFLINE' ? 0xff0000 : 0x808080)
        .setDescription(`\`\`\`\n${circles}\n\n${t[label]} ${dot}\n${t[countdownLabel]} ${countdown}\n\n${t.NEXT_OPENINGS}\n\`\`\``)
        .setFooter({ text: '4.9.0-live.12269732' });
}

// ======== SAFE EDIT ========
async function safeEditMessage(message, embed, components) {
    if (!message) return;
    try {
        if (!message.editable) {
            activeMessages.delete(message.channel.id);
            db.prepare('DELETE FROM activeMessages WHERE channelId = ?').run(message.channel.id);
            return;
        }
        await message.edit({ embeds: [embed], components });
    } catch (err) {
        if (err.code === 429) {
            await new Promise(r => setTimeout(r, err.retryAfter || 1000));
            await safeEditMessage(message, embed, components);
        } else if (err.code === 10008) {
            activeMessages.delete(message.channel.id);
            db.prepare('DELETE FROM activeMessages WHERE channelId = ?').run(message.channel.id);
        } else console.error('Erreur safeEditMessage:', err);
    }
}

// ======== UPDATE MESSAGES ========
async function updateAllMessages() {
    const now = Date.now();
    for (const [channelId, msg] of activeMessages.entries()) {
        if (!msg) continue;
        const lang = serverLanguages.get(msg.guild.id) || 'fr';
        const t = translations[lang];
        try {
            const { status, label, dot, countdownLabel, nextChange, timeInCycle } = getCurrentPhaseAndNextChange(now);
            const remaining = nextChange - now;
            if (remaining <= 0) continue;

            const circles = getCircleEmojis(timeInCycle).join(' ');
            const countdown = formatRemaining(remaining, status);
            const nextOpens = getNextOpenings(4);
            const buttons = createOpeningButtons(nextOpens);
            const embed = buildTimerEmbed(t, circles, label, dot, countdownLabel, countdown, status);

            await safeEditMessage(msg, embed, buttons);
        } catch (err) {
            console.error(`Erreur update message channel ${channelId}:`, err);
            activeMessages.delete(channelId);
            db.prepare('DELETE FROM activeMessages WHERE channelId = ?').run(channelId);
        }
    }
}

async function scheduleLoop() {
    await updateAllMessages();
    setTimeout(scheduleLoop, 15000);
}

function scheduleNextUpdate() {
    setTimeout(scheduleLoop, 15000);
}

// ======== COMMANDS ========
const commands = [
    new SlashCommandBuilder().setName('timer').setDescription('Démarre le minuteur'),
    new SlashCommandBuilder().setName('stop').setDescription('Arrête le minuteur'),
    new SlashCommandBuilder()
        .setName('langue')
        .setDescription('Choisit la langue du bot')
        .addStringOption(opt =>
            opt
                .setName('lang')
                .setDescription('français ou anglais')
                .setRequired(true)
                .addChoices(
                    { name: 'Français', value: 'fr' },
                    { name: 'English', value: 'en' }
                )
        ),
    new SlashCommandBuilder().setName('adduser').setDescription('Donne un accès gratuit par ID Discord')
        .addStringOption(opt => opt.setName('user_id').setDescription('ID Discord de l\'utilisateur').setRequired(true)),
    new SlashCommandBuilder().setName('list').setDescription('Liste tous les abonnés'),
    new SlashCommandBuilder().setName('export').setDescription('Exporte la liste des abonnés en CSV'),
    new SlashCommandBuilder().setName('revoke').setDescription('Retire l\'accès à un utilisateur')
        .addStringOption(opt => opt.setName('user_id').setDescription('ID Discord de l\'utilisateur').setRequired(true)),
    new SlashCommandBuilder().setName('servers').setDescription('Liste les serveurs connectés au bot'),
    new SlashCommandBuilder().setName('revoke-server').setDescription('Retire le bot d\'un serveur spécifique')
        .addStringOption(opt => opt.setName('server_id').setDescription('ID du serveur Discord').setRequired(true))
].map(c => c.toJSON());

// ======== READY ========
client.once('ready', async () => {
    console.log(`Connecté en tant que ${client.user.tag}`);
    const langRows = db.prepare('SELECT * FROM serverLanguages').all();
    for (const row of langRows) serverLanguages.set(row.guildId, row.lang);
    const rows = db.prepare('SELECT * FROM activeMessages').all();
    for (const row of rows) {
        try {
            const channel = await client.channels.fetch(row.channelId);
            const msg = await channel.messages.fetch(row.messageId);
            activeMessages.set(row.channelId, msg);
        } catch { db.prepare('DELETE FROM activeMessages WHERE channelId = ?').run(row.channelId); }
    }
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    // Système hybride : tous les serveurs présents + IDs manuels via .env
    const guildIds = new Set(client.guilds.cache.map(g => g.id));
    if (process.env.EXTRA_GUILD_IDS) {
        process.env.EXTRA_GUILD_IDS.split(',').forEach(id => guildIds.add(id.trim()));
    }
    for (const guildId of guildIds) {
        try {
            await rest.put(
                Routes.applicationGuildCommands(client.user.id, guildId),
                { body: commands }
            );
            console.log(`✅ Commandes enregistrées sur le serveur ${guildId}`);
        } catch (err) {
            console.error(`❌ Erreur serveur ${guildId}:`, err.message);
        }
    }
    console.log('Commandes slash mises à jour !');
    scheduleNextUpdate();
});

// ======== INTERACTIONS ========
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // Bloquer les DMs — commandes serveur uniquement
    if (!interaction.guildId) {
        return interaction.reply({ content: '❌ Ce bot fonctionne uniquement sur les serveurs Discord.', flags: 64 });
    }

    const { commandName } = interaction;
    const channel = interaction.channel;
    const userId = interaction.user.id;
    const guildId = interaction.guildId;
    const lang = serverLanguages.get(guildId) || 'fr';
    const t = translations[lang];

    // Rate limiting
    if (isRateLimited(userId)) {
        return interaction.reply({ content: '⏳ Trop de commandes ! Attendez quelques secondes.', flags: 64 });
    }

    if (commandName === 'langue') {
        if (!isOwner(userId) && !isSubscriber(userId)) return interaction.reply({ content: t.NO_LICENSE, flags: 64 });
        const selected = interaction.options.getString('lang');
        serverLanguages.set(guildId, selected);
        db.prepare('INSERT OR REPLACE INTO serverLanguages (guildId, lang) VALUES (?, ?)').run(guildId, selected);
        await interaction.reply({ content: translations[selected].LANG_SET, flags: 64 });
        return;
    }

    if (commandName === 'stop') {
        if (!isOwner(userId) && !isSubscriber(userId)) return interaction.reply({ content: t.NO_LICENSE, flags: 64 });
        activeMessages.delete(channel.id);
        db.prepare('DELETE FROM activeMessages WHERE channelId = ?').run(channel.id);
        await interaction.reply({ content: t.TIMER_STOPPED, flags: 64 });
        return;
    }

    if (commandName === 'timer') {
        if (!isOwner(userId) && !isSubscriber(userId)) return interaction.reply({ content: t.NO_LICENSE, flags: 64 });
        if (!hasRequiredPermissions(channel)) return interaction.reply({ content: t.NO_PERMS, flags: 64 });

        await interaction.deferReply({ flags: 64 });

        try {
            const now = Date.now();
            const { status, label, dot, countdownLabel, nextChange, timeInCycle } = getCurrentPhaseAndNextChange(now);
            const remaining = nextChange - now;
            const circles = getCircleEmojis(timeInCycle).join(' ');
            const countdown = formatRemaining(remaining, status);
            const nextOpens = getNextOpenings(4);
            const buttons = createOpeningButtons(nextOpens);
            const embed = buildTimerEmbed(t, circles, label, dot, countdownLabel, countdown, status);

            const msg = await channel.send({ embeds: [embed], components: buttons });
            activeMessages.set(channel.id, msg);
            db.prepare('INSERT OR REPLACE INTO activeMessages (channelId, messageId) VALUES (?, ?)').run(channel.id, msg.id);
            await interaction.editReply({ content: t.TIMER_STARTED });
        } catch (err) {
            console.error('Erreur /timer:', err.message);
            if (err.code === 50013) {
                await interaction.editReply({ content: '❌ Permissions insuffisantes dans ce canal. Vérifie que le bot peut envoyer des messages et des embeds.' });
            } else {
                await interaction.editReply({ content: '❌ Une erreur est survenue. Consulte la console.' });
            }
        }
        return;
    }

    if (commandName === 'list') {
        if (!isOwner(userId)) return interaction.reply({ content: '❌ Seul le propriétaire peut utiliser cette commande.', flags: 64 });
        const subs = getSubscribers();
        if (!subs.length) return interaction.reply({ content: '📭 Aucun abonné pour le moment.', flags: 64 });
        const lines = await Promise.all(subs.map(async s => {
            let name = 'Inconnu';
            try { const u = await client.users.fetch(s.userId); name = sanitize(u.username); } catch {}
            return `• **${name}** — \`${s.userId}\` — ${s.free ? 'Gratuit' : 'Licencié'} — ajouté le ${new Date(s.addedAt).toLocaleDateString()}`;
        }));
        await interaction.reply({ content: `📋 **Liste des abonnés (${subs.length}) :**\n${lines.join('\n')}`, flags: 64 });
        return;
    }

    if (commandName === 'adduser') {
        if (!isOwner(userId)) return interaction.reply({ content: '❌ Seul le propriétaire peut utiliser cette commande.', flags: 64 });
        const userIdInput = interaction.options.getString('user_id');
        if (!/^\d+$/.test(userIdInput)) return interaction.reply({ content: '❌ ID Discord invalide.', flags: 64 });
        try {
            const user = await client.users.fetch(userIdInput);
            if (user.bot) return interaction.reply({ content: '❌ Impossible d\'ajouter un bot.', flags: 64 });
            addSubscriber(userIdInput, true);
            await interaction.reply(`✅ ${user.tag} a reçu un accès gratuit !`);
        } catch {
            return interaction.reply({ content: '❌ Utilisateur introuvable.', flags: 64 });
        }
        return;
    }

    if (commandName === 'export') {
        if (!isOwner(userId)) return interaction.reply({ content: '❌ Seul le propriétaire peut utiliser cette commande.', flags: 64 });
        const subs = getSubscribers();
        const rows = await Promise.all(subs.map(async s => {
            let name = 'Inconnu';
            try { const u = await client.users.fetch(s.userId); name = sanitize(u.username); } catch {}
            return `${s.userId},${name},${s.free ? 'free' : 'licensed'},${new Date(s.addedAt).toISOString()}`;
        }));
        const csv = 'userId,username,type,addedAt\n' + rows.join('\n');
        await interaction.reply({ content: `📁 CSV généré :\n\`\`\`csv\n${csv}\n\`\`\``, flags: 64 });
        return;
    }

    if (commandName === 'revoke') {
        if (!isOwner(userId)) return interaction.reply({ content: '❌ Seul le propriétaire peut utiliser cette commande.', flags: 64 });
        const userIdInput = interaction.options.getString('user_id');
        if (!/^\d+$/.test(userIdInput)) return interaction.reply({ content: '❌ ID Discord invalide.', flags: 64 });
        if (!isSubscriber(userIdInput)) return interaction.reply({ content: `❌ Cet utilisateur n'a pas d'accès.`, flags: 64 });
        removeSubscriber(userIdInput);
        await interaction.reply(`✅ Accès retiré à l'utilisateur ${userIdInput}.`);
        return;
    }

    if (commandName === 'servers') {
        if (!isOwner(userId)) return interaction.reply({ content: '❌ Seul le propriétaire peut utiliser cette commande.', flags: 64 });
        const guilds = client.guilds.cache.map(g => `• **${g.name}** — \`${g.id}\``);
        const extraIds = process.env.EXTRA_GUILD_IDS ? process.env.EXTRA_GUILD_IDS.split(',').map(id => id.trim()) : [];
        const extraList = extraIds.length ? `\n\n📌 **IDs manuels (.env) :**\n${extraIds.map(id => `• \`${id}\``).join('\n')}` : '';
        await interaction.reply({ content: `🌐 **Serveurs connectés (${guilds.length}) :**\n${guilds.join('\n')}${extraList}`, flags: 64 });
        return;
    }

    if (commandName === 'revoke-server') {
        if (!isOwner(userId)) return interaction.reply({ content: '❌ Seul le propriétaire peut utiliser cette commande.', flags: 64 });
        const serverIdInput = interaction.options.getString('server_id');
        if (!/^\d+$/.test(serverIdInput)) return interaction.reply({ content: '❌ ID de serveur invalide.', flags: 64 });

        const guild = client.guilds.cache.get(serverIdInput);
        if (!guild) return interaction.reply({ content: `❌ Le bot n'est pas sur le serveur \`${serverIdInput}\`.`, flags: 64 });

        if (guild.id === interaction.guildId) return interaction.reply({ content: '❌ Impossible de quitter le serveur depuis lequel tu envoies la commande.', flags: 64 });

        const guildName = guild.name;
        try {
            await guild.leave();
            console.log(`✅ Bot retiré du serveur ${guildName} (${serverIdInput})`);
            await interaction.reply({ content: `✅ Le bot a quitté le serveur **${guildName}** (\`${serverIdInput}\`).`, flags: 64 });
        } catch (err) {
            console.error('Erreur revoke-server:', err.message);
            await interaction.reply({ content: `❌ Impossible de quitter le serveur : ${err.message}`, flags: 64 });
        }
        return;
    }
});

// ======== GLOBAL ERROR HANDLER ========
client.on('error', err => {
    if (err.code === 10062) return; // Unknown interaction — ignoré
    if (err.code === 40060) return; // Already acknowledged — ignoré
    console.error('Erreur client Discord:', err.message);
});
process.on('unhandledRejection', (err) => {
    if (err?.code === 10062) return; // Unknown interaction — ignoré
    if (err?.code === 40060) return; // Already acknowledged — ignoré
    console.error('Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
    if (err?.code === 10062) return; // Unknown interaction — ignoré
    console.error('Uncaught exception:', err);
});

// ======== LOGIN ========
if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_OWNER_ID) {
    console.error('Variables .env manquantes !');
    process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);
