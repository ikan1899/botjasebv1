const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const os = require('os');
const chalk = require('chalk');

const DATA_FILE = 'data.json';
const chatSessions = {}; // Untuk mengelola sesi chat antara user dan owner

// Pastikan file config.js ada dan berisi variabel-variabel ini
const {
  BOT_TOKEN,
  OWNER_IDS,
  CHANNEL_USERNAME,
  DEVELOPER,
  VERSION,
  CHANNEL_URL,
  SHARE_FOOTER,
  MENU_IMAGES
} = require('./config.js');

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const BOT_START_TIME = Date.now();

// Default data structure for data.json
const defaultData = {
  premium: {},
  owner: [], // Additional owners, main owners are from OWNER_IDS in config.js
  groups: [],
  users: [],
  blacklist: [],
  user_group_count: {},
  settings: {
    cooldown: {
      default: 15 // Default cooldown in minutes
    }
  },
  cooldowns: {
    share: {},
    broadcast: {}
  }
};

// --- Penanganan Error Global ---
process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION! 💥');
  console.error('Alasan:', reason instanceof Error ? reason.message : reason);
  console.error('Stack:', reason instanceof Error ? reason.stack : 'No stack available');
  // Pertimbangkan untuk menambahkan logging yang lebih canggih di sini
  // atau menghentikan proses secara graceful jika ini adalah kesalahan fatal.
  // Misalnya, kirim notifikasi ke owner utama
  if (OWNER_IDS && OWNER_IDS[0]) {
    bot.sendMessage(OWNER_IDS[0], `⚠️ Bot mengalami UNHANDLED REJECTION!\nAlasan: ${reason instanceof Error ? reason.message : reason}`).catch(err => console.error("Error mengirim notifikasi unhandledRejection ke owner:", err.message));
  }
});

// --- Fungsi Utilitas ---

// Fungsi untuk mendapatkan uptime bot
const getUptime = () => {
  const uptimeSeconds = process.uptime();
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = Math.floor(uptimeSeconds % 60);

  return `${hours}h ${minutes}m ${seconds}s`;
};

// Fungsi untuk mendapatkan gambar acak dari MENU_IMAGES
function getRandomImage() {
  return MENU_IMAGES[Math.floor(Math.random() * MENU_IMAGES.length)];
}

// Fungsi untuk memuat data dari data.json (asinkron)
async function loadData() {
  try {
    const file = await fs.promises.readFile(DATA_FILE, 'utf8');
    const loaded = JSON.parse(file);
    // Gabungkan dengan defaultData untuk memastikan semua kunci ada
    return { ...defaultData, ...loaded };
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn(`⚠️ ${DATA_FILE} tidak ditemukan. Membuat dengan data default.`);
      await saveData(defaultData); // Simpan data default secara asinkron
      return defaultData;
    }
    console.error(`❌ Error memuat ${DATA_FILE}:`, error.message);
    return defaultData;
  }
}

// Fungsi untuk menyimpan data ke data.json (asinkron)
async function saveData(data) {
  try {
    await fs.promises.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(`❌ Error menyimpan ${DATA_FILE}:`, error.message);
  }
}

// Check if a user is a main owner
function isMainOwner(id) {
  return OWNER_IDS.map(String).includes(String(id));
}

// Check if a user is an additional owner
async function isAdditionalOwner(id) {
  const data = await loadData(); // Pastikan ini juga asinkron
  return Array.isArray(data.owner) && data.owner.map(String).includes(String(id));
}

// Check if a user is any type of owner
async function isAnyOwner(id) {
  return isMainOwner(id) || (await isAdditionalOwner(id)); // Panggil isAdditionalOwner secara asinkron
}

// Check if a user has premium access
async function isPremium(id) {
  const data = await loadData(); // Pastikan ini juga asinkron
  const exp = data.premium[id];
  if (!exp) return false;
  if (exp === 'permanent') return true; // Handle permanent premium
  const nowSec = Math.floor(Date.now() / 1000);
  return nowSec < exp;
}

// Get global cooldown in minutes
async function getGlobalCooldownMinutes() {
  const data = await loadData(); // Pastikan ini juga asinkron
  return data.settings?.cooldown?.default || 15; // Default to 15 if not set
}

// Get global cooldown in milliseconds
async function getGlobalCooldownMs() {
  return (await getGlobalCooldownMinutes()) * 60 * 1000; // Panggil getGlobalCooldownMinutes secara asinkron
}

// Middleware to check if user is blacklisted
async function requireNotBlacklisted(msg) {
  const userId = msg.from.id;
  if (await isBlacklisted(userId)) { // Panggil isBlacklisted secara asinkron
    await bot.sendMessage(userId, '🚫 Kamu diblokir dan tidak bisa menggunakan bot ini. Silakan hubungi owner jika ini adalah kesalahan.');
    return false;
  }
  return true;
}

// Check if a user is blacklisted
async function isBlacklisted(userId) {
  const data = await loadData(); // Pastikan ini juga asinkron
  return Array.isArray(data.blacklist) && data.blacklist.map(String).includes(String(userId));
}

// Function to backup data.json
async function backupData() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = './backup';
  const backupPath = `${backupDir}/data-${timestamp}.json`;

  if (!fs.existsSync(backupDir)) {
    try {
      await fs.promises.mkdir(backupDir, { recursive: true }); // Buat direktori secara asinkron
    } catch (err) {
      console.error(`❌ Error membuat direktori backup:`, err.message);
      return null;
    }
  }

  if (!fs.existsSync(DATA_FILE)) {
    console.warn(`⚠️ ${DATA_FILE} tidak ditemukan, tidak dapat membuat backup.`);
    return null;
  }
  try {
    const content = await fs.promises.readFile(DATA_FILE); // Baca file secara asinkron
    await fs.promises.writeFile(backupPath, content); // Tulis file secara asinkron
    return backupPath;
  } catch (error) {
    console.error(`❌ Error membuat backup:`, error.message);
    return null;
  }
}

// --- Event Handlers ---

// Handle new chat members or members leaving
bot.on("my_chat_member", async (msg) => {
  try {
    const data = await loadData(); // Muat data secara asinkron
    const chat = msg.chat || msg.chat_member?.chat;
    const user = msg.from;
    const status = msg.new_chat_member?.status;
    const chatId = chat?.id;
    const userId = user?.id;

    if (!chat || !user || !status || !chatId || !userId) return;

    const isGroup = chat.type === "group" || chat.type === "supergroup";
    const mainOwner = OWNER_IDS[0];

    // Ensure data structures exist
    if (!data.groups) data.groups = [];
    if (!data.user_group_count) data.user_group_count = {};
    if (!data.premium) data.premium = {};

    const minGroupPermanent = 10; // Minimum groups for permanent premium
    const premHariPerGroup = 2; // 2 days premium per group

    // === BOT DITAMBAHKAN ===
    if (["member", "administrator"].includes(status)) {
      if (isGroup && !data.groups.includes(chatId)) {
        data.groups.push(chatId);

        data.user_group_count[userId] = (data.user_group_count[userId] || 0) + 1;
        const totalGroupsAddedByUser = data.user_group_count[userId];

        let memberCount = 0;
        try {
          memberCount = await bot.getChatMemberCount(chatId);
        } catch (err) {
          console.error(`Error mendapatkan jumlah member chat untuk ${chatId}:`, err.message);
          memberCount = 0;
        }

        if (memberCount >= 20) {
          const nowSec = Math.floor(Date.now() / 1000);
          let premiumMessage = "";

          if (totalGroupsAddedByUser >= minGroupPermanent) {
            data.premium[userId] = "permanent";
            premiumMessage = `🎉 Kamu berhasil menambahkan bot ke ${totalGroupsAddedByUser} grup!\n✨ Premium aktif *PERMANEN*!`;
          } else {
            const durasiDetik = premHariPerGroup * 86400; // 2 days in seconds
            const currentPremiumExp = data.premium[userId] === "permanent" ? nowSec : (data.premium[userId] || nowSec);
            data.premium[userId] = currentPremiumExp > nowSec ? currentPremiumExp + durasiDetik : nowSec + durasiDetik;
            premiumMessage = `🎉 Kamu berhasil menambahkan bot ke ${totalGroupsAddedByUser} grup (dengan ≥20 member).\n✨ Premium aktif *${premHariPerGroup} hari*!`;
          }

          // Notify user
          await bot.sendMessage(userId, premiumMessage, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim notifikasi premium ke user:", err.message));

          const info = `
🤖 Bot ditambahkan ke grup baru!

👤 User: [${user.first_name}](tg://user?id=${userId})
🪪 Username: @${user.username || "-"}
🆔 ID User: \`${userId}\`

👥 Grup: ${chat.title}
🆔 ID Grup: \`${chatId}\`

📊 Total Grup Ditambahkan: ${totalGroupsAddedByUser}
👥 Member Grup: ${memberCount}
`.trim();

          await bot.sendMessage(mainOwner, info, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim notifikasi owner:", err.message));

          const backupPath = await backupData(); // Buat backup secara asinkron
          if (backupPath) {
            await bot.sendDocument(mainOwner, backupPath, {}, { filename: "data-backup.json" }).catch(err => console.error("Error mengirim backup ke owner:", err.message));
          }
        } else {
          await bot.sendMessage(
            userId,
            `⚠️ Grup *${chat.title}* hanya punya ${memberCount} member.\n❌ Minimal 20 member diperlukan untuk mendapatkan akses premium.`,
            { parse_mode: "Markdown" }
          ).catch(err => console.error("Error mengirim peringatan jumlah member:", err.message));
        }

        await saveData(data); // Simpan data secara asinkron
      }
    }

    // === BOT DIKELUARKAN ===
    if (["left", "kicked", "banned", "restricted"].includes(status)) {
      if (isGroup && data.groups.includes(chatId)) {
        data.groups = data.groups.filter((id) => id !== chatId);

        if (data.user_group_count[userId]) {
          data.user_group_count[userId]--;

          if (data.user_group_count[userId] < minGroupPermanent) {
            if (data.premium[userId] !== "permanent") { // Only revoke if not permanent
              delete data.premium[userId];
              await bot.sendMessage(
                userId,
                `❌ Kamu menghapus bot dari grup.\n✨ Akses Premium otomatis dicabut.`,
              ).catch(err => console.error("Error mengirim notifikasi premium dicabut:", err.message));
            }
          }
        }

        let memberCount = 0;
        try {
          memberCount = await bot.getChatMemberCount(chatId);
        } catch (err) {
          console.error(`Error mendapatkan jumlah member chat untuk ${chatId}:`, err.message);
          memberCount = 0;
        }

        const info = `
⚠️ Bot dikeluarkan dari grup!

👤 User: [${user.first_name}](tg://user?id=${userId})
🪪 Username: @${user.username || "-"}
🆔 ID User: \`${userId}\`

👥 Grup: ${chat.title}
🆔 ID Grup: \`${chatId}\`

📊 Total Grup Saat Ini: ${data.user_group_count[userId] || 0}
👥 Member Grup: ${memberCount}
`.trim();

        await bot.sendMessage(mainOwner, info, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim notifikasi owner (bot dihapus):", err.message));

        const backupPath = await backupData(); // Buat backup secara asinkron
        if (backupPath) {
          await bot.sendDocument(mainOwner, backupPath, {}, { filename: "data-backup.json" }).catch(err => console.error("Error mengirim backup ke owner (bot dihapus):", err.message));
        }

        await saveData(data); // Simpan data secara asinkron
      }
    }
  } catch (err) {
    console.error("❌ Error di event my_chat_member:", err);
  }
});

// Check premium expiration every minute
setInterval(async () => { // Gunakan async di sini
  const data = await loadData(); // Muat data secara asinkron
  const now = Math.floor(Date.now() / 1000);

  for (const uid in data.premium) {
    if (data.premium[uid] !== "permanent" && data.premium[uid] <= now) {
      delete data.premium[uid];
      console.log(`✨ Premium expired & dicabut untuk ${uid}`);

      await bot.sendMessage(uid, "⚠️ Masa aktif Premium kamu sudah *expired*.", {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: `👑 Beli Akses`, url: `https://t.me/${DEVELOPER.replace('@', '')}` }]
          ]
        }
      }).catch(err => console.error(`Error mengirim pesan premium expired ke ${uid}:`, err.message));
    }
  }

  await saveData(data); // Simpan data secara asinkron
}, 60 * 1000); // Check every minute

// Check channel membership
async function checkChannelMembership(userId) {
  try {
    const chatMember = await bot.getChatMember(CHANNEL_USERNAME, userId);
    return ["member", "administrator", "creator"].includes(chatMember.status);
  } catch (err) {
    console.error(`Error memeriksa keanggotaan channel untuk user ${userId}:`, err.message);
    return false;
  }
}

// Middleware to require channel join
async function requireJoin(msg) {
  const userId = msg.from.id;
  const isMember = await checkChannelMembership(userId);

  if (!isMember) {
    await bot.sendMessage(userId, `👋 *Kamu belum bergabung dengan Channel!* Silakan bergabung untuk menggunakan bot ini.`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: `📣 Gabung Channel`, url: `https://t.me/${CHANNEL_USERNAME.replace('@', '')}` }],
          [{ text: `✅ Coba Lagi`, callback_data: "check_join_again" }]
        ]
      }
    }).catch(err => console.error("Error mengirim pesan gabung channel:", err.message));
    return false;
  }
  return true;
}

// Higher-order function to apply requireJoin middleware
function withRequireJoin(handler) {
  return async (msg, match) => {
    const ok = await requireJoin(msg);
    if (!ok) return;
    return handler(msg, match);
  };
}

// Callback query handler for "check_join_again"
bot.on("callback_query", async (query) => {
  const userId = query.from.id;

  if (query.data === "check_join_again") {
    const isMember = await checkChannelMembership(userId);

    if (isMember) {
      await bot.sendMessage(userId, '✅ Terima kasih, Anda sudah bergabung dengan channel!');
    } else {
      await bot.sendMessage(
        userId,
        '❌ Anda belum bergabung dengan channel. Silakan bergabung terlebih dahulu.'
      );
    }

    await bot.answerCallbackQuery(query.id).catch(err => console.error("Error menjawab callback query:", err.message));
  }
});

const activeMenus = {}; // To store message_id of active menus for deletion

// Function to replace the current menu message
async function replaceMenu(chatId, caption, buttons) {
  try {
    if (activeMenus[chatId]) {
      try {
        await bot.deleteMessage(chatId, activeMenus[chatId]);
      } catch (e) {
        // Ignore error if message is already deleted or not found
        if (!e.message.includes("message to delete not found")) {
          console.warn(`⚠️ Tidak dapat menghapus pesan menu sebelumnya di chat ${chatId}:`, e.message);
        }
      }
      delete activeMenus[chatId];
    }

    // Send new message
    const sent = await bot.sendPhoto(chatId, getRandomImage(), {
      caption,
      parse_mode: "HTML",
      reply_markup: buttons
    });

    activeMenus[chatId] = sent.message_id;
  } catch (err) {
    console.error("❌ Error di replaceMenu:", err);
  }
}

// ==================== START ====================
bot.onText(/\/start/, withRequireJoin(async (msg) => {
  if (!(await requireNotBlacklisted(msg))) return;
  const data = await loadData(); // Muat data secara asinkron
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const waktuRunPanel = getUptime();
  const username = msg.from.username ? `@${msg.from.username}` : "Tidak ada username";
  if ((msg.date * 1000) < BOT_START_TIME) return; // Ignore old messages

  if (!data.users.includes(userId)) {
    data.users.push(userId);
    await saveData(data); // Simpan data secara asinkron
  }

  const caption = `
<blockquote>( 🍁 ) - 情報 𝗢𝗹𝗮𝗮 ${username}</blockquote>
Ｊａｓｅｂ ─ Ｔｅｌｅｇｒａｍ ボットは、速く柔軟で安全な自動化ツール。デジタルタスクを
┌────────>
│ 𝐈𝐧𝐟𝐨𝐫𝐦𝐚𝐬𝐢 ☇ 𝐁𝐨𝐭 ° 𝐉𝐚𝐬𝐞𝐛
├⬡ Author : ${DEVELOPER} 〽️
├⬡ Versi : ${VERSION}
├⬡ Grup Count : ${data.groups.length}
├⬡ Users Count : ${data.users.length}
├⬡ Channel : <a href="https://t.me/gudel021">Gabung Channel</a>
├⬡ Time Bot : ${waktuRunPanel}
└────>
<blockquote>Created By <a href="https://t.me/gudel023">gudel023</a></blockquote>
`.trim();

  await replaceMenu(chatId, caption, {
    keyboard: [
      [{ text: "⚙️ Jasher Menu" }, { text: "🔥 Plans Free" }],
      [{ text: "👑 Plans Owner" }, { text: "📞 Contact Owner" }],
      [{ text: "🛠️ Tools Menu" }, { text: "💬 Hubungi Owner" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  });
}));

// ==================== HUBUNGI ADMIN (SESSION) ====================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = msg.text;
  const data = await loadData(); // Muat data secara asinkron
  const waktuRunPanel = getUptime();
  const username = msg.from.username ? `@${msg.from.username}` : "Tidak ada username";
  const ownerIdUtama = OWNER_IDS[0];

  // Delete message if it's a menu button press to keep chat clean
  if (["🔙 Kembali", "⚙️ Jasher Menu", "👑 Plans Owner", "🔥 Plans Free", "🛠️ Tools Menu", "📞 Contact Owner", "💬 Hubungi Owner"].includes(text)) {
    await bot.deleteMessage(chatId, msg.message_id).catch(err => console.warn(`Tidak dapat menghapus pesan tombol menu di chat ${chatId}:`, err.message));
  }

  // ==================== MAIN MENU ====================
  if (text === "🔙 Kembali") {
    const caption = `
<blockquote>( 🍁 ) - 情報 𝗢𝗹𝗮𝗮 ${username}</blockquote>
Ｊａｓｅｂ ─ Ｔｅｌｅｇｒａｍ ボットは、速く柔軟で安全な自動化ツール。デジタルタスクを
┌────────>
│ 𝐈𝐧𝐟𝐨𝐫𝐦𝐚𝐬𝐢 ☇ 𝐁𝐨𝐭 ° 𝐉𝐚𝐬𝐞𝐛
├⬡ Author : ${DEVELOPER} 〽️
├⬡ Versi : ${VERSION}
├⬡ Grup Count : ${data.groups.length}
├⬡ Users Count : ${data.users.length}
├⬡ Channel : <a href="https://t.me/gudel021">Gabung Channel</a>
├⬡ Time Bot : ${waktuRunPanel}
└────>
<blockquote>Created By <a href="https://t.me/gudel023">gudel023</a></blockquote>
`.trim();
    return await replaceMenu(chatId, caption, {
      keyboard: [
        [{ text: "⚙️ Jasher Menu" }, { text: "🔥 Plans Free" }],
        [{ text: "👑 Plans Owner" }, { text: "📞 Contact Owner" }],
        [{ text: "🛠️ Tools Menu" }, { text: "💬 Hubungi Owner" }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    });
  }

  // ==================== OWNER ====================
  if (text === "📞 Contact Owner") {
    return await bot.sendMessage(chatId, `📞 Anda dapat menghubungi Owner di: ${DEVELOPER}`).catch(err => console.error("Error mengirim pesan kontak owner:", err.message));
  }

  // ==================== 👑 Plans Owner ====================
  if (text === "👑 Plans Owner") {
    if (!isMainOwner(userId)) {
      return await bot.sendMessage(chatId, "🚫 Maaf, hanya Owner Utama yang dapat mengakses menu ini.").catch(err => console.error("Error mengirim pesan khusus owner:", err.message));
    }
    const caption = `
<blockquote>( 🍁 ) - 情報 𝗢𝗹𝗮𝗮 ${username}</blockquote>
Ｊａｓｅｂ ─ Ｔｅｌｅｇｒａｍ ボットは、速く柔軟で安全な自動化ツール。デジタルタスクを
┌────────>
│ 𝐈𝐧𝐟𝐨𝐫𝐦𝐚𝐬𝐢 ☇ 𝐁𝐨𝐭 ° 𝐉𝐚𝐬𝐞𝐛
├⬡ Author : ${DEVELOPER} 〽️
├⬡ Versi : ${VERSION}
├⬡ Grup Count : ${data.groups.length}
├⬡ Users Count : ${data.users.length}
├⬡ Channel : <a href="https://t.me/gudel021">Gabung Channel</a>
├⬡ Time Bot : ${waktuRunPanel}
└────>
<blockquote>💎 Plans Owner Commands</blockquote>
• <code>/addownjs &lt;id&gt;</code> - Tambah owner tambahan
• <code>/delownjs &lt;id&gt;</code> - Hapus owner tambahan
• <code>/listownjs</code> - Daftar owner tambahan
• <code>/addakses &lt;id&gt; &lt;durasi&gt;[d/h]</code> - Tambah akses premium
• <code>/delakses &lt;id&gt;</code> - Hapus akses premium
• <code>/listakses</code> - Daftar user premium
<blockquote>Created By <a href="https://t.me/gudel023">gudel023</a></blockquote>
`.trim();
    return await replaceMenu(chatId, caption, {
      keyboard: [[{ text: "🔙 Kembali" }]],
      resize_keyboard: true,
      one_time_keyboard: false
    });
  }

  // ==================== 🛠️ Tools Menu ====================
  if (text === "🛠️ Tools Menu") {
    if (!isMainOwner(userId)) {
      return await bot.sendMessage(chatId, "🚫 Maaf, hanya Owner Utama yang dapat mengakses menu ini.").catch(err => console.error("Error mengirim pesan khusus owner:", err.message));
    }
    const caption = `
<blockquote>( 🍁 ) - 情報 𝗢𝗹𝗮𝗮 ${username}</blockquote>
Ｊａｓｅｂ ─ Ｔｅｌｅｇｒａｍ ボットは、速く柔軟で安全な自動化ツール。デジタルタスクを
┌────────>
│ 𝐈𝐧𝐟𝐨𝐫𝐦𝐚𝐬𝐢 ☇ 𝐁𝐨𝐭 ° 𝐉𝐚𝐬𝐞𝐛
├⬡ Author : ${DEVELOPER} 〽️
├⬡ Versi : ${VERSION}
├⬡ Grup Count : ${data.groups.length}
├⬡ Users Count : ${data.users.length}
├⬡ Channel : <a href="https://t.me/gudel021">Gabung Channel</a>
├⬡ Time Bot : ${waktuRunPanel}
└────>
<blockquote>🧩 Tools Menu Commands</blockquote>
• <code>/addbl &lt;id&gt;</code> - Tambah user ke blacklist
• <code>/delbl &lt;id&gt;</code> - Hapus user dari blacklist
• <code>/listbl</code> - Daftar user blacklist
• <code>/ping</code> - Cek status bot dan server
• <code>/cekid</code> - Cek ID Telegram Anda
• <code>/backup</code> - Buat backup data bot
• <code>/setjeda &lt;menit&gt;</code> - Atur jeda global untuk share/broadcast
<blockquote>Created By <a href="https://t.me/gudel023">gudel023</a></blockquote>
`.trim();
    return await replaceMenu(chatId, caption, {
      keyboard: [[{ text: "🔙 Kembali" }]],
      resize_keyboard: true,
      one_time_keyboard: false
    });
  }

  // ==================== ⚙️ Jasher Menu ====================
  if (text === "⚙️ Jasher Menu") {
    const caption = `
<blockquote>( 🍁 ) - 情報 𝗢𝗹𝗮ａ ${username}</blockquote>
Ｊａｓｅｂ ─ Ｔｅｌｅｇｒａｍ ボットは、速く柔軟で安全な自動化ツール。デジタルタスクを
┌────────>
│ 𝐈𝐧𝐟𝐨𝐫𝐦𝐚𝐬𝐢 ☇ 𝐁𝐨𝐭 ° 𝐉𝐚𝐬𝐞𝐛
├⬡ Author : ${DEVELOPER} 〽️
├⬡ Versi : ${VERSION}
├⬡ Grup Count : ${data.groups.length}
├⬡ Users Count : ${data.users.length}
├⬡ Channel : <a href="https://t.me/gudel021">Gabung Channel</a>
├⬡ Time Bot : ${waktuRunPanel}
└────>
<blockquote>✨ Jasher Menu Commands</blockquote>
• <code>/sharemsg</code> - Bagikan pesan ke semua grup (reply pesan)
• <code>/broadcast</code> - Broadcast pesan ke semua user (reply pesan)
• <code>/sharemsgv2</code> - Forward pesan ke semua grup (reply pesan)
• <code>/broadcastv2</code> - Forward pesan ke semua user (reply pesan)
<blockquote>Created By <a href="https://t.me/gudel023">gudel023</a></blockquote>
`.trim();
    return await replaceMenu(chatId, caption, {
      keyboard: [[{ text: "🔙 Kembali" }]],
      resize_keyboard: true,
      one_time_keyboard: false
    });
  }

  // ==================== 🔥 Plans Free ====================
  if (text === "🔥 Plans Free") {
    const caption = `
<blockquote>( 🍁 ) - 情報 𝗢𝗹𝗮𝗮 ${username}</blockquote>
Ｊａｓｅｂ ─ Ｔｅｌｅｇｒａｍ ボットは、速く柔軟で安全な自動化ツール。デジタルタスクを
┌────────>
│ 𝐈𝐧𝐟𝐨𝐫𝐦𝐚𝐬𝐢 ☇ 𝐁𝐨𝐭 ° 𝐉𝐚𝐬𝐞𝐛
├⬡ Author : ${DEVELOPER} 〽️
├⬡ Versi : ${VERSION}
├⬡ Grup Count : ${data.groups.length}
├⬡ Users Count : ${data.users.length}
├⬡ Channel : <a href="https://t.me/gudel021">Gabung Channel</a>
├⬡ Time Bot : ${waktuRunPanel}
└────>
<blockquote>⚡ PLANS FREE</blockquote>
┌─ ⧼ 𝗖𝗔𝗥𝗔 𝗗𝗔𝗣𝗔𝗧𝗜𝗡 𝗣𝗥𝗘𝗠 ⧽
├ 𝙼𝙰𝚂𝚄𝙺𝙸𝙽 𝙱𝙾𝚃 𝙺𝙴 𝙶𝚁𝚄𝙱 𝙼𝙸𝙽𝙸𝙼𝙰𝙻 2 𝙶𝚁𝚄𝙿
├ 𝙹𝙸𝙺𝙰 𝚂𝚄𝙳𝙰𝙷 𝙺𝙰𝙻𝙸𝙰𝙽 𝙱𝙰𝙺𝙰𝙻 𝙳𝙰𝙿𝙴𝚃 𝙰𝙺𝚂𝙴𝚂 𝙿𝚁𝙴𝙼 𝙾𝚃𝙾𝙼𝙰𝚃𝙸𝚂
├ 𝙳𝙰𝙽 𝙻𝚄 𝚃𝙸𝙽𝙶𝙶𝙰𝙻 𝙺𝙴𝚃𝙸𝙺 𝚈𝙰𝙽𝙶 𝙼𝙰𝚄 𝙳𝙸 𝚂𝙷𝙴𝚁𝙴
├ 𝙳𝙰𝙽 𝙻𝚄 𝚃𝙸𝙽𝙶𝙶𝙰𝙻 𝚁𝙴𝙿𝙻𝚈 𝚃𝙴𝙺𝚂 𝙽𝚈𝙰 𝙺𝙴𝚃𝙸𝙺 /𝚂𝙷𝙰𝚁𝙴𝙼𝚂𝙶
╰────────────────────
┌─ ⧼ 𝗣𝗘𝗥𝗔𝗧𝗨𝗥𝗔𝗡‼️ ⧽
├ 𝙹𝙸𝙺𝙰 𝙱𝙾𝚃 𝚂𝚄𝙳𝙰𝙷 𝙱𝙴𝚁𝙶𝙰𝙱𝚄𝙽𝙶
├ 𝙳𝙰𝙽 𝙰𝙽𝙳𝙰 𝙼𝙴𝙽𝙶𝙴𝙻𝚄𝙰𝚁𝙺𝙰𝙽 𝙽𝚈𝙰
├ 𝙱𝙾𝚃 𝙰𝙺𝙰𝙽 𝙾𝚃𝙾𝙼𝙰𝚃𝙸𝚂 𝙼𝙴𝙽𝙶𝙷𝙰𝙿𝚄𝚂 𝙰𝙺𝚂𝙴𝚂 𝙿𝚁𝙴𝙼
├ 𝙹𝙰𝙽𝙶𝙰𝙽 𝙳𝙸 𝚂𝙿𝙰𝙼 𝙱𝙾𝚃 𝙽𝚈𝙰 𝙺𝙾𝙽𝚃𝙾𝙻
├ 𝙷𝙰𝚁𝙰𝙿 𝙳𝙸 𝙿𝙰𝚃𝚄𝙷𝙸 ‼️
╰────────────────────
<blockquote>CREATED BY @gudel023</blockquote>
`.trim();
    return await replaceMenu(chatId, caption, {
      keyboard: [[{ text: "🔙 Kembali" }]],
      resize_keyboard: true,
      one_time_keyboard: false
    });
  }

  // ==================== HUBUNGI ADMIN SESSION ====================
  if (text === "💬 Hubungi Owner") {
    chatSessions[userId] = { active: true, ownerId: ownerIdUtama };

    await bot.sendMessage(chatId, "✅ Anda sekarang terhubung dengan Admin.\nKetik pesan Anda di sini.\n\nKetik ❌ BATALKAN untuk mengakhiri sesi.", {
      reply_markup: {
        keyboard: [[{ text: "❌ BATALKAN" }]],
        resize_keyboard: true,
        one_time_keyboard: false
      }
    }).catch(err => console.error("Error mengirim pesan mulai sesi 'hubungi owner':", err.message));

    return await bot.sendMessage(ownerIdUtama, `👤 User <a href="tg://user?id=${userId}">${msg.from.first_name}</a> memulai sesi chat.`, { parse_mode: "HTML" }).catch(err => console.error("Error memberitahu owner tentang sesi chat baru:", err.message));
  }

  // ==================== BATALKAN DARI USER ====================
  if (text === "❌ BATALKAN" && chatSessions[userId]?.active) {
    const ownerId = chatSessions[userId].ownerId;
    delete chatSessions[userId];

    await bot.sendMessage(chatId, "❌ Sesi chat dengan Admin ditutup.", {
      reply_markup: { remove_keyboard: true }
    }).catch(err => console.error("Error mengirim pesan 'sesi dibatalkan' ke user:", err.message));

    const caption = `
<blockquote>( 🍁 ) - 情報 𝗢𝗹𝗮𝗮 ${username}</blockquote>
Ｊａｓｅｂ ─ Ｔｅｌｅｇｒａｍ ボットは、速く柔軟で安全な自動化ツール。デジタルタスクを
┌────────>
│ 𝐈𝐧𝐟𝐨𝐫𝐦𝐚𝐬𝐢 ☇ 𝐁𝐨𝐭 ° 𝐉𝐚𝐬𝐞𝐛
├⬡ Author : ${DEVELOPER} 〽️
├⬡ Versi : ${VERSION}
├⬡ Grup Count : ${data.groups.length}
├⬡ Users Count : ${data.users.length}
├⬡ Channel : <a href="https://t.me/gudel021">Gabung Channel</a>
├⬡ Time Bot : ${waktuRunPanel}
└────>
<blockquote>Created By <a href="https://t.me/gudel023">gudel023</a></blockquote>
`.trim();
    await replaceMenu(chatId, caption, {
      keyboard: [
        [{ text: "⚙️ Jasher Menu" }, { text: "🔥 Plans Free" }],
        [{ text: "👑 Plans Owner" }, { text: "📞 Contact Owner" }],
        [{ text: "🛠️ Tools Menu" }, { text: "💬 Hubungi Owner" }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    });

    return await bot.sendMessage(ownerId, `👋 User <a href="tg://user?id=${userId}">${msg.from.first_name}</a> menutup sesi chat.`, { parse_mode: "HTML" }).catch(err => console.error("Error memberitahu owner tentang akhir sesi:", err.message));
  }

  // ==================== CHAT SESSION (USER TO OWNER) ====================
  if (chatSessions[userId]?.active) {
    const ownerId = chatSessions[userId].ownerId;
    await bot.forwardMessage(ownerId, chatId, msg.message_id).catch(err => console.error("Error meneruskan pesan user ke owner:", err.message));
    return await bot.sendMessage(chatId, "✔️ Pesan Anda berhasil terkirim ke Admin.").catch(err => console.error("Error mengkonfirmasi pesan terkirim ke owner:", err.message));
  }

  // ==================== CHAT SESSION (OWNER TO USER) ====================
  if (isMainOwner(userId) && msg.reply_to_message) {
    const fwdFrom = msg.reply_to_message.forward_from;
    if (fwdFrom) {
      const targetUserId = String(fwdFrom.id);
      if (chatSessions[targetUserId]?.active) {
        try {
          if (msg.text) {
            await bot.sendMessage(targetUserId, msg.text);
          } else if (msg.photo) {
            await bot.sendPhoto(targetUserId, msg.photo[msg.photo.length - 1].file_id, { caption: msg.caption || "" });
          } else if (msg.voice) {
            await bot.sendVoice(targetUserId, msg.voice.file_id, { caption: msg.caption || "" });
          } else if (msg.document) {
            await bot.sendDocument(targetUserId, msg.document.file_id, { caption: msg.caption || "" });
          } else if (msg.sticker) { // Added sticker forwarding
            await bot.sendSticker(targetUserId, msg.sticker.file_id);
            if (msg.caption) { // If sticker has a caption, send it separately
              await bot.sendMessage(targetUserId, msg.caption, { parse_mode: "Markdown" });
            }
          } else {
            await bot.sendMessage(chatId, "⚠️ Jenis pesan ini belum didukung untuk dibalas otomatis.");
            return; // Skip success message for unsupported types
          }
          return await bot.sendMessage(userId, "✔️ Pesan berhasil terkirim ke user.").catch(err => console.error("Error mengkonfirmasi pesan terkirim ke user:", err.message));
        } catch (err) {
          console.error(`❌ Error mengirim balasan dari owner ke user ${targetUserId}:`, err.message);
          return await bot.sendMessage(userId, `❌ Gagal mengirim pesan ke user ${targetUserId}. Mungkin user telah memblokir bot atau sesi telah berakhir.`).catch(err => console.error("Error mengirim pesan kegagalan balasan owner:", err.message));
        }
      }
    }
  }
});

// ==================== /sharemsg ====================
bot.onText(/^\/sharemsg$/, async (msg) => {
  if (!(await requireNotBlacklisted(msg))) return;
  const senderId = String(msg.from.id);
  const data = await loadData();
  const chatId = msg.chat.id;

  try {
    const isMain = isMainOwner(senderId);
    const isOwnerNow = await isAnyOwner(senderId);
    const isPremiumUser = await isPremium(senderId);
    const groupCount = data.user_group_count?.[senderId] || 0;

    // Adjusted condition for premium access
    if (!isOwnerNow && !isPremiumUser && groupCount < 2) {
      return await bot.sendMessage(chatId, `🚫 Maaf, fitur ini hanya bisa digunakan oleh Owner atau User Premium (dengan minimal 2 grup terdaftar).`).catch(err => console.error("Error mengirim pesan akses ditolak:", err.message));
    }

    if (!data.cooldowns.share) data.cooldowns.share = {};
    const now = Math.floor(Date.now() / 1000);
    const lastUse = data.cooldowns.share[senderId] || 0;
    const cooldown = await getGlobalCooldownMinutes() * 60;

    // Only apply cooldown if not owner or premium
    if (!isMain && !isPremiumUser && (now - lastUse) < cooldown) {
      const sisa = cooldown - (now - lastUse);
      const menit = Math.floor(sisa / 60);
      const detik = sisa % 60;
      return await bot.sendMessage(chatId, `⏳ Harap tunggu *${menit} menit ${detik} detik* sebelum menggunakan /sharemsg lagi.`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan cooldown:", err.message));
    }

    if (!msg.reply_to_message) {
      return await bot.sendMessage(chatId, `⚠️ Harap *reply* ke pesan yang ingin kamu bagikan.`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan 'reply diperlukan':", err.message));
    }

    // Update cooldown only if not owner or premium
    if (!isMain && !isPremiumUser) {
      data.cooldowns.share[senderId] = now;
      await saveData(data);
    }

    const groups = data.groups || [];
    if (groups.length === 0) {
      return await bot.sendMessage(chatId, `⚠️ Tidak ada grup terdaftar untuk share. Bot perlu ditambahkan ke grup terlebih dahulu.`).catch(err => console.error("Error mengirim pesan 'tidak ada grup':", err.message));
    }

    const total = groups.length;
    let sukses = 0, gagal = 0;
    await bot.sendMessage(chatId, `⏳ Memproses sharemsg ke *${total}* grup/channel...`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan proses:", err.message));
    const reply = msg.reply_to_message;

    for (const groupId of groups) {
      try {
        if (reply.text) {
          const messageWithFooter = reply.text + SHARE_FOOTER;
          await bot.sendMessage(groupId, messageWithFooter, { parse_mode: "Markdown" })
            .catch(async err => {
              console.warn(`⚠️ Gagal kirim teks ke ${groupId} (Markdown): ${err.message}. Mencoba tanpa Markdown.`);
              return await bot.sendMessage(groupId, messageWithFooter);
            });
        } else if (reply.photo) {
          const fileId = reply.photo[reply.photo.length - 1].file_id;
          const captionWithFooter = (reply.caption || "") + SHARE_FOOTER;
          await bot.sendPhoto(groupId, fileId, { caption: captionWithFooter, parse_mode: "Markdown" }).catch(err => console.warn(`⚠️ Gagal kirim foto ke ${groupId}:`, err.message));
        } else if (reply.video) {
          const captionWithFooter = (reply.caption || "") + SHARE_FOOTER;
          await bot.sendVideo(groupId, reply.video.file_id, { caption: captionWithFooter, parse_mode: "Markdown" }).catch(err => console.warn(`⚠️ Gagal kirim video ke ${groupId}:`, err.message));
        } else if (reply.document) {
          const captionWithFooter = (reply.caption || "") + SHARE_FOOTER;
          await bot.sendDocument(groupId, reply.document.file_id, { caption: captionWithFooter, parse_mode: "Markdown" }).catch(err => console.warn(`⚠️ Gagal kirim dokumen ke ${groupId}:`, err.message));
        } else if (reply.sticker) {
          await bot.sendSticker(groupId, reply.sticker.file_id).catch(err => console.warn(`⚠️ Gagal kirim stiker ke ${groupId}:`, err.message));
          if (reply.caption) {
            await bot.sendMessage(groupId, reply.caption + SHARE_FOOTER, { parse_mode: "Markdown" });
          }
        } else {
          await bot.sendMessage(chatId, `⚠️ Jenis pesan ini belum didukung untuk sharemsg otomatis.` + SHARE_FOOTER).catch(err => console.error("Error mengirim peringatan jenis pesan tidak didukung:", err.message));
          gagal++;
          continue;
        }
        sukses++;
      } catch (err) {
        gagal++;
        console.error(`❌ Gagal kirim ke ${groupId}: ${err.description || err.message}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    await bot.sendMessage(chatId, `
✔️ Share selesai!
📊 Hasil:
- Total Grup: ${total}
- ✔️ Sukses: ${sukses}
- ❌ Gagal: ${gagal}
    `.trim(), { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan ringkasan share:", err.message));
  } catch (err) {
    console.error(`❌ Error fatal di /sharemsg:`, err);
    await bot.sendMessage(chatId, `⚠️ Terjadi error saat memproses /sharemsg. Silakan coba lagi nanti.`).catch(err => console.error("Error mengirim pesan error fatal:", err.message));
  }
});

// ==================== /broadcast ====================
bot.onText(/^\/broadcast$/, async (msg) => {
  if (!(await requireNotBlacklisted(msg))) return;
  const senderId = String(msg.from.id);
  const data = await loadData();
  const chatId = msg.chat.id;

  try {
    const isOwnerNow = await isAnyOwner(senderId);

    // Condition for broadcast: only additional owners or main owner
    if (!isOwnerNow) {
      return await bot.sendMessage(chatId, `🚫 Maaf, fitur ini hanya bisa digunakan oleh Owner.`).catch(err => console.error("Error mengirim pesan akses ditolak:", err.message));
    }

    if (!data.cooldowns.broadcast) data.cooldowns.broadcast = {};
    const now = Math.floor(Date.now() / 1000);
    const lastUse = data.cooldowns.broadcast[senderId] || 0;
    const cooldown = await getGlobalCooldownMinutes() * 60;

    // Cooldown only for non-main owners
    if (!isMainOwner(senderId) && (now - lastUse) < cooldown) {
      const sisa = cooldown - (now - lastUse);
      const menit = Math.floor(sisa / 60);
      const detik = sisa % 60;
      return await bot.sendMessage(chatId, `⏳ Harap tunggu *${menit} menit ${detik} detik* sebelum menggunakan /broadcast lagi.`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan cooldown:", err.message));
    }

    if (!msg.reply_to_message) {
      return await bot.sendMessage(chatId, `⚠️ Harap *reply* ke pesan yang ingin di-broadcast.`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan 'reply diperlukan':", err.message));
    }

    // Update cooldown only for non-main owners
    if (!isMainOwner(senderId)) {
      data.cooldowns.broadcast[senderId] = now;
      await saveData(data);
    }

    const uniqueUsers = [...new Set(data.users || [])];
    if (uniqueUsers.length === 0) {
      return await bot.sendMessage(chatId, `⚠️ Tidak ada user terdaftar untuk broadcast.`).catch(err => console.error("Error mengirim pesan 'tidak ada user':", err.message));
    }

    const total = uniqueUsers.length;
    let sukses = 0, gagal = 0;
    await bot.sendMessage(chatId, `⏳ Sedang memulai broadcast ke *${total}* user...`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan proses:", err.message));
    const reply = msg.reply_to_message;

    for (const userId of uniqueUsers) {
      try {
        if (reply.text) {
          await bot.sendMessage(userId, reply.text, { parse_mode: "Markdown" }).catch(async err => {
            console.warn(`⚠️ Gagal kirim teks ke ${userId} (Markdown): ${err.message}. Mencoba tanpa Markdown.`);
            return await bot.sendMessage(userId, reply.text);
          });
        } else if (reply.photo) {
          const fileId = reply.photo[reply.photo.length - 1].file_id;
          await bot.sendPhoto(userId, fileId, { caption: reply.caption || "", parse_mode: "Markdown" }).catch(err => console.warn(`⚠️ Gagal kirim foto ke ${userId}:`, err.message));
        } else if (reply.document) {
          await bot.sendDocument(userId, reply.document.file_id, { caption: reply.caption || "", parse_mode: "Markdown" }).catch(err => console.warn(`⚠️ Gagal kirim dokumen ke ${userId}:`, err.message));
        } else if (reply.video) {
          await bot.sendVideo(userId, reply.video.file_id, { caption: reply.caption || "", parse_mode: "Markdown" }).catch(err => console.warn(`⚠️ Gagal kirim video ke ${userId}:`, err.message));
        } else if (reply.sticker) {
          await bot.sendSticker(userId, reply.sticker.file_id).catch(err => console.warn(`⚠️ Gagal kirim stiker ke ${userId}:`, err.message));
          if (reply.caption) {
            await bot.sendMessage(userId, reply.caption, { parse_mode: "Markdown" });
          }
        } else {
          await bot.sendMessage(chatId, `⚠️ Jenis pesan ini belum bisa dibroadcast.`).catch(err => console.error("Error mengirim peringatan jenis pesan tidak didukung:", err.message));
          gagal++;
          continue;
        }
        sukses++;
      } catch (err) {
        gagal++;
        console.error(`❌ Gagal kirim ke ${userId}: ${err.description || err.message}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    await bot.sendMessage(chatId, `
✔️ Broadcast selesai!
📊 Hasil:
- Total User: ${total}
- ✔️ Sukses: ${sukses}
- ❌ Gagal: ${gagal}
    `.trim(), { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan ringkasan broadcast:", err.message));
  } catch (err) {
    console.error(`❌ Error fatal di /broadcast:`, err);
    await bot.sendMessage(chatId, `⚠️ Terjadi error saat memproses /broadcast. Silakan coba lagi nanti.`).catch(err => console.error("Error mengirim pesan error fatal:", err.message));
  }
});

// ==================== /sharemsgv2 ====================
bot.onText(/^\/sharemsgv2$/, async (msg) => {
  if (!(await requireNotBlacklisted(msg))) return;
  const senderId = String(msg.from.id);
  const data = await loadData();
  const chatId = msg.chat.id;

  try {
    const isOwnerNow = await isAnyOwner(senderId);
    const isPremiumUser = await isPremium(senderId);
    const isMainOwnerFlag = isMainOwner(senderId);

    // Condition for sharemsgv2: only premium users, additional owners, or main owner
    if (!isOwnerNow && !isPremiumUser) {
      return await bot.sendMessage(chatId, `🚫 Maaf, fitur ini hanya bisa digunakan oleh Owner atau User Premium.`).catch(err => console.error("Error mengirim pesan akses ditolak:", err.message));
    }

    if (!msg.reply_to_message) {
      return await bot.sendMessage(chatId, `⚠️ Harap *reply* ke pesan yang ingin kamu forward.`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan 'reply diperlukan':", err.message));
    }

    const groups = data.groups || [];
    if (groups.length === 0) {
      return await bot.sendMessage(chatId, `⚠️ Tidak ada grup terdaftar untuk forward. Bot perlu ditambahkan ke grup terlebih dahulu.`).catch(err => console.error("Error mengirim pesan 'tidak ada grup':", err.message));
    }

    const total = groups.length;
    let sukses = 0, gagal = 0;
    await bot.sendMessage(chatId, `⏳ Memproses sharemsgv2 (forward) ke *${total}* grup/channel...`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan proses:", err.message));

    const jedaMs = isMainOwnerFlag ? 0 : 15000; // 15 seconds delay for non-main owners

    for (const groupId of groups) {
      try {
        await bot.forwardMessage(groupId, chatId, msg.reply_to_message.message_id).catch(err => console.warn(`⚠️ Gagal forward pesan ke ${groupId}:`, err.message));
        sukses++;
      } catch (err) {
        gagal++;
        console.error(`❌ Gagal forward ke ${groupId}: ${err.description || err.message}`);
      }
      if (jedaMs > 0) {
        await new Promise(r => setTimeout(r, jedaMs));
      }
    }

    await bot.sendMessage(chatId, `
✔️ Sharemsgv2 selesai!
📊 Hasil:
- Total Grup: ${total}
- ✔️ Sukses: ${sukses}
- ❌ Gagal: ${gagal}
    `.trim(), { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan ringkasan share:", err.message));
  } catch (err) {
    console.error(`❌ Error fatal di /sharemsgv2:`, err);
    await bot.sendMessage(chatId, `⚠️ Terjadi error saat memproses /sharemsgv2. Silakan coba lagi nanti.`).catch(err => console.error("Error mengirim pesan error fatal:", err.message));
  }
});

// ==================== /broadcastv2 ====================
bot.onText(/^\/broadcastv2$/, async (msg) => {
  if (!(await requireNotBlacklisted(msg))) return;
  const senderId = String(msg.from.id);
  const data = await loadData();
  const chatId = msg.chat.id;

  try {
    const isOwnerNow = await isAnyOwner(senderId);
    const isPremiumUser = await isPremium(senderId);
    const isMainOwnerFlag = isMainOwner(senderId);

    // Condition for broadcastv2: only additional owners or main owner
    if (!isOwnerNow) {
      return await bot.sendMessage(chatId, `🚫 Maaf, fitur ini hanya bisa digunakan oleh Owner.`).catch(err => console.error("Error mengirim pesan akses ditolak:", err.message));
    }

    if (!msg.reply_to_message) {
      return await bot.sendMessage(chatId, `⚠️ Harap *reply* ke pesan yang ingin di-forward ke semua user.`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan 'reply diperlukan':", err.message));
    }

    const users = data.users || [];
    if (users.length === 0) {
      return await bot.sendMessage(chatId, `⚠️ Tidak ada user terdaftar untuk broadcast.`).catch(err => console.error("Error mengirim pesan 'tidak ada user':", err.message));
    }

    const total = users.length;
    let sukses = 0, gagal = 0;
    await bot.sendMessage(chatId, `⏳ broadcastv2 (forward) ke *${total}* user dimulai...`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan proses:", err.message));

    const jedaMs = isMainOwnerFlag ? 0 : 15000; // 15 seconds delay for non-main owners

    for (const targetId of users) {
      try {
        await bot.forwardMessage(targetId, chatId, msg.reply_to_message.message_id).catch(err => console.warn(`⚠️ Gagal forward pesan ke ${targetId}:`, err.message));
        sukses++;
      } catch (err) {
        gagal++;
        console.error(`❌ Gagal forward ke ${targetId}: ${err.description || err.message}`);
      }
      if (jedaMs > 0) {
        await new Promise(r => setTimeout(r, jedaMs));
      }
    }

    await bot.sendMessage(chatId, `
✔️ Broadcastv2 selesai!
📊 Hasil:
- Total User: ${total}
- ✔️ Sukses: ${sukses}
- ❌ Gagal: ${gagal}
    `.trim(), { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan ringkasan broadcast:", err.message));
  } catch (err) {
    console.error(`❌ Error di /broadcastv2:`, err);
    await bot.sendMessage(chatId, `⚠️ Terjadi error saat memproses /broadcastv2. Silakan coba lagi nanti.`).catch(err => console.error("Error mengirim pesan error fatal:", err.message));
  }
});

// ==================== /addownjs <id> ====================
bot.onText(/^\/addownjs(?:\s+(\d+))?$/, async (msg, match) => { // Gunakan async di sini
  const senderId = msg.from.id;
  const chatId = msg.chat.id;

  if (!isMainOwner(senderId)) {
    return await bot.sendMessage(chatId, "🚫 Maaf, hanya Owner Utama yang dapat menambahkan owner tambahan.").catch(err => console.error("Error mengirim pesan akses ditolak:", err.message));
  }

  if (!match[1]) {
    return await bot.sendMessage(chatId, "⚠️ Contoh penggunaan yang benar:\n\n`/addownjs 123456789`", { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim contoh penggunaan:", err.message));
  }

  const targetId = match[1];
  const data = await loadData(); // Muat data secara asinkron

  if (!Array.isArray(data.owner)) data.owner = [];

  if (isMainOwner(targetId)) {
    return await bot.sendMessage(chatId, `⚠️ User ${targetId} sudah terdaftar sebagai Owner Utama.`).catch(err => console.error("Error mengirim pesan sudah owner utama:", err.message));
  }

  if (!data.owner.includes(targetId)) {
    data.owner.push(targetId);
    await saveData(data); // Simpan data secara asinkron
    await bot.sendMessage(chatId, `✔️ User \`${targetId}\` berhasil ditambahkan sebagai owner tambahan.`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengkonfirmasi tambah owner:", err.message));
  } else {
    await bot.sendMessage(chatId, `⚠️ User \`${targetId}\` sudah menjadi owner tambahan.`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan sudah owner tambahan:", err.message));
  }
});

// ==================== /delownjs <id> ====================
bot.onText(/^\/delownjs(?:\s+(\d+))?$/, async (msg, match) => { // Gunakan async di sini
  const senderId = msg.from.id;
  const chatId = msg.chat.id;

  if (!isMainOwner(senderId)) {
    return await bot.sendMessage(chatId, "🚫 Maaf, hanya Owner Utama yang dapat menghapus owner tambahan.").catch(err => console.error("Error mengirim pesan akses ditolak:", err.message));
  }

  if (!match[1]) {
    return await bot.sendMessage(chatId, "⚠️ Contoh penggunaan yang benar:\n\n`/delownjs 123456789`", { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim contoh penggunaan:", err.message));
  }

  const targetId = match[1];
  const data = await loadData(); // Muat data secara asinkron

  if (isMainOwner(targetId)) {
    return await bot.sendMessage(chatId, `❌ Tidak bisa menghapus Owner Utama (\`${targetId}\`).`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan tidak bisa hapus owner utama:", err.message));
  }

  if (Array.isArray(data.owner) && data.owner.includes(targetId)) {
    data.owner = data.owner.filter(id => id !== targetId);
    await saveData(data); // Simpan data secara asinkron
    await bot.sendMessage(chatId, `✔️ User \`${targetId}\` berhasil dihapus dari daftar owner tambahan.`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengkonfirmasi hapus owner:", err.message));
  } else {
    await bot.sendMessage(chatId, `⚠️ User \`${targetId}\` tidak ditemukan dalam daftar owner tambahan.`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan bukan owner tambahan:", err.message));
  }
});

// ==================== /listownjs ====================
bot.onText(/^\/listownjs$/, async (msg) => { // Gunakan async di sini
  const senderId = msg.from.id;
  const chatId = msg.chat.id;

  if (!isMainOwner(senderId)) {
    return await bot.sendMessage(chatId, "🚫 Maaf, hanya Owner Utama yang bisa melihat daftar owner tambahan.").catch(err => console.error("Error mengirim pesan akses ditolak:", err.message));
  }

  const data = await loadData(); // Muat data secara asinkron
  const ownersTambahan = Array.isArray(data.owner) ? data.owner : [];

  if (ownersTambahan.length === 0) {
    return await bot.sendMessage(chatId, "📊 Tidak ada owner tambahan yang terdaftar.").catch(err => console.error("Error mengirim pesan tidak ada owner tambahan:", err.message));
  }

  const teks = `📊 Daftar Owner Tambahan:\n\n${ownersTambahan.map((id, i) => `${i + 1}. \`${id}\``).join("\n")}`;
  await bot.sendMessage(chatId, teks, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan daftar owner:", err.message));
});

// ==================== /addakses <id> <durasi>[d/h] ====================
bot.onText(/^\/addakses(?:\s+(\d+)\s+(\d+)([dh]))?$/, async (msg, match) => { // Gunakan async di sini
  const senderId = String(msg.from.id);
  const chatId = msg.chat.id;

  if (!isMainOwner(senderId)) {
    return await bot.sendMessage(chatId, "🚫 Maaf, hanya Owner Utama yang dapat menambahkan akses premium.").catch(err => console.error("Error mengirim pesan akses ditolak:", err.message));
  }

  const userId = match[1];
  const jumlah = match[2];
  const satuan = match[3];

  if (!userId || !jumlah || !satuan) {
    return await bot.sendMessage(chatId, `📝 Contoh penggunaan:\n\n\`/addakses 123456789 3d\`\n\n(d = hari, h = jam)`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim contoh penggunaan:", err.message));
  }

  const durasi = parseInt(jumlah);
  let detik;
  if (satuan === 'd') detik = durasi * 86400;
  else if (satuan === 'h') detik = durasi * 3600;
  else return await bot.sendMessage(chatId, '❌ Format waktu salah. Gunakan "d" (hari) atau "h" (jam).').catch(err => console.error("Error mengirim pesan format durasi tidak valid:", err.message));

  const now = Math.floor(Date.now() / 1000);
  const data = await loadData(); // Muat data secara asinkron
  if (!data.premium) data.premium = {};

  const current = data.premium[userId] === "permanent" ? now : (data.premium[userId] || now); // Handle permanent premium
  data.premium[userId] = current > now ? current + detik : now + detik;

  await saveData(data); // Simpan data secara asinkron
  const waktuText = satuan === 'd' ? 'hari' : 'jam';
  await bot.sendMessage(chatId, `✔️ User \`${userId}\` berhasil ditambahkan Premium selama ${durasi} ${waktuText}.`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengkonfirmasi tambah premium:", err.message));
});

// ==================== /delakses <id> ====================
bot.onText(/^\/delakses(?:\s+(\d+))?$/, async (msg, match) => { // Gunakan async di sini
  const senderId = String(msg.from.id);
  const chatId = msg.chat.id;

  if (!isMainOwner(senderId)) {
    return await bot.sendMessage(chatId, "🚫 Maaf, hanya Owner Utama yang dapat menghapus akses premium.").catch(err => console.error("Error mengirim pesan akses ditolak:", err.message));
  }

  const userId = match[1];
  if (!userId) {
    return await bot.sendMessage(chatId, `📝 Contoh penggunaan:\n\n\`/delakses 123456789\``, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim contoh penggunaan:", err.message));
  }

  const data = await loadData(); // Muat data secara asinkron
  if (!data.premium || !data.premium[userId]) {
    return await bot.sendMessage(chatId, `❌ User \`${userId}\` tidak ditemukan atau belum memiliki akses premium.`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan user tidak premium:", err.message));
  }

  delete data.premium[userId];
  await saveData(data); // Simpan data secara asinkron
  await bot.sendMessage(chatId, `✔️ Akses Premium user \`${userId}\` berhasil dihapus.`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengkonfirmasi hapus premium:", err.message));
});

// ==================== /listakses ====================
bot.onText(/^\/listakses$/, async (msg) => { // Gunakan async di sini
  const senderId = String(msg.from.id);
  const chatId = msg.chat.id;

  if (!isMainOwner(senderId)) {
    return await bot.sendMessage(chatId, "🚫 Maaf, hanya Owner Utama yang bisa melihat daftar user premium.").catch(err => console.error("Error mengirim pesan akses ditolak:", err.message));
  }

  const data = await loadData(); // Muat data secara asinkron
  const now = Math.floor(Date.now() / 1000);

  const entries = Object.entries(data.premium || {})
    .map(([uid, exp]) => {
      if (exp === "permanent") {
        return `👑 \`${uid}\` - *PERMANEN*`;
      }
      const sisaJam = Math.floor((exp - now) / 3600);
      return sisaJam > 0 ? `👤 \`${uid}\` - ${sisaJam} jam tersisa` : null;
    })
    .filter(Boolean); // Filter out null entries (expired ones)

  if (entries.length === 0) {
    return await bot.sendMessage(chatId, "📊 Daftar Premium:\n\nBelum ada user Premium yang terdaftar.").catch(err => console.error("Error mengirim pesan tidak ada user premium:", err.message));
  }

  const teks = `📊 Daftar Premium:\n\n${entries.join("\n")}`;
  await bot.sendMessage(chatId, teks, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan daftar premium:", err.message));
});

// ==================== /addbl <id> ====================
bot.onText(/^\/addbl\s+(\d+)$/, async (msg, match) => { // Gunakan async di sini
  const senderId = msg.from.id;
  const chatId = msg.chat.id;
  if (!isMainOwner(senderId)) return await bot.sendMessage(chatId, "🚫 Maaf, hanya Owner Utama yang dapat menambahkan user ke blacklist.").catch(err => console.error("Error mengirim pesan akses ditolak:", err.message));
  const targetId = match[1];
  const data = await loadData(); // Muat data secara asinkron
  if (!data.blacklist) data.blacklist = [];
  if (!data.blacklist.includes(targetId)) {
    data.blacklist.push(targetId);
    await saveData(data); // Simpan data secara asinkron
    await bot.sendMessage(chatId, `✔️ User \`${targetId}\` berhasil ditambahkan ke blacklist.`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengkonfirmasi tambah blacklist:", err.message));
  } else {
    await bot.sendMessage(chatId, `⚠️ User \`${targetId}\` sudah ada di blacklist.`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan sudah di blacklist:", err.message));
  }
});

// ==================== /delbl <id> ====================
bot.onText(/^\/delbl\s+(\d+)$/, async (msg, match) => { // Gunakan async di sini
  const senderId = msg.from.id;
  const chatId = msg.chat.id;
  if (!isMainOwner(senderId)) return await bot.sendMessage(chatId, "🚫 Maaf, hanya Owner Utama yang dapat menghapus user dari blacklist.").catch(err => console.error("Error mengirim pesan akses ditolak:", err.message));
  const targetId = match[1];
  const data = await loadData(); // Muat data secara asinkron
  if (data.blacklist && data.blacklist.includes(targetId)) {
    data.blacklist = data.blacklist.filter(x => x !== targetId);
    await saveData(data); // Simpan data secara asinkron
    await bot.sendMessage(chatId, `✔️ User \`${targetId}\` berhasil dihapus dari blacklist.`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengkonfirmasi hapus blacklist:", err.message));
  } else {
    await bot.sendMessage(chatId, `⚠️ User \`${targetId}\` tidak ditemukan di blacklist.`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan tidak di blacklist:", err.message));
  }
});

// ==================== /listbl ====================
bot.onText(/^\/listbl$/, async (msg) => { // Gunakan async di sini
  const senderId = msg.from.id;
  const chatId = msg.chat.id;
  if (!isMainOwner(senderId)) return await bot.sendMessage(chatId, "🚫 Maaf, hanya Owner Utama yang bisa melihat daftar blacklist.").catch(err => console.error("Error mengirim pesan akses ditolak:", err.message));
  const data = await loadData(); // Muat data secara asinkron
  const list = data.blacklist || [];
  if (list.length === 0) {
    await bot.sendMessage(chatId, "📊 Blacklist kosong.").catch(err => console.error("Error mengirim pesan blacklist kosong:", err.message));
  } else {
    await bot.sendMessage(chatId, "📊 Daftar blacklist:\n" + list.map((id, i) => `${i + 1}. \`${id}\``).join("\n"), { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan daftar blacklist:", err.message));
  }
});

// ==================== /setjeda [menit] ====================
bot.onText(/^\/setjeda(?:\s+(\d+))?$/, async (msg, match) => {
  const senderId = String(msg.from.id);
  const chatId = msg.chat.id;

  if (!isMainOwner(senderId)) {
    return await bot.sendMessage(chatId, "🚫 Maaf, hanya Owner Utama yang dapat mengatur jeda global.").catch(err => console.error("Error mengirim pesan akses ditolak:", err.message));
  }

  const data = await loadData(); // Muat data secara asinkron
  if (!data.settings) data.settings = {};
  if (!data.settings.cooldown) data.settings.cooldown = {};

  const menit = parseInt(match[1]);
  if (isNaN(menit) || menit <= 0) {
    const current = await getGlobalCooldownMinutes(); // Panggil getGlobalCooldownMinutes secara asinkron
    return await bot.sendMessage(chatId, `📝 Jeda global saat ini: *${current} menit*.\nUntuk mengubah, gunakan: \`/setjeda <jumlah_menit>\``, { parse_mode: "Markdown" }).catch(err => console.error("Error mengirim pesan jeda saat ini:", err.message));
  }

  data.settings.cooldown.default = menit;
  await saveData(data); // Simpan data secara asinkron

  return await bot.sendMessage(chatId, `✔️ Jeda global berhasil diatur ke *${menit} menit*.`, { parse_mode: "Markdown" }).catch(err => console.error("Error mengkonfirmasi set jeda:", err.message));
});

// ==================== /cekid ====================
bot.onText(/^\/cekid$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const firstName = msg.from.first_name || '';
  const lastName = msg.from.last_name || '';
  const fullName = `${firstName} ${lastName}`.trim();
  const username = msg.from.username ? '@' + msg.from.username : 'Tidak ada';
  const date = new Date().toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta" });

  // Ambil DC ID dari user_id
  const dcId = (userId >> 27) & 7;

  const caption = `
<blockquote class="tg-spoiler"><b>ID CARD TELEGRAM</b></blockquote>

👤 <b>Nama</b> : ${fullName}
🪪 <b>User ID</b> : <code>${userId}</code>
🪪 <b>Username</b> : ${username}
🪪 <b>DC ID</b> : ${dcId}
🗓️ <b>Tanggal</b> : ${date}

© ${DEVELOPER}
  `.trim();

  try {
    const userProfilePhotos = await bot.getUserProfilePhotos(userId, { limit: 1 });

    if (userProfilePhotos.total_count === 0) throw new Error("No profile photo");

    const fileId = userProfilePhotos.photos[0][0].file_id;

    await bot.sendPhoto(chatId, fileId, {
      caption: caption,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: `${fullName}`, url: `tg://user?id=${userId}` }
          ]
        ]
      }
    });
  } catch (err) {
    console.error(`Error mendapatkan foto profil user untuk ${userId}:`, err.message);
    await bot.sendMessage(chatId, caption, { parse_mode: 'HTML' }).catch(err => console.error("Error mengirim pesan cekid tanpa foto:", err.message));
  }
});

// ==================== /backup ====================
bot.onText(/^\/backup$/, async (msg) => {
  const senderId = msg.from.id;
  const chatId = msg.chat.id;
  if (!isMainOwner(senderId)) return await bot.sendMessage(chatId, "🚫 Maaf, hanya Owner Utama yang dapat membuat backup data.").catch(err => console.error("Error mengirim pesan akses ditolak:", err.message));

  try {
    const backupPath = await backupData(); // Buat backup secara asinkron
    if (backupPath) {
      await bot.sendDocument(chatId, backupPath, {}, { filename: "data-backup.json" }).catch(err => console.error("Error mengirim dokumen backup:", err.message));
      await bot.sendMessage(chatId, "✔️ Backup data berhasil dibuat dan dikirim.").catch(err => console.error("Error mengkonfirmasi backup terkirim:", err.message));
    } else {
      await bot.sendMessage(chatId, "⚠️ Tidak ada `data.json` untuk di-backup atau terjadi kesalahan saat membuat backup.").catch(err => console.error("Error mengirim pesan tidak ada data.json:", err.message));
    }
  } catch (e) {
    console.error("❌ Error backup manual:", e);
    await bot.sendMessage(chatId, "❌ Gagal membuat backup. Silakan cek log bot.").catch(err => console.error("Error mengirim pesan kegagalan backup:", err.message));
  }
});

// ==================== /ping ====================
bot.onText(/^\/ping$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isMainOwner(userId)) return await bot.sendMessage(chatId, '🚫 Maaf, hanya Owner Utama yang dapat menggunakan perintah ini.').catch(err => console.error("Error mengirim pesan akses ditolak:", err.message));

  try {
    const uptimeMs = Date.now() - BOT_START_TIME;
    const uptime = formatUptime(Math.floor(uptimeMs / 1000));
    const totalMem = os.totalmem() / (1024 ** 3);
    const freeMem = os.freemem() / (1024 ** 3);
    const cpuModel = os.cpus()[0].model;
    const cpuCores = os.cpus().length;

    const teks = `
<blockquote class="tg-spoiler">
  <span style="color: #00FF00;">ℹ️ Informasi VPS</span>
</blockquote>
CPU: ${cpuModel} (${cpuCores} CORE)
RAM: ${freeMem.toFixed(2)} GB / ${totalMem.toFixed(2)} GB
Uptime: ${uptime}
    `.trim();

    await bot.sendMessage(chatId, teks, { parse_mode: 'HTML' }).catch(err => console.error("Error mengirim pesan ping:", err.message));
  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, '❌ Gagal membaca informasi VPS.').catch(err => console.error("Error mengirim pesan kegagalan ping:", err.message));
  }
});

// Helper function for formatting uptime
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${d} hari, ${h} jam, ${m} menit, ${s} detik`;
}

// ⚠️ Warna Judul
console.log(
  chalk.hex("#FF4500").bold(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${chalk.hex("#FFD700").bold("BOT JASEB ACTIVE")}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DEVELOPER SCRIPT : ${chalk.hex("#00FFFF")(DEVELOPER)}
VERSION SCRIPT : ${chalk.hex("#ADFF2F")(VERSION)}
CHANNEL DEVELOPER : ${chalk.hex("#1E90FF").underline(CHANNEL_URL)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`)
);

console.log(
  chalk.hex("#FF69B4").bold(`
⠀⠀⢀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⡀⠀⠀
⠀⣠⠾⡏⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡟⢦⠀
⢰⠇⠀⣇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⠃⠈⣧
⠘⡇⠀⠸⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡞⠀⠀⣿
⠀⡇⠘⡄⢱⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡼⢁⡆⢀⡏
⠀⠹⣄⠹⡀⠙⣄⠀⠀⠀⠀⠀⢀⣤⣴⣶⣶⣶⣾⣶⣶⣶⣶⣤⣀⠀⠀⠀⠀⠀⢀⠜⠁⡜⢀⡞⠀
⠀⠀⠘⣆⢣⡄⠈⢣⡀⢀⣤⣾⣿⣿⢿⠉⠉⠉⠉⠉⠉⠉⣻⢿⣿⣷⣦⣄⠀⡰⠋⢀⣾⢡⠞⠀⠀
⠀⠀⠀⠸⣿⡿⡄⡀⠉⠙⣿⡿⠁⠈⢧⠃⠀⠀⠀⠀⠀⠀⢷⠋⠀⢹⣿⠛⠉⢀⠄⣞⣧⡏⠀⠀⠀
⠀⠀⠀⠀⠸⣿⣹⠘⡆⠀⡿⢁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⢻⡆⢀⡎⣼⣽⡟⠀⠀⠀⠀
⠀⠀⠀⠀⠀⣹⣿⣇⠹⣼⣷⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢷⣳⡜⢰⣿⣟⡀⠀⠀⠀⠀
⠀⠀⠀⠀⡾⡉⠛⣿⠴⠳⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡇⠳⢾⠟⠉⢻⡀⠀⠀⠀
⠀⠀⠀⠀⣿⢹⠀⢘⡇⠀⣧⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⠃⠀⡏⠀⡼⣾⠇⠀⠀⠀
⠀⠀⠀⠀⢹⣼⠀⣾⠀⣀⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠸⣄⡀⢹⠀⢳⣼⠀⠀⠀⠀
⠀⠀⠀⠀⢸⣇⠀⠸⣾⠁⠀⠀⠀⠀⠀⢀⡾⠀⠀⠀⠰⣄⠀⠀⠀⠀⠀⠀⣹⡞⠀⣀⣿⠀⠀⠀⠀
⠀⠀⠀⠀⠈⣇⠱⡄⢸⡛⠒⠒⠒⠒⠚⢿⣇⠀⠀⠀⢠⣿⠟⠒⠒⠒⠒⠚⡿⢀⡞⢹⠇⠀⠀⠀⠀
⠀⠀⠀⠀⠀⡞⢰⣷⠀⠑⢦⣄⣀⣀⣠⠞⢹⠀⠀⠀⣸⠙⣤⣀⣀⣀⡤⠞⠁⢸⣶⢸⡄⠀⠀⠀⠀
⠀⠀⠀⠀⠰⣧⣰⠿⣄⠀⠀⠀⢀⣈⡉⠙⠏⠀⠀⠀⠘⠛⠉⣉⣀⠀⠀⠀⢀⡟⣿⣼⠇⠀⠀⠀⠀
⠀⠀⠀⠀⠀⢀⡿⠀⠘⠷⠤⠾⢻⠞⠋⠀⠀⠀⠀⠀⠀⠀⠘⠛⣎⠻⠦⠴⠋⠀⠹⡆⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠸⣿⡀⢀⠀⠀⡰⡌⠻⠷⣤⡀⠀⠀⠀⠀⣠⣶⠟⠋⡽⡔⠀⡀⠀⣰⡟⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠙⢷⣄⡳⡀⢣⣿⣀⣷⠈⠳⣦⣀⣠⡾⠋⣸⡇⣼⣷⠁⡴⢁⣴⠟⠁⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠈⠻⣶⡷⡜⣿⣻⠈⣦⣀⣀⠉⠀⣀⣠⡏⢹⣿⣏⡼⣡⡾⠃⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⢿⣿⣿⣻⡄⠹⡙⠛⠿⠟⠛⡽⠀⣿⣻⣾⣿⠏⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢿⡏⢏⢿⡀⣹⢲⣶⡶⢺⡀⣴⢫⢃⣿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⣷⠈⠷⠭⠽⠛⠛⠛⠋⠭⠴⠋⣸⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠹⣷⣄⡀⢀⣀⣠⣀⣀⢀⣀⣴⠟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠉⠉⠀⠀⠀⠈⠉⠉⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
  `)
);
