const express = require('express');
const multer = require('multer');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const unzipper = require('unzipper');
const Seven = require('7zip-min');
const util = require('util');
const extractSeven = util.promisify(Seven.unpack);
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const https = require('https');
const http = require('http');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000; // Use environment port or default to 3000
const HTTPS_PORT = 443;

// ตัวแปรสำหรับเก็บการตั้งค่าระบบ
let systemSettings = {
  defaultCredits: 60,
  runBotCredits: 15,
  captchaEnabled: true  // เพิ่มการตั้งค่าเปิด/ปิดระบบแคปซ่า โดยค่าเริ่มต้นคือเปิด
};

// เพิ่มตัวแปรสำหรับเก็บการตั้งค่า Telegram
let settings = {
  telegramNotifications: {
    enabled: false,
    token: "7929038707:AAHq52QK_p2TLxSPF4f-Q51Fb8oV1uIM9qc",
    chatId: "",
    notifyOnNewUser: true,
    notifyOnDeposit: true
  }
};

// --- Global Settings ---
let costPerDay = 15; // Will store actual cost per day

// เชื่อมต่อกับฐานข้อมูล SQLite
let db;
async function initializeDatabase() {
    db = await open({
        filename: 'botmanager.db',
        driver: sqlite3.Database
    });

    // สร้างตาราง users ถ้ายังไม่มี
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password TEXT NOT NULL,
            credits INTEGER DEFAULT 0
        )
    `);

    // สร้างตาราง settings เพื่อเก็บการตั้งค่าระบบ
    await db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    `);

    // เพิ่มค่าเริ่มต้นสำหรับ default_credits ถ้ายังไม่มี
    const defaultCreditsSettings = await db.get('SELECT value FROM settings WHERE key = ?', ['default_credits']);
    if (!defaultCreditsSettings) {
        await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['default_credits', '60']);
    }

    // สร้างตาราง user_bots เพื่อเก็บความสัมพันธ์ระหว่างผู้ใช้และบอท
    await db.exec(`
        CREATE TABLE IF NOT EXISTS user_bots (
            username TEXT,
            bot_id TEXT,
            PRIMARY KEY (username, bot_id),
            FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
        )
    `);

    // สร้างตาราง bot_states เพื่อเก็บสถานะของบอท
    await db.exec(`
        CREATE TABLE IF NOT EXISTS bot_states (
            bot_id TEXT PRIMARY KEY,
            status TEXT DEFAULT 'หยุด',
            is_folder INTEGER DEFAULT 0,
            folder TEXT,
            install_command TEXT DEFAULT '',
            owner TEXT,
            type TEXT DEFAULT 'javascript',
            expire_time INTEGER DEFAULT NULL,
            FOREIGN KEY (owner) REFERENCES users(username) ON DELETE SET NULL
        )
    `);

    // สร้างตาราง redemption_codes เพื่อเก็บโค้ดแลกเครดิต
    await db.exec(`
        CREATE TABLE IF NOT EXISTS redemption_codes (
            code TEXT PRIMARY KEY,
            credits INTEGER NOT NULL,
            max_uses INTEGER NOT NULL,
            uses INTEGER DEFAULT 0,
            expire_time INTEGER NOT NULL,
            created_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
    `);
    
    // สร้างตาราง payments เพื่อเก็บประวัติการเติมเงิน
    await db.exec(`
        CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            amount REAL NOT NULL,
            credits INTEGER NOT NULL,
            payment_method TEXT NOT NULL,
            voucher_code TEXT,
            timestamp INTEGER DEFAULT (strftime('%s', 'now')),
            FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
        )
    `);

    // รีเซ็ตสถานะบอททั้งหมดเป็น "หยุด" เมื่อเริ่มเซิร์ฟเวอร์ใหม่
    await db.run('UPDATE bot_states SET status = ?', ['หยุด']);

    console.log('เชื่อมต่อกับฐานข้อมูล SQLite สำเร็จ และรีเซ็ตสถานะบอททั้งหมดเป็น "หยุด"');
}

const storage = multer.diskStorage({
    destination: './bots/',
    filename: (req, file, cb) => {
        try {
            // อ่านรายการไฟล์ที่มีอยู่ในโฟลเดอร์ bots
            const files = fs.readdirSync('./bots');
            const numbers = files
                .map(f => {
                    const match = f.match(/^bp(\d+)/);
                    return match ? parseInt(match[1]) : 0;
                })
                .filter(num => num > 0);
            const nextNumber = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
            cb(null, `bp${nextNumber}${path.extname(file.originalname)}`);
        } catch (err) {
            console.error('Error generating filename:', err);
            cb(new Error('ไม่สามารถสร้างชื่อไฟล์ได้'));
        }
    }
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        if (!file) return cb(new Error('กรุณาเลือกไฟล์ก่อนอัปโหลด'));
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext !== '.zip' && ext !== '.7z' && ext !== '.js' && ext !== '.py') {
            return cb(new Error('กรุณาอัปโหลดไฟล์ .zip, .7z, .js หรือ .py เท่านั้น'));
        }
        cb(null, true);
    }
});

if (!fs.existsSync('./bots')) fs.mkdirSync('./bots');

const bots = {};

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

async function loadUsers() {
    try {
        // โหลดข้อมูลผู้ใช้จาก SQLite
        const users = await db.all('SELECT * FROM users');
        const userBots = await db.all('SELECT * FROM user_bots');
        
        // สร้าง object ผู้ใช้
        const usersObj = {};
        for (const user of users) {
            usersObj[user.username] = {
                password: user.password,
                credits: user.credits,
                bots: []
            };
        }
        
        // เพิ่มรายการบอทให้กับผู้ใช้
        for (const relation of userBots) {
            if (usersObj[relation.username]) {
                usersObj[relation.username].bots.push(relation.bot_id);
            }
        }
        
        return usersObj;
    } catch (err) {
        console.error('Error loading users:', err);
        return {};
    }
}

async function saveUser(username, userData) {
    try {
        // บันทึกข้อมูลผู้ใช้ลงใน SQLite
        await db.run(
            'INSERT INTO users (username, password, credits) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET password = ?, credits = ?',
            [username, userData.password, userData.credits || 0, userData.password, userData.credits || 0]
        );
        
        // ลบความสัมพันธ์เก่าระหว่างผู้ใช้และบอท
        await db.run('DELETE FROM user_bots WHERE username = ?', [username]);
        
        // เพิ่มความสัมพันธ์ใหม่
        if (userData.bots && userData.bots.length > 0) {
            const stmt = await db.prepare('INSERT INTO user_bots (username, bot_id) VALUES (?, ?)');
            for (const botId of userData.bots) {
                await stmt.run(username, botId);
            }
            await stmt.finalize();
        }
    } catch (err) {
        console.error(`Error saving user ${username}:`, err);
    }
}

async function deleteUser(username) {
    try {
        // ลบผู้ใช้จากฐานข้อมูล (จะลบความสัมพันธ์กับบอทด้วยเนื่องจาก ON DELETE CASCADE)
        await db.run('DELETE FROM users WHERE username = ?', [username]);
    } catch (err) {
        console.error(`Error deleting user ${username}:`, err);
    }
}

function findIndexJsOrPy(dir) {
    if (!fs.existsSync(dir)) return null;

    const items = fs.readdirSync(dir);
    for (const item of items) {
        const fullPath = path.join(dir, item);
        if (fs.statSync(fullPath).isFile() && (item === 'index.js' || item === 'main.py' || item === '__main__.py')) {
            return dir;
        } else if (fs.statSync(fullPath).isDirectory()) {
            const subPath = findIndexJsOrPy(fullPath);
            if (subPath) return subPath;
        }
    }
    return null;
}

async function loadExistingBots() {
    if (!fs.existsSync('./bots')) {
        fs.mkdirSync('./bots');
        return;
    }

    try {
        // โหลดสถานะบอทจาก SQLite
        const savedStates = await db.all('SELECT * FROM bot_states');
        const savedStatesMap = {};
        savedStates.forEach(state => {
            savedStatesMap[state.bot_id] = {
                status: state.status,
                isFolder: state.is_folder === 1,
                folder: state.folder,
                installCommand: state.install_command,
                owner: state.owner,
                type: state.type,
                expireTime: state.expire_time
            };
        });

        // ล้างข้อมูลบอทเดิม
        for (const botId in bots) {
            if (bots[botId].process) bots[botId].process.kill();
        }
        Object.keys(bots).forEach(key => delete bots[key]);

        // โหลดบอทจากไฟล์ในระบบ
        const botItems = fs.readdirSync('./bots');
        botItems.forEach(item => {
            const itemPath = path.join('./bots', item);
            const botId = item;

            try {
                if (fs.statSync(itemPath).isDirectory()) {
                    const indexPath = findIndexJsOrPy(itemPath);
                    if (indexPath) {
                        const savedState = savedStatesMap[botId] || {};
                        const isPython = fs.existsSync(path.join(indexPath, 'main.py')) || fs.existsSync(path.join(indexPath, '__main__.py'));
                        bots[botId] = {
                            folder: botId,
                            mainPath: indexPath,
                            status: savedState.status || 'หยุด',
                            process: null,
                            logs: [`[ข้อมูล] โหลดบอทที่มีอยู่ (โฟลเดอร์): ${botId}`],
                            installCommand: savedState.installCommand || '',
                            isFolder: true,
                            owner: savedState.owner,
                            type: isPython ? 'python' : 'javascript',
                            expireTime: savedState.expireTime
                        };
                    }
                } else {
                    const ext = path.extname(item).toLowerCase();
                    if (ext === '.js' || ext === '.py') {
                        const savedState = savedStatesMap[botId] || {};
                        bots[botId] = {
                            filename: botId,
                            mainPath: itemPath,
                            status: savedState.status || 'หยุด',
                            process: null,
                            logs: [`[ข้อมูล] โหลดบอทที่มีอยู่ (ไฟล์เดี่ยว): ${botId}`],
                            installCommand: savedState.installCommand || '',
                            isFolder: false,
                            owner: savedState.owner,
                            type: ext === '.py' ? 'python' : 'javascript'
                        };
                    }
                }
            } catch (err) {
                console.error(`เกิดข้อผิดพลาดในการโหลดบอท ${botId}:`, err);
            }
        });

        console.log('โหลดบอทที่มีอยู่:', Object.keys(bots));
    } catch (err) {
        console.error('Error loading existing bots:', err);
    }
}

function findIndexJs(dir) {
    if (!fs.existsSync(dir)) return null;

    const items = fs.readdirSync(dir);
    for (const item of items) {
        const fullPath = path.join(dir, item);
        if (fs.statSync(fullPath).isFile() && item === 'index.js') {
            return dir;
        } else if (fs.statSync(fullPath).isDirectory()) {
            const subPath = findIndexJs(fullPath);
            if (subPath) return subPath;
        }
    }
    return null;
}

function getFolderStructure(dir, basePath = '') {
    const items = fs.readdirSync(dir);
    const structure = [];

    items.forEach(item => {
        const fullPath = path.join(dir, item);
        const relativePath = path.join(basePath, item);
        const stats = fs.statSync(fullPath);

        if (stats.isDirectory()) {
            structure.push({
                name: item,
                type: 'folder',
                path: relativePath,
                children: getFolderStructure(fullPath, relativePath)
            });
        } else {
            structure.push({
                name: item,
                type: 'file',
                path: relativePath
            });
        }
    });

    return structure;
}

async function saveBotState(botId, botData) {
    try {
        // บันทึกสถานะบอทลงใน SQLite
        await db.run(
            `INSERT INTO bot_states 
            (bot_id, status, is_folder, folder, install_command, owner, type, expire_time) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) 
            ON CONFLICT(bot_id) DO UPDATE SET 
            status = ?, is_folder = ?, folder = ?, install_command = ?, owner = ?, type = ?, expire_time = ?`,
            [
                botId, 
                botData.status, 
                botData.isFolder ? 1 : 0, 
                botData.folder || null, 
                botData.installCommand || '', 
                botData.owner || null, 
                botData.type || 'javascript',
                botData.expireTime || null,
                botData.status, 
                botData.isFolder ? 1 : 0, 
                botData.folder || null, 
                botData.installCommand || '', 
                botData.owner || null, 
                botData.type || 'javascript',
                botData.expireTime || null
            ]
        );
    } catch (err) {
        console.error(`Error saving bot state for ${botId}:`, err);
    }
}

async function saveBotStates() {
    try {
        for (const [botId, bot] of Object.entries(bots)) {
            await saveBotState(botId, {
                status: bot.status,
                isFolder: bot.isFolder,
                folder: bot.folder,
                installCommand: bot.installCommand,
                owner: bot.owner,
                type: bot.type,
                expireTime: bot.expireTime
            });
        }
    } catch (err) {
        console.error('Error saving bot states:', err);
    }
}

async function loadBotStates() {
    try {
        // โหลดสถานะบอทจาก SQLite
        const states = await db.all('SELECT * FROM bot_states');
        const users = await loadUsers();
        
        for (const state of states) {
            // ตรวจสอบว่าบอทมีเจ้าของหรือไม่
            if (!state.owner) continue;

            // เพิ่มบอทเข้าไปในรายการของเจ้าของ
            if (!users[state.owner]) {
                users[state.owner] = { bots: [], password: '', credits: 0 };
            }
            if (!users[state.owner].bots.includes(state.bot_id)) {
                users[state.owner].bots.push(state.bot_id);
            }

            // กำหนดเจ้าของให้บอท
            if (bots[state.bot_id]) {
                bots[state.bot_id].owner = state.owner;
            }

            // รันบอทที่กำลังทำงานอยู่
            if (state.status === 'กำลังทำงาน') {
                setTimeout(() => {
                    fetch(`http://0.0.0.0:${PORT}/start/${state.bot_id}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: state.owner })
                    });
                }, 2000);
            }
        }
        
        // บันทึกข้อมูลผู้ใช้ที่อัปเดตแล้ว
        for (const [username, userData] of Object.entries(users)) {
            await saveUser(username, userData);
        }
    } catch (err) {
        console.error('Error loading bot states:', err);
    }
}

async function loadSettings() {
    try {
        // โหลดค่า run_bot_credits จากฐานข้อมูล
        const runBotCreditsSettings = await db.get('SELECT value FROM settings WHERE key = ?', ['run_bot_credits']);
        if (runBotCreditsSettings) {
            const runBotCreditsValue = parseInt(runBotCreditsSettings.value);
            defaultSettings.runBotCredits = runBotCreditsValue;
            systemSettings.runBotCredits = runBotCreditsValue;
            costPerDay = runBotCreditsValue;
            console.log('โหลดค่า runBotCredits จากฐานข้อมูล:', runBotCreditsValue);
        } else {
            // ถ้าไม่มีในฐานข้อมูล ให้เพิ่มค่าเริ่มต้น
            await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', 
                ['run_bot_credits', defaultSettings.runBotCredits.toString()]);
            console.log('เพิ่มค่า runBotCredits เริ่มต้นในฐานข้อมูล:', defaultSettings.runBotCredits);
        }
        
        // โหลดการตั้งค่าจาก settings.json เพื่อความเข้ากันได้กับระบบเดิม
        if (fs.existsSync('settings.json')) {
            const settingsData = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
            console.log('โหลดการตั้งค่าจาก settings.json:', settingsData);
            
            // นำเข้าการตั้งค่าจากไฟล์
            defaultSettings.defaultCredits = settingsData.defaultCredits || 60;
            
            // โหลดค่า exchangeRate
            if (settingsData.exchangeRate) {
                defaultSettings.exchangeRate = settingsData.exchangeRate;
            }
            
            // โหลดการตั้งค่า Telegram
            if (settingsData.telegramNotifications) {
                settings.telegramNotifications = settingsData.telegramNotifications;
            }
        } else {
            console.log('ไม่พบไฟล์ settings.json ใช้ค่าเริ่มต้น');
            // สร้างไฟล์ settings.json ขึ้นใหม่ด้วยค่าเริ่มต้น
            const defaultSettingsData = {
                defaultCredits: defaultSettings.defaultCredits,
                exchangeRate: defaultSettings.exchangeRate
            };
            fs.writeFileSync('settings.json', JSON.stringify(defaultSettingsData, null, 2), 'utf8');
            console.log('สร้างไฟล์ settings.json เรียบร้อยแล้ว');
        }
        
        // โหลดค่า default_credits
        const defaultCreditsSettings = await db.get('SELECT value FROM settings WHERE key = ?', ['default_credits']);
        if (defaultCreditsSettings) {
            defaultSettings.defaultCredits = parseInt(defaultCreditsSettings.value);
        }
        
        // โหลดค่า captcha_enabled
        const captchaSettings = await db.get('SELECT value FROM settings WHERE key = ?', ['captcha_enabled']);
        if (captchaSettings) {
            systemSettings.captchaEnabled = captchaSettings.value === '1';
        }
        
        console.log('โหลดการตั้งค่าเรียบร้อย:', { 
            defaultCredits: defaultSettings.defaultCredits,
            runBotCredits: systemSettings.runBotCredits,
            captchaEnabled: systemSettings.captchaEnabled,
            telegramEnabled: settings.telegramNotifications?.enabled || false
        });
    } catch (err) {
        console.error('Error loading settings:', err);
    }
}

process.on('SIGINT', async () => {
    console.log('กำลังบันทึกสถานะบอท...');
    await saveBotStates();
    if (db) await db.close();
    process.exit();
});

process.on('SIGTERM', async () => {
    console.log('กำลังบันทึกสถานะบอท...');
    await saveBotStates();
    if (db) await db.close();
    process.exit();
});

app.use(express.json());
app.use(express.static(__dirname));

// Add settings storage
let defaultSettings = {
    defaultCredits: 60,
    exchangeRate: 10,  // ค่าเริ่มต้นอัตราแลกเปลี่ยน 1 บาท = 10 เครดิต
    runBotCredits: 15  // เพิ่มค่า runBotCredits เข้าไปใน defaultSettings
};

// Add settings endpoints
app.get('/admin/settings', async (req, res) => {
    await loadSettings();
    res.json(defaultSettings);
});

app.post('/admin/settings/default-credits', async (req, res) => {
    const { defaultCredits } = req.body;
    if (typeof defaultCredits !== 'number' || defaultCredits < 0) {
        return res.status(400).json({ error: 'Invalid default credits value' });
    }

    try {
        // บันทึกค่าลงในฐานข้อมูล
        await db.run('UPDATE settings SET value = ? WHERE key = ?', [defaultCredits.toString(), 'default_credits']);
        defaultSettings.defaultCredits = defaultCredits;
        res.json({ success: true });
    } catch (err) {
        console.error('Error saving settings:', err);
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// ฟังก์ชันสำหรับตั้งค่าเครดิตที่ใช้ในการรันบอท
app.post('/admin/settings/run-bot-credits', async (req, res) => {
  const { runBotCredits } = req.body;
  if (typeof runBotCredits !== 'number' || runBotCredits < 0) {
    return res.status(400).json({ error: 'ค่าเครดิตไม่ถูกต้อง' });
  }
  
  try {
    // บันทึกค่า runBotCredits ลงในฐานข้อมูล SQLite
    await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 
      ['run_bot_credits', runBotCredits.toString()]);
    
    // อัปเดตค่าในตัวแปรระบบ
    systemSettings.runBotCredits = runBotCredits;
    defaultSettings.runBotCredits = runBotCredits;
    costPerDay = runBotCredits;
    
    // อัปเดตค่าในไฟล์ settings.json เพื่อความเข้ากันได้กับระบบเดิม
    let settings = {};
    if (fs.existsSync('settings.json')) {
      settings = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
    }
    settings.runBotCredits = runBotCredits;
    fs.writeFileSync('settings.json', JSON.stringify(settings, null, 2));
    
    console.log(`ตั้งค่า runBotCredits = ${runBotCredits} และบันทึกลงในฐานข้อมูล SQLite แล้ว`);
    
    res.json({ success: true, runBotCredits });
  } catch (error) {
    console.error('Error saving run bot credits setting:', error);
    res.status(500).json({ error: 'ไม่สามารถบันทึกการตั้งค่าได้' });
  }
});

// เพิ่ม endpoints สำหรับการตั้งค่าเซิร์ฟเวอร์ (รวมถึงการตั้งค่าแคปซ่า)
app.get('/admin/settings/server', (req, res) => {
  try {
    res.json({ 
      captchaEnabled: systemSettings.captchaEnabled,
      runBotCredits: systemSettings.runBotCredits,
      defaultCredits: defaultSettings.defaultCredits
    });
  } catch (err) {
    console.error('Error getting server settings:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลการตั้งค่าเซิร์ฟเวอร์' });
  }
});

// Endpoint สำหรับการเปิด/ปิดระบบแคปซ่า
app.post('/admin/settings/captcha', (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'ค่าสถานะไม่ถูกต้อง ต้องเป็น boolean (true/false)' });
    }
    
    systemSettings.captchaEnabled = enabled;
    
    // บันทึกการตั้งค่าลงในฐานข้อมูล
    db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 
      ['captcha_enabled', enabled ? '1' : '0']);
    
    res.json({ 
      success: true, 
      message: `${enabled ? 'เปิด' : 'ปิด'}ระบบยืนยันตัวตนแคปซ่าแล้ว`,
      captchaEnabled: enabled
    });
  } catch (err) {
    console.error('Error updating captcha settings:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการอัปเดตการตั้งค่าแคปซ่า' });
  }
});

// API สำหรับตั้งค่าอัตราการแลกเปลี่ยน (บาท:เครดิต)
app.post('/admin/settings/exchange-rate', (req, res) => {
  try {
    const { exchangeRate } = req.body;
    if (!exchangeRate || exchangeRate <= 0) {
      return res.status(400).json({ error: 'กรุณาระบุอัตราแลกเปลี่ยนที่ถูกต้อง' });
    }
    
    const settings = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
    settings.exchangeRate = exchangeRate;
    fs.writeFileSync('settings.json', JSON.stringify(settings, null, 2));
    
    res.json({ success: true, exchangeRate });
  } catch (error) {
    console.error('Error setting exchange rate:', error);
    res.status(500).json({ error: 'ไม่สามารถบันทึกการตั้งค่าได้' });
  }
});

// API สำหรับดึงค่าอัตราการแลกเปลี่ยน
app.get('/admin/settings/exchange-rate', (req, res) => {
  try {
    // ตรวจสอบว่าไฟล์ settings.json มีหรือไม่ ถ้าไม่มีให้สร้างใหม่
    if (!fs.existsSync('settings.json')) {
      const defaultSettings = {
        defaultCredits: 60,
        runBotCredits: 15,
        exchangeRate: 10
      };
      fs.writeFileSync('settings.json', JSON.stringify(defaultSettings, null, 2));
    }
    
    const settings = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
    res.json({ exchangeRate: settings.exchangeRate || 10 });
  } catch (error) {
    console.error('Error getting exchange rate:', error);
    res.status(500).json({ error: 'ไม่สามารถดึงข้อมูลอัตราการแลกเปลี่ยนได้' });
  }
});

// เพิ่ม endpoints สำหรับการตั้งค่า Telegram
app.get('/admin/settings/telegram', (req, res) => {
  try {
    if (fs.existsSync('settings.json')) {
      const settingsData = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
      if (settingsData.telegramNotifications) {
        return res.json(settingsData.telegramNotifications);
      }
    }
    
    return res.json({
      enabled: false,
      token: "",
      chatId: "",
      notifyOnNewUser: true,
      notifyOnDeposit: true
    });
  } catch (err) {
    console.error('Error getting Telegram settings:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลการตั้งค่า Telegram' });
  }
});

app.post('/admin/settings/telegram', (req, res) => {
  try {
    const { enabled, token, chatId, notifyOnNewUser, notifyOnDeposit } = req.body;
    
    const settingsData = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
    settingsData.telegramNotifications = {
      enabled: Boolean(enabled),
      token: token || "7929038707:AAHq52QK_p2TLxSPF4f-Q51Fb8oV1uIM9qc",
      chatId: chatId || "",
      notifyOnNewUser: Boolean(notifyOnNewUser),
      notifyOnDeposit: Boolean(notifyOnDeposit)
    };
    
    fs.writeFileSync('settings.json', JSON.stringify(settingsData, null, 2));
    
    // อัปเดตตัวแปรในแอพ
    settings.telegramNotifications = settingsData.telegramNotifications;
    
    // ทดสอบการส่งข้อความ
    if (enabled && chatId) {
      sendTelegramNotification('✅ <b>ทดสอบการแจ้งเตือน</b>\nการตั้งค่าการแจ้งเตือน Telegram สำเร็จ!')
        .then(() => {
          console.log('ส่งข้อความทดสอบ Telegram สำเร็จ');
        })
        .catch(err => {
          console.error('ไม่สามารถส่งข้อความทดสอบ Telegram:', err);
        });
    }
    
    res.json({ 
      success: true, 
      message: 'บันทึกการตั้งค่า Telegram สำเร็จ',
      settings: settingsData.telegramNotifications
    });
  } catch (err) {
    console.error('Error updating Telegram settings:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการบันทึกการตั้งค่า Telegram' });
  }
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'กรุณาระบุชื่อผู้ใช้และรหัสผ่าน' });
    }
    
    try {
        const existingUser = await db.get('SELECT * FROM users WHERE username = ?', [username]);
        if (existingUser) {
            return res.status(400).json({ error: 'ชื่อผู้ใช้นี้มีอยู่แล้ว' });
        }
        
        const hashedPassword = hashPassword(password);
        await db.run(
            'INSERT INTO users (username, password, credits) VALUES (?, ?, ?)',
            [username, hashedPassword, defaultSettings.defaultCredits]
        );
        
        // ส่งการแจ้งเตือน Telegram เมื่อมีผู้ใช้ใหม่
        if (settings.telegramNotifications && 
            settings.telegramNotifications.enabled && 
            settings.telegramNotifications.notifyOnNewUser) {
            sendTelegramNotification(`🎉 <b>ผู้ใช้ใหม่ลงทะเบียน</b>\n\nชื่อผู้ใช้: <code>${username}</code>\nเครดิตเริ่มต้น: <code>${defaultSettings.defaultCredits}</code> เครดิต\nเวลา: <code>${new Date().toLocaleString('th-TH')}</code>`);
        }
        
        res.json({ message: 'ลงทะเบียนสำเร็จ' });
    } catch (err) {
        console.error('Error registering user:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการลงทะเบียน' });
    }
});

app.post('/login', async (req, res) => {
    const { username, password, captchaToken } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'กรุณาระบุชื่อผู้ใช้และรหัสผ่าน' });
    }
    
    // ตรวจสอบ Cloudflare Turnstile CAPTCHA token เฉพาะเมื่อเปิดใช้งานระบบแคปซ่า
    if (systemSettings.captchaEnabled) {
        if (!captchaToken) {
            return res.status(400).json({ error: 'กรุณายืนยันว่าคุณไม่ใช่โปรแกรมอัตโนมัติ' });
        }
        
        try {
            // ตรวจสอบความถูกต้องของ CAPTCHA token กับ Cloudflare
            const cloudflareResponse = await axios.post(
                'https://challenges.cloudflare.com/turnstile/v0/siteverify',
                new URLSearchParams({
                    secret: '0x4AAAAAABIlh4l7OoIZ-eR6sRKpbJlkRLU',
                    response: captchaToken,
                    remoteip: req.ip
                }),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );
            
            // หาก CAPTCHA ไม่ถูกต้อง
            if (!cloudflareResponse.data.success) {
                return res.status(400).json({ error: 'การยืนยันล้มเหลว โปรดลองอีกครั้ง' });
            }
        } catch (err) {
            console.error('Error verifying CAPTCHA:', err);
            return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการตรวจสอบแคปซ่า' });
        }
    }
    
    try {
        const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
        if (!user || user.password !== hashPassword(password)) {
            return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
        }
        
        res.json({ success: true, message: 'เข้าสู่ระบบสำเร็จ', username });
    } catch (err) {
        console.error('Error logging in:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการเข้าสู่ระบบ' });
    }
});

app.put('/profile/:username', async (req, res) => {
    const oldUsername = req.params.username;
    const { newUsername, newPassword } = req.body;

    try {
        const existingUser = await db.get('SELECT * FROM users WHERE username = ?', [oldUsername]);
        if (!existingUser) {
            return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
        }

        if (newUsername && newUsername !== oldUsername) {
            const newUserExists = await db.get('SELECT * FROM users WHERE username = ?', [newUsername]);
            if (newUserExists) {
                return res.status(400).json({ error: 'ชื่อผู้ใช้นี้มีอยู่แล้ว' });
            }
            
            // สร้างผู้ใช้ใหม่ด้วยข้อมูลเดิม
            await db.run(
                'INSERT INTO users (username, password, credits) VALUES (?, ?, ?)',
                [newUsername, existingUser.password, existingUser.credits]
            );
            
            // อัปเดตความเป็นเจ้าของบอท
            await db.run('UPDATE bot_states SET owner = ? WHERE owner = ?', [newUsername, oldUsername]);
            
            // ย้ายความสัมพันธ์กับบอท
            await db.run('UPDATE user_bots SET username = ? WHERE username = ?', [newUsername, oldUsername]);
            
            // ลบผู้ใช้เดิม
            await db.run('DELETE FROM users WHERE username = ?', [oldUsername]);
        }

        if (newPassword) {
            const username = newUsername || oldUsername;
            const hashedPassword = hashPassword(newPassword);
            await db.run('UPDATE users SET password = ? WHERE username = ?', [hashedPassword, username]);
        }

        await saveBotStates();

        res.json({ 
            message: 'อัพเดทโปรไฟล์สำเร็จ',
            username: newUsername || oldUsername 
        });
    } catch (err) {
        console.error('Error updating profile:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการอัพเดทโปรไฟล์' });
    }
});

app.get('/bots/:username', async (req, res) => {
    const username = req.params.username;
    
    try {
        const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
        if (!user) {
            return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
        }

        // ดึงรายการบอทที่ผู้ใช้เป็นเจ้าของ
        const userBots = await db.all('SELECT bot_id FROM bot_states WHERE owner = ?', [username]);
        const botIds = userBots.map(bot => bot.bot_id);
        
        // อัปเดตความสัมพันธ์ระหว่างผู้ใช้และบอท
        await db.run('DELETE FROM user_bots WHERE username = ?', [username]);
        const stmt = await db.prepare('INSERT INTO user_bots (username, bot_id) VALUES (?, ?)');
        for (const botId of botIds) {
            await stmt.run(username, botId);
        }
        await stmt.finalize();
        
        res.json(botIds);
    } catch (err) {
        console.error('Error getting user bots:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลบอท' });
    }
});

app.post('/upload', upload.single('botFile'), async (req, res) => {
    const { username } = req.body;
    
    try {
        const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
        if (!user) {
            return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อนอัปโหลดบอท' });
        }

        if (!req.file) return res.status(400).json({ error: 'ไม่มีไฟล์อัปโหลด กรุณาเลือกไฟล์ก่อน' });

        const installCommand = req.body.installCommand || '';
        const ext = path.extname(req.file.filename).toLowerCase();
        let botId;

        if (ext === '.zip' || ext === '.7z') {
            botId = req.file.filename.split(ext)[0];
            const archivePath = path.join(__dirname, 'bots', req.file.filename);
            const botFolder = path.join(__dirname, 'bots', botId);

            try {
                if (ext === '.zip') {
                    await new Promise((resolve, reject) => {
                        fs.createReadStream(archivePath)
                            .pipe(unzipper.Extract({ path: botFolder }))
                            .on('close', resolve)
                            .on('error', reject);
                    });
                } else {
                    await extractSeven(archivePath, botFolder);
                }

                if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);

                const mainFolder = findIndexJsOrPy(botFolder);
                if (!mainFolder) {
                    if (fs.existsSync(botFolder)) fs.rmSync(botFolder, { recursive: true, force: true });
                    return res.status(400).json({ error: 'ไม่พบไฟล์ index.js หรือ main.py ในโฟลเดอร์หรือโฟลเดอร์ย่อย' });
                }

                const isPython = fs.existsSync(path.join(mainFolder, 'main.py')) || fs.existsSync(path.join(mainFolder, '__main__.py'));
                bots[botId] = {
                    folder: botId,
                    mainPath: mainFolder,
                    status: 'หยุด',
                    process: null,
                    logs: [`[ข้อมูล] อัปโหลดบอท (โฟลเดอร์): ${botId}`],
                    installCommand,
                    isFolder: true,
                    owner: username,
                    type: isPython ? 'python' : 'javascript'
                };

                await saveBotState(botId, {
                    status: 'หยุด',
                    isFolder: true,
                    folder: botId,
                    installCommand,
                    owner: username,
                    type: isPython ? 'python' : 'javascript'
                });
            } catch (err) {
                if (fs.existsSync(botFolder)) fs.rmSync(botFolder, { recursive: true, force: true });
                return res.status(500).json({ error: `เกิดข้อผิดพลาดในการแตกไฟล์ zip: ${err.message}` });
            }
        } else if (ext === '.js' || ext === '.py') {
            botId = req.file.filename;
            const botPath = path.join(__dirname, 'bots', botId);
            if (!fs.existsSync(botPath)) {
                return res.status(500).json({ error: `ไม่พบไฟล์ ${botId} หลังอัปโหลด` });
            }

            bots[botId] = {
                filename: botId,
                mainPath: botPath,
                status: 'หยุด',
                process: null,
                logs: [`[ข้อมูล] อัปโหลดบอท (ไฟล์เดี่ยว): ${botId}`],
                installCommand,
                isFolder: false,
                owner: username,
                type: ext === '.py' ? 'python' : 'javascript'
            };
            
            await saveBotState(botId, {
                status: 'หยุด',
                isFolder: false,
                folder: null,
                installCommand,
                owner: username,
                type: ext === '.py' ? 'python' : 'javascript'
            });
        }

        // เพิ่มบอทให้กับผู้ใช้
        await db.run('INSERT OR REPLACE INTO user_bots (username, bot_id) VALUES (?, ?)', [username, botId]);

        res.json({ message: 'อัปโหลดบอทสำเร็จ', botId });
    } catch (err) {
        console.error('Error uploading bot:', err);
        res.status(500).json({ error: `เกิดข้อผิดพลาดในการอัปโหลดบอท: ${err.message}` });
    }
});

app.post('/install/:botId', async (req, res) => {
    const botId = req.params.botId;
    const { installCommand, username } = req.body;
    
    try {
        const botState = await db.get('SELECT * FROM bot_states WHERE bot_id = ?', [botId]);
        if (!botState || botState.owner !== username) {
            return res.status(403).json({ error: 'คุณไม่มีสิทธิ์ในการจัดการบอทนี้' });
        }
        
        if (!installCommand) {
            return res.status(400).json({ error: 'กรุณาระบุคำสั่งติดตั้ง' });
        }

        // สร้างโฟลเดอร์สำหรับไฟล์เดี่ยวถ้ายังไม่มี
        const botPath = path.join(__dirname, 'bots', botId);
        if (!bots[botId].isFolder) {
            const botFolder = path.join(__dirname, 'bots', botId.replace(/\.[^/.]+$/, ''));
            if (!fs.existsSync(botFolder)) {
                fs.mkdirSync(botFolder);
            }
            // ย้ายไฟล์เข้าโฟลเดอร์
            const oldPath = path.join(__dirname, 'bots', botId);
            const newPath = path.join(botFolder, botId);
            if (fs.existsSync(oldPath)) {
                fs.renameSync(oldPath, newPath);
            }
            // อัพเดทข้อมูลบอท
            bots[botId].mainPath = botFolder;
            bots[botId].isFolder = true;
            bots[botId].folder = botId.replace(/\.[^/.]+$/, '');
            await saveBotState(botId, {
                ...botState,
                isFolder: true,
                folder: botId.replace(/\.[^/.]+$/, '')
            });
        }

        const cwd = bots[botId].mainPath;
        const packageJsonPath = path.join(cwd, 'package.json');
        const nodeModulesPath = path.join(cwd, 'node_modules');

        const cleanCommand = installCommand.replace(/^npm\s+install\s+/, '').trim();
        const modules = cleanCommand.split(' ').filter(m => m);
        const moduleChecks = modules.map(module => {
            const [name, version] = module.split('@');
            return { name, version: version || null };
        });

        try {
            let dependencies = {};
            if (fs.existsSync(packageJsonPath)) {
                const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                dependencies = {
                    ...packageJson.dependencies,
                    ...packageJson.devDependencies
                };
            } else {
                // สร้าง package.json ถ้ายังไม่มี
                fs.writeFileSync(packageJsonPath, JSON.stringify({
                    name: botId.replace(/\.[^/.]+$/, ''),
                    version: '1.0.0',
                    dependencies: {},
                    devDependencies: {}
                }, null, 2));
            }

            const allInstalled = moduleChecks.every(({ name, version }) => {
                const installedVersion = dependencies[name];
                if (!installedVersion) return false;
                if (!version) return true;
                const cleanInstalledVersion = installedVersion.replace(/^[^\d]+/, '');
                return cleanInstalledVersion === version;
            });

            if (allInstalled) {
                const allExist = moduleChecks.every(({ name }) =>
                    fs.existsSync(path.join(nodeModulesPath, name))
                );

                if (allExist) {
                    bots[botId].logs.push(`[ข้อมูล] โมดูล ${cleanCommand} ถูกติดตั้งแล้วทั้งหมด`);
                    return res.json({ message: 'โมดูลทั้งหมดถูกติดตั้งแล้ว', botId });
                }
            }

            bots[botId].installCommand = cleanCommand;
            bots[botId].logs.push(`[ข้อมูล] เริ่มติดตั้งโมดูล: ${installCommand}`);
            
            // อัปเดตคำสั่งติดตั้งในฐานข้อมูล
            await db.run('UPDATE bot_states SET install_command = ? WHERE bot_id = ?', [cleanCommand, botId]);

            const installProcess = spawn('npm', ['install', ...modules], { cwd, shell: true });

            installProcess.stdout.on('data', (data) => {
                if (bots[botId]) bots[botId].logs.push(`[ผลลัพธ์การติดตั้ง] ${data.toString().trim()}`);
            });
            installProcess.stderr.on('data', (data) => {
                if (bots[botId]) bots[botId].logs.push(`[ข้อผิดพลาด] ${data.toString().trim()}`);
            });
            installProcess.on('close', (code) => {
                if (bots[botId]) {
                    bots[botId].logs.push(`[ข้อมูล] การติดตั้งเสร็จสิ้น (รหัส: ${code})`);
                }
            });

            res.json({ message: 'เริ่มการติดตั้งโมดูล', botId });
        } catch (err) {
            bots[botId].logs.push(`[ข้อผิดพลาด] การตรวจสอบโมดูลล้มเหลว: ${err.message}`);
            return res.status(500).json({ error: `เกิดข้อผิดพลาด: ${err.message}` });
        }
    } catch (err) {
        console.error('Error installing modules:', err);
        res.status(500).json({ error: `เกิดข้อผิดพลาดในการติดตั้งโมดูล: ${err.message}` });
    }
});

app.post('/install/python/:botId', async (req, res) => {
    const botId = req.params.botId;
    const { installCommand, username } = req.body;
    
    try {
        const botState = await db.get('SELECT * FROM bot_states WHERE bot_id = ?', [botId]);
        if (!botState || botState.owner !== username || botState.type !== 'python') {
            return res.status(403).json({ error: 'คุณไม่มีสิทธิ์ในการจัดการบอทนี้ หรือบอทนี้ไม่ใช่ Python' });
        }
        
        if (!installCommand) {
            return res.status(400).json({ error: 'กรุณาระบุคำสั่งติดตั้ง (เช่น pip install <package>)' });
        }

        const cwd = bots[botId].isFolder ? bots[botId].mainPath : path.join(__dirname, 'bots');
        const requirementsPath = path.join(cwd, 'requirements.txt');

        try {
            let packages = installCommand.replace(/^pip\s+install\s+/, '').trim().split(' ');
            packages = packages.filter(p => p);

            let existingRequirements = [];
            if (fs.existsSync(requirementsPath)) {
                existingRequirements = fs.readFileSync(requirementsPath, 'utf8').split('\n').filter(line => line && !line.startsWith('#'));
            }

            const allInstalled = packages.every(pkg => existingRequirements.some(req => req.includes(pkg.split('@')[0])));
            if (allInstalled) {
                bots[botId].logs.push(`[ข้อมูล] โมดูล ${installCommand} ถูกติดตั้งแล้วทั้งหมด`);
                return res.json({ message: 'โมดูลทั้งหมดถูกติดตั้งแล้ว', botId });
            }

            bots[botId].installCommand = installCommand;
            bots[botId].logs.push(`[ข้อมูล] เริ่มติดตั้งโมดูล Python: ${installCommand}`);
            
            // อัปเดตคำสั่งติดตั้งในฐานข้อมูล
            await db.run('UPDATE bot_states SET install_command = ? WHERE bot_id = ?', [installCommand, botId]);

            const installProcess = spawn('pip', ['install', ...packages], { cwd, shell: true });

            installProcess.stdout.on('data', (data) => {
                if (bots[botId]) bots[botId].logs.push(`[ผลลัพธ์การติดตั้ง] ${data.toString().trim()}`);
            });
            installProcess.stderr.on('data', (data) => {
                if (bots[botId]) bots[botId].logs.push(`[ข้อผิดพลาด] ${data.toString().trim()}`);
            });
            installProcess.on('close', (code) => {
                if (bots[botId]) {
                    bots[botId].logs.push(`[ข้อมูล] การติดตั้งเสร็จสิ้น (รหัส: ${code})`);
                    if (code === 0 && packages.length > 0) {
                        fs.appendFileSync(requirementsPath, '\n' + packages.join('\n'), 'utf8');
                    }
                }
            });

            res.json({ message: 'เริ่มการติดตั้งโมดูล Python', botId });
        } catch (err) {
            bots[botId].logs.push(`[ข้อผิดพลาด] การติดตั้งโมดูล Python ล้มเหลว: ${err.message}`);
            return res.status(500).json({ error: `เกิดข้อผิดพลาด: ${err.message}` });
        }
    } catch (err) {
        console.error('Error installing Python modules:', err);
        res.status(500).json({ error: `เกิดข้อผิดพลาดในการติดตั้งโมดูล Python: ${err.message}` });
    }
});

app.post('/start/:botId', async (req, res) => {
    const botId = req.params.botId;
    const { username } = req.body;
    
    try {
        const botState = await db.get('SELECT * FROM bot_states WHERE bot_id = ?', [botId]);
        if (!botState) {
            return res.status(404).json({ error: 'ไม่พบบอท' });
        }
        // Allow admin override if username is one of the allowed admin names
        if (botState.owner !== username && !['admin', 'แอดมิน', 'อดมิน'].includes(username)) {
            return res.status(403).json({ error: 'คุณไม่มีสิทธิ์ในการเริ่มบอทนี้' });
        }

        if (bots[botId].status === 'กำลังทำงาน') {
            return res.json({ message: 'บอทกำลังทำงานอยู่แล้ว' });
        }

        // ตรวจสอบว่าบอทมีเวลาหมดอายุหรือไม่
        const now = Date.now();
        const hasValidExpireTime = botState.expire_time && botState.expire_time > now;
        
        // ถ้าไม่มีเวลาหมดอายุหรือเวลาหมดอายุแล้ว ให้หักเครดิต
        if (!hasValidExpireTime) {
            const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
            if (user.credits < systemSettings.runBotCredits) {
                return res.status(403).json({ 
                    error: 'เครดิตไม่เพียงพอ',
                    currentCredits: user.credits,
                    requiredCredits: systemSettings.runBotCredits
                });
            }

            // ลดเครดิตผู้ใช้
            await db.run('UPDATE users SET credits = credits - ? WHERE username = ?', [systemSettings.runBotCredits, username]);
            
            // ตั้งเวลาหมดอายุให้เป็น 24 ชั่วโมง
            const expireTime = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
            bots[botId].expireTime = expireTime;
            
            // อัปเดตเวลาหมดอายุในฐานข้อมูล
            await db.run('UPDATE bot_states SET expire_time = ? WHERE bot_id = ?', [expireTime, botId]);
            
            // เพิ่มข้อความบันทึกว่ามีการซื้อเวลารัน 1 วัน
            bots[botId].logs.push(`[ข้อมูล] หักเครดิต ${systemSettings.runBotCredits} เครดิต สำหรับการรันบอท 1 วัน`);
        } else {
            // ถ้ามีเวลาหมดอายุที่ยังไม่หมด ไม่ต้องหักเครดิต เพียงแค่เพิ่มบันทึก
            bots[botId].logs.push(`[ข้อมูล] เริ่มรันบอท (ไม่เสียเครดิต เนื่องจากยังอยู่ในช่วงเวลาที่ซื้อไว้)`);
        }

        const botPath = bots[botId].mainPath;
        // For non-folder bots use its directory instead
        const cwd = bots[botId].isFolder ? botPath : require('path').dirname(botPath);
        let command;

        if (bots[botId].type === 'python') {
            command = bots[botId].isFolder 
                ? ['main.py'] // หรือ '__main__.py' ถ้าต้องการ
                : [bots[botId].filename];
        } else { // javascript
            command = bots[botId].isFolder 
                ? ['index.js'] 
                : [bots[botId].filename];
        }

        const fullPath = bots[botId].isFolder 
            ? path.join(botPath, bots[botId].type === 'python' ? 'main.py' : 'index.js') 
            : botPath;
        if (!fs.existsSync(fullPath)) {
            await db.run('DELETE FROM bot_states WHERE bot_id = ?', [botId]);
            delete bots[botId];
            return res.status(404).json({ error: 'ไฟล์บอทหายไป กรุณาอัปโหลดใหม่' });
        }

        if (!bots[botId].logs || bots[botId].logs.length === 0) {
            bots[botId].logs = [];
        }
        bots[botId].logs.push(`[ข้อมูล] เริ่มรันบอทใหม่: ${botId}`);

        const botProcess = spawn(bots[botId].type === 'python' ? 'python3' : 'node', command, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

        bots[botId].status = 'กำลังทำงาน';
        bots[botId].process = botProcess;
        
        // อัปเดตสถานะในฐานข้อมูล
        await db.run('UPDATE bot_states SET status = ? WHERE bot_id = ?', ['กำลังทำงาน', botId]);

        botProcess.stdout.on('data', (data) => {
            if (bots[botId]) bots[botId].logs.push(`[ผลลัพธ์] ${data.toString().trim()}`);
        });
        botProcess.stderr.on('data', (data) => {
            if (bots[botId]) bots[botId].logs.push(`[ข้อผิดพลาด] ${data.toString().trim()}`);
        });
        botProcess.on('error', async (err) => {
            if (bots[botId]) {
                bots[botId].logs.push(`[ข้อผิดพลาด] ไม่สามารถรันบอทได้: ${err.message}`);
                bots[botId].status = 'หยุด';
                bots[botId].process = null;
                
                // อัปเดตสถานะในฐานข้อมูล
                await db.run('UPDATE bot_states SET status = ? WHERE bot_id = ?', ['หยุด', botId]);
            }
        });
        botProcess.on('close', async (code) => {
            if (bots[botId]) {
                const timestamp = new Date().toLocaleTimeString('th-TH');
                bots[botId].logs.push(`ℹ️ [${timestamp}] หยุดบอท ${botId} สำเร็จ`);
                bots[botId].logs.push(`🛑 [${timestamp}] บอทหยุดทำงาน (รหัส: ${code})`);
                bots[botId].status = 'หยุด';
                bots[botId].process = null;
                
                // อัปเดตสถานะในฐานข้อมูล
                await db.run('UPDATE bot_states SET status = ? WHERE bot_id = ?', ['หยุด', botId]);
            }
        });

        res.json({ message: 'เริ่มบอทสำเร็จ', botId });
        await saveBotStates();
    } catch (err) {
        console.error('Error starting bot:', err);
        res.status(500).json({ error: `เกิดข้อผิดพลาดในการเริ่มบอท: ${err.message}` });
    }
});

app.post('/stop/:botId', async (req, res) => {
    const botId = req.params.botId;
    const { username } = req.body;
    
    try {
        const botState = await db.get('SELECT * FROM bot_states WHERE bot_id = ?', [botId]);
        if (!botState) {
            return res.status(404).json({ error: 'ไม่พบบอท' });
        }
        // Allow admin override if username is one of the allowed admin names
        if (botState.owner !== username && !['admin', 'แอดมิน', 'อดมิน'].includes(username)) {
            return res.status(403).json({ error: 'คุณไม่มีสิทธิ์ในการหยุดบอทนี้' });
        }
        
        if (bots[botId].status === 'หยุด') {
            return res.json({ message: 'บอทหยุดอยู่แล้ว' });
        }

        const botProcess = bots[botId].process;
        if (botProcess) {
            try {
                botProcess.kill('SIGTERM');

                setTimeout(() => {
                    if (bots[botId] && bots[botId].process && !bots[botId].process.killed) {
                        botProcess.kill('SIGKILL');
                        bots[botId].logs.push(`[ข้อมูล] บังคับหยุดบอท ${botId} ด้วย SIGKILL`);
                    }
                }, 2000);

                bots[botId].status = 'หยุด';
                bots[botId].process = null;
                bots[botId].logs.push(`[ข้อมูล] หยุดบอท ${botId} สำเร็จ`);
                
                // อัปเดตสถานะในฐานข้อมูล
                await db.run('UPDATE bot_states SET status = ? WHERE bot_id = ?', ['หยุด', botId]);
            } catch (err) {
                bots[botId].logs.push(`[ข้อผิดพลาด] ไม่สามารถหยุดบอทได้: ${err.message}`);
                return res.status(500).json({ error: `ไม่สามารถหยุดบอทได้: ${err.message}` });
            }
        }

        res.json({ message: 'หยุดบอทสำเร็จ', botId });
        await saveBotStates();
    } catch (err) {
        console.error('Error stopping bot:', err);
        res.status(500).json({ error: `เกิดข้อผิดพลาดในการหยุดบอท: ${err.message}` });
    }
});

app.get('/credits/:username', async (req, res) => {
    const username = req.params.username;
    
    try {
        const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
        if (!user) {
            return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
        }
        
        res.json({ credits: user.credits || 0 });
    } catch (err) {
        console.error('Error getting credits:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลเครดิต' });
    }
});

app.post('/admin/credits/:username/add', async (req, res) => {
    const username = req.params.username;
    const { credits } = req.body;
    
    try {
        const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
        if (!user) {
            return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
        }

        if (!credits || credits <= 0) {
            return res.status(400).json({ error: 'กรุณาระบุจำนวนเครดิตที่ถูกต้อง' });
        }

        await db.run('UPDATE users SET credits = credits + ? WHERE username = ?', [parseInt(credits), username]);
        const updatedUser = await db.get('SELECT * FROM users WHERE username = ?', [username]);
        
        res.json({ message: 'เพิ่มเครดิตสำเร็จ', credits: updatedUser.credits });
    } catch (err) {
        console.error('Error adding credits:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการเพิ่มเครดิต' });
    }
});

app.post('/admin/credits/:username/remove', async (req, res) => {
    const username = req.params.username;
    const { credits } = req.body;
    
    try {
        const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
        if (!user) {
            return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
        }

        if (!credits || credits <= 0) {
            return res.status(400).json({ error: 'กรุณาระบุจำนวนเครดิตที่ถูกต้อง' });
        }

        if (user.credits < credits) {
            return res.status(400).json({ error: 'เครดิตไม่เพียงพอที่จะลด' });
        }

        await db.run('UPDATE users SET credits = credits - ? WHERE username = ?', [credits, username]);
        const updatedUser = await db.get('SELECT * FROM users WHERE username = ?', [username]);
        
        res.json({ message: 'ลดเครดิตสำเร็จ', credits: updatedUser.credits });
    } catch (err) {
        console.error('Error removing credits:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการลดเครดิต' });
    }
});

app.get('/status/:botId', async (req, res) => {
    const botId = req.params.botId;
    const { username } = req.query;
    
    try {
        const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
        if (!user) {
            return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
        }

        if (!bots[botId]) {
            return res.status(404).json({ error: 'ไม่พบบอท' });
        }

        const botState = await db.get('SELECT * FROM bot_states WHERE bot_id = ?', [botId]);
        if (!botState) {
            return res.status(404).json({ error: 'ไม่พบบอทในฐานข้อมูล' });
        }

        // Allow admin override if username is one of the allowed admin names
        if (botState.owner !== username && !['admin', 'แอดมิน', 'อดมิน'].includes(username)) {
            return res.status(403).json({ error: 'คุณไม่มีสิทธิ์ในการดูสถานะบอทนี้' });
        }

        return res.json({
            botId,
            status: bots[botId].status,
            logs: bots[botId].logs.slice(-50),
            installCommand: bots[botId].installCommand,
            expireTime: botState.expire_time || null  // เพิ่มการส่งค่า expire_time จากฐานข้อมูล
        });
    } catch (err) {
        console.error('Error getting bot status:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงสถานะบอท' });
    }
});

app.delete('/delete/:botId', async (req, res) => {
    const botId = req.params.botId;
    const { username } = req.body;
    
    try {
        const botState = await db.get('SELECT * FROM bot_states WHERE bot_id = ?', [botId]);
        if (!botState || botState.owner !== username) {
            return res.status(403).json({ error: 'คุณไม่มีสิทธิ์ในการลบบอทนี้' });
        }

        if (bots[botId].process) {
            bots[botId].process.kill('SIGTERM');
            setTimeout(() => {
                if (bots[botId] && bots[botId].process && !bots[botId].process.killed) {
                    bots[botId].process.kill('SIGKILL');
                }
            }, 2000);
        }

        const botPath = bots[botId].isFolder
            ? path.join(__dirname, 'bots', bots[botId].folder)
            : bots[botId].mainPath;

        if (fs.existsSync(botPath)) {
            if (bots[botId].isFolder) {
                fs.rmSync(botPath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(botPath);
            }
        }
        
        // ลบบอทจากฐานข้อมูล
        await db.run('DELETE FROM bot_states WHERE bot_id = ?', [botId]);
        await db.run('DELETE FROM user_bots WHERE bot_id = ?', [botId]);
        
        delete bots[botId];
        
        res.json({ message: 'ลบบอทสำเร็จ', botId });
    } catch (err) {
        console.error('Error deleting bot:', err);
        res.status(500).json({ error: `เกิดข้อผิดพลาดในการลบบอท: ${err.message}` });
    }
});

app.get('/files/:botId', async (req, res) => {
    const botId = req.params.botId;
    const { username } = req.query;
    
    try {
        const botState = await db.get('SELECT * FROM bot_states WHERE bot_id = ?', [botId]);
        if (!botState || botState.owner !== username) {
            return res.status(403).json({ error: 'คุณไม่มีสิทธิ์ในการดูไฟล์บอทนี้' });
        }

        const basePath = bots[botId].isFolder
            ? path.join(__dirname, 'bots', bots[botId].folder)
            : path.join(__dirname, 'bots');

        if (!fs.existsSync(basePath)) {
            return res.status(404).json({ error: 'โฟลเดอร์บอทหายไป' });
        }

        const structure = bots[botId].isFolder
            ? getFolderStructure(basePath)
            : [{
                name: bots[botId].filename,
                type: 'file',
                path: bots[botId].filename
            }];

        res.json(structure);
    } catch (err) {
        console.error('Error getting bot files:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลไฟล์บอท' });
    }
});

app.get('/file/:botId/*', async (req, res) => {
    const botId = req.params.botId;
    const filePath = req.params[0];
    const { username } = req.query;
    
    try {
        const botState = await db.get('SELECT * FROM bot_states WHERE bot_id = ?', [botId]);
        if (!botState || botState.owner !== username) {
            return res.status(403).json({ error: 'คุณไม่มีสิทธิ์ในการดูไฟล์นี้' });
        }

        const basePath = bots[botId].isFolder
            ? path.join(__dirname, 'bots', bots[botId].folder)
            : path.join(__dirname, 'bots');
        const fullPath = path.join(basePath, filePath);

        if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
            return res.status(404).json({ error: 'ไม่พบไฟล์' });
        }

        const content = fs.readFileSync(fullPath, 'utf8');
        res.json({ content });
    } catch (err) {
        console.error('Error reading file:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการอ่านไฟล์' });
    }
});

app.put('/file/:botId/*', async (req, res) => {
    const botId = req.params.botId;
    const filePath = req.params[0];
    const { content, username } = req.body;
    
    try {
        const botState = await db.get('SELECT * FROM bot_states WHERE bot_id = ?', [botId]);
        if (!botState || botState.owner !== username) {
            return res.status(403).json({ error: 'คุณไม่มีสิทธิ์ในการแก้ไขไฟล์นี้' });
        }

        const basePath = bots[botId].isFolder
            ? path.join(__dirname, 'bots', bots[botId].folder)
            : path.join(__dirname, 'bots');
        const fullPath = path.join(basePath, filePath);

        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ error: 'ไม่พบไฟล์' });
        }

        try {
            // บันทึกการเปลี่ยนแปลงลงไฟล์
            fs.writeFileSync(fullPath, content, 'utf8');
            
            // เพิ่มบันทึกและอัพเดท state
            if (bots[botId]) {
                bots[botId].logs.push(`[ข้อมูล] บันทึกการเปลี่ยนแปลงไฟล์: ${filePath}`);
                
                // บันทึก state ลงฐานข้อมูล
                await saveBotState(botId, {
                    status: bots[botId].status,
                    isFolder: bots[botId].isFolder,
                    folder: bots[botId].folder,
                    installCommand: bots[botId].installCommand,
                    owner: bots[botId].owner,
                    type: bots[botId].type,
                    expireTime: bots[botId].expireTime
                });

                // รีสตาร์ทบอทถ้ากำลังทำงานอยู่
                if (bots[botId].status === 'กำลังทำงาน' && bots[botId].process) {
                    bots[botId].process.kill('SIGTERM');
                    setTimeout(() => {
                        if (bots[botId] && bots[botId].process && !bots[botId].process.killed) {
                            bots[botId].process.kill('SIGKILL');
                        }
                        startBotProcess(botId, username);
                    }, 1000);
                }
            }

            res.json({ success: true, message: 'บันทึกและอัพเดทไฟล์สำเร็จ' });
        } catch (err) {
            res.status(500).json({ error: `ไม่สามารถบันทึกไฟล์ได้: ${err.message}` });
        }
    } catch (err) {
        console.error('Error updating file:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการอัพเดทไฟล์' });
    }
});

app.post('/command/:botId', async (req, res) => {
    const botId = req.params.botId;
    const { command, username } = req.body;
    
    try {
        const botState = await db.get('SELECT * FROM bot_states WHERE bot_id = ?', [botId]);
        if (!botState || botState.owner !== username) {
            return res.status(403).json({ error: 'คุณไม่มีสิทธิ์ในการส่งคำสั่งนี้' });
        }

        if (command === 'ล้าง') {
            bots[botId].logs = [];
            return res.json({ message: 'ล้างบันทึกเรียบร้อย' });
        } else if (command.startsWith('บันทึก ')) {
            const logMessage = command.slice(6);
            bots[botId].logs.push(`[ผู้ใช้] ${logMessage}`);
            return res.json({ message: 'เพิ่มบันทึกเรียบร้อย' });
        } else {
            bots[botId].logs.push(`[คำสั่ง] ${command}`);
            if (bots[botId].status === 'กำลังทำงาน' && bots[botId].process) {
                bots[botId].process.stdin.write(command + '\n');
            }
            return res.json({ message: 'ดำเนินการคำสั่งเรียบร้อย' });
        }
    } catch (err) {
        console.error('Error executing command:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดำเนินการคำสั่ง' });
    }
});

// เพิ่ม endpoints สำหรับดึงข้อมูลสถิติการเติมเงิน
app.get('/admin/payment-stats/daily', async (req, res) => {
    try {
        // ดึงข้อมูลการเติมเงินวันนี้
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayTimestamp = Math.floor(today.getTime() / 1000);
        
        // แบ่งเป็น 6 ช่วงเวลา (4 ชั่วโมงต่อช่วง)
        const periods = [];
        for (let i = 0; i < 6; i++) {
            const startPeriod = new Date(today);
            startPeriod.setHours(i * 4, 0, 0, 0);
            const endPeriod = new Date(today);
            endPeriod.setHours((i + 1) * 4, 0, 0, 0);
            
            const startTimestamp = Math.floor(startPeriod.getTime() / 1000);
            const endTimestamp = Math.floor(endPeriod.getTime() / 1000);
            
            const periodData = await db.get(
                'SELECT SUM(amount) as total FROM payments WHERE timestamp >= ? AND timestamp < ?',
                [startTimestamp, endTimestamp]
            );
            
            periods.push({
                period: `${i * 4}:00`,
                amount: periodData.total || 0
            });
        }
        
        // ดึงยอดรวมการเติมเงินวันนี้
        const dailyTotal = await db.get(
            'SELECT SUM(amount) as total FROM payments WHERE timestamp >= ?',
            [todayTimestamp]
        );
        
        res.json({
            periods,
            dailyTotal: dailyTotal.total || 0
        });
    } catch (err) {
        console.error('Error getting daily payment stats:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลสถิติการเติมเงินรายวัน' });
    }
});

app.get('/admin/payment-stats/monthly', async (req, res) => {
    try {
        // ดึงข้อมูลการเติมเงินเดือนนี้
        const now = new Date();
        const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const firstDayTimestamp = Math.floor(firstDayOfMonth.getTime() / 1000);
        
        // จำนวนวันในเดือนปัจจุบัน
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        
        // แบ่งเป็นรายวัน
        const dailyData = [];
        for (let day = 1; day <= daysInMonth; day++) {
            const startDate = new Date(now.getFullYear(), now.getMonth(), day);
            startDate.setHours(0, 0, 0, 0);
            const endDate = new Date(now.getFullYear(), now.getMonth(), day + 1);
            endDate.setHours(0, 0, 0, 0);
            
            const startTimestamp = Math.floor(startDate.getTime() / 1000);
            const endTimestamp = Math.floor(endDate.getTime() / 1000);
            
            // ถ้าวันที่ยังไม่มาถึง ให้ตั้งค่าเป็น 0
            let amount = 0;
            if (day <= now.getDate()) {
                const dayData = await db.get(
                    'SELECT SUM(amount) as total FROM payments WHERE timestamp >= ? AND timestamp < ?',
                    [startTimestamp, endTimestamp]
                );
                amount = dayData.total || 0;
            }
            
            dailyData.push({
                day,
                amount
            });
        }
        
        // ดึงยอดรวมการเติมเงินเดือนนี้
        const monthlyTotal = await db.get(
            'SELECT SUM(amount) as total FROM payments WHERE timestamp >= ?',
            [firstDayTimestamp]
        );
        
        res.json({
            dailyData,
            monthlyTotal: monthlyTotal.total || 0
        });
    } catch (err) {
        console.error('Error getting monthly payment stats:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลสถิติการเติมเงินรายเดือน' });
    }
});

// เพิ่มการบันทึกสถานะทุก 5 นาที
// ตรวจสอบบอทที่หมดอายุทุก 5 นาที
setInterval(async () => {
    const now = Date.now();
    for (const [botId, bot] of Object.entries(bots)) {
        if (bot.expireTime && now > bot.expireTime && bot.status === 'กำลังทำงาน') {
            if (bot.process) {
                bot.process.kill();
                bot.status = 'หยุด';
                bot.process = null;
                bot.logs.push('[ระบบ] บอทหยุดทำงานเนื่องจากหมดเวลาใช้งาน');
                
                // อัปเดตสถานะในฐานข้อมูล
                await db.run('UPDATE bot_states SET status = ? WHERE bot_id = ?', ['หยุด', botId]);
            }
        }
    }
    await saveBotStates();
}, 300000);

// Admin Routes
app.get('/admin/users', async (req, res) => {
    try {
        const users = await db.all('SELECT * FROM users');
        const userBots = await db.all('SELECT * FROM user_bots');
        
        const usersObj = {};
        for (const user of users) {
            usersObj[user.username] = {
                password: user.password,
                credits: user.credits,
                bots: []
            };
        }
        
        for (const relation of userBots) {
            if (usersObj[relation.username]) {
                usersObj[relation.username].bots.push(relation.bot_id);
            }
        }
        
        res.json(usersObj);
    } catch (err) {
        console.error('Error getting users:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลผู้ใช้' });
    }
});

app.get('/admin/bots', async (req, res) => {
    try {
        const botStates = await db.all('SELECT * FROM bot_states');
        res.json(bots);
    } catch (err) {
        console.error('Error getting bots:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลบอท' });
    }
});

app.get('/bot/:botId', async (req, res) => {
    try {
        const botId = req.params.botId;
        console.log('Requesting bot data for:', botId);
        console.log('Available bots:', Object.keys(bots));

        if (!bots[botId]) {
            console.log('Bot not found');
            return res.status(404).json({ error: 'ไม่พบบอท' });
        }

        const bot = bots[botId];
        console.log('Found bot:', bot);

        const botData = {
            id: botId,
            status: bot.status || 'หยุด',
            owner: bot.owner || 'ไม่มีเจ้าของ',
            isFolder: bot.isFolder || false,
            installCommand: bot.installCommand || '',
            logs: bot.logs || []
        };

        console.log('Sending bot data:', botData);
        res.json(botData);
    } catch (error) {
        console.error('Error fetching bot data:', error);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลบอท' });
    }
});

app.put('/admin/users/:username', async (req, res) => {
    try {
        const username = req.params.username;
        const { password } = req.body;

        console.log('Updating password for user:', username);

        const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
        if (!user) {
            console.log('User not found:', username);
            return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
        }

        if (!password) {
            console.log('No password provided');
            return res.status(400).json({ error: 'กรุณาระบุรหัสผ่านใหม่' });
        }

        const hashedPassword = hashPassword(password);
        await db.run('UPDATE users SET password = ? WHERE username = ?', [hashedPassword, username]);

        console.log('Password updated successfully for user:', username);
        res.json({ message: 'อัพเดทรหัสผ่านสำเร็จ' });
    } catch (error) {
        console.error('Error updating password:', error);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการอัพเดทรหัสผ่าน' });
    }
});

app.delete('/admin/users/:username', async (req, res) => {
    try {
        const username = req.params.username;
        
        const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
        if (!user) {
            return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
        }
        
        // ดึงรายการบอทของผู้ใช้
        const userBots = await db.all('SELECT bot_id FROM user_bots WHERE username = ?', [username]);
        
        // ลบบอทของผู้ใช้
        for (const { bot_id } of userBots) {
            if (bots[bot_id] && bots[bot_id].owner === username) {
                if (bots[bot_id].process) {
                    bots[bot_id].process.kill();
                }
                const botPath = bots[bot_id].isFolder
                    ? path.join('bots', bots[bot_id].folder)
                    : path.join('bots', bot_id);
                if (fs.existsSync(botPath)) {
                    if (bots[bot_id].isFolder) {
                        fs.rmSync(botPath, { recursive: true, force: true });
                    } else {
                        fs.unlinkSync(botPath);
                    }
                }
                delete bots[bot_id];
                
                // ลบบอทจากฐานข้อมูล
                await db.run('DELETE FROM bot_states WHERE bot_id = ?', [bot_id]);
            }
        }
        
        // ลบผู้ใช้จากฐานข้อมูล (จะลบความสัมพันธ์กับบอทด้วยเนื่องจาก ON DELETE CASCADE)
        await db.run('DELETE FROM users WHERE username = ?', [username]);
        
        res.json({ message: 'ลบผู้ใช้และบอทของผู้ใช้สำเร็จ' });
    } catch (err) {
        console.error('Error deleting user:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการลบผู้ใช้' });
    }
});

app.delete('/admin/bots/:botId', async (req, res) => {
    try {
        const botId = req.params.botId;
        
        const botState = await db.get('SELECT * FROM bot_states WHERE bot_id = ?', [botId]);
        if (!botState) {
            return res.status(404).json({ error: 'ไม่พบบอท' });
        }
        
        if (bots[botId]) {
            if (bots[botId].process) {
                bots[botId].process.kill();
            }
            const botPath = bots[botId].isFolder
                ? path.join(__dirname, 'bots', bots[botId].folder)
                : bots[botId].mainPath;
            if (fs.existsSync(botPath)) {
                if (bots[botId].isFolder) {
                    fs.rmSync(botPath, { recursive: true, force: true });
                } else {
                    fs.unlinkSync(botPath);
                }
            }
            delete bots[botId];
        }
        
        // ลบบอทจากฐานข้อมูล
        await db.run('DELETE FROM bot_states WHERE bot_id = ?', [botId]);
        await db.run('DELETE FROM user_bots WHERE bot_id = ?', [botId]);
        
        res.json({ message: 'ลบบอทสำเร็จ' });
    } catch (err) {
        console.error('Error deleting bot:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการลบบอท' });
    }
});

// Add TrueMoney payment endpoint
app.post('/payment/truemoney', async (req, res) => {
    const { username, voucherUrl } = req.body;
    
    if (!username || !voucherUrl) {
        return res.status(400).json({ error: 'กรุณาระบุชื่อผู้ใช้และลิงก์ซองอังเปา' });
    }

    const regex = /https:\/\/gift.truemoney.com\/campaign\/\?v=([a-zA-Z0-9]+)/;
    const matchResult = voucherUrl.match(regex);

    if (!matchResult || !matchResult[1]) {
        return res.status(400).json({ error: 'ลิงก์ซองของขวัญไม่ถูกต้อง' });
    }

    const voucherCode = matchResult[1];

    try {
        // ตรวจสอบว่าซองนี้เคยถูกใช้ในระบบแล้วหรือไม่ (ย้ายขึ้นมาตรวจสอบก่อน)
        const usedVoucher = await db.get('SELECT * FROM payments WHERE voucher_code = ?', [voucherCode]);
        if (usedVoucher) {
            return res.status(400).json({ 
                error: 'ซองของขวัญนี้ถูกใช้ในระบบไปแล้ว',
                voucherInfo: {
                    amount: usedVoucher.amount,
                    redeemed: "1/1",
                    total: "1",
                    expireDate: new Date(usedVoucher.timestamp * 1000).toLocaleString('th-TH'),
                    transactionId: usedVoucher.id // เพิ่มเลขอ้างอิงธุรกรรม
                }
            });
        }

        // ตรวจสอบว่าผู้ใช้มีอยู่จริง
        const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
        if (!user) {
            return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
        }

        const paymentPhone = "0825658423";
        const apiUrl = `https://store.cyber-safe.pro/api/topup/truemoney/angpaofree/${voucherCode}/${paymentPhone}`;

        const response = await fetch(apiUrl);
        const data = await response.json();

        if (!response.ok || data.success === false) {
            let errorMessage = "เกิดข้อผิดพลาด: ";
            if (data.status.code === "VOUCHER_EXPIRED") errorMessage += "ซองหมดอายุ";
            else if (data.status.code === "VOUCHER_REDEEMED") errorMessage += "ซองใช้แล้ว";
            else errorMessage += data.status.message || "API ขัดข้อง";

            if (data.data && data.data.voucher) {
                return res.status(400).json({
                    error: errorMessage,
                    voucherInfo: {
                        amount: data.data.voucher.amount_baht,
                        redeemed: data.data.voucher.redeemed,
                        total: data.data.voucher.member,
                        expireDate: new Date(data.data.voucher.expire_date).toLocaleString('th-TH')
                    }
                });
            }
            return res.status(400).json({ error: errorMessage });
        }

        const amount = data.data.voucher.amount_baht;
        
        // ดึงค่าอัตราแลกเปลี่ยนจากการตั้งค่า
        let settings;
        try {
            settings = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
        } catch (error) {
            console.error('Error reading settings.json:', error);
            settings = { exchangeRate: 10 };
        }
        
        // คำนวณเครดิตและอัปเดตในฐานข้อมูล
        const exchangeRate = settings.exchangeRate || 10;
        const credits = amount * exchangeRate;
        
        await db.run('UPDATE users SET credits = credits + ? WHERE username = ?', [credits, username]);
        const updatedUser = await db.get('SELECT credits FROM users WHERE username = ?', [username]);

        // บันทึกประวัติการเติมเงินพร้อมสร้างเลขอ้างอิง
        const result = await db.run(
            'INSERT INTO payments (username, amount, credits, payment_method, voucher_code, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
            [username, amount, credits, 'truemoney', voucherCode, Math.floor(Date.now() / 1000)]
        );

        // ส่งการแจ้งเตือน Telegram
        if (settings.telegramNotifications && 
            settings.telegramNotifications.enabled && 
            settings.telegramNotifications.notifyOnDeposit) {
            sendTelegramNotification(`💰 <b>มีการเติมเงินเข้าระบบ</b>\n\nผู้ใช้: <code>${username}</code>\nจำนวนเงิน: <code>${amount}</code> บาท\nเครดิตที่ได้รับ: <code>${credits}</code> เครดิต\nเลขอ้างอิง: <code>${result.lastID}</code>\nเวลา: <code>${new Date().toLocaleString('th-TH')}</code>`);
        }

        res.json({
            success: true,
            message: 'เติมเงินสำเร็จ',
            transactionId: result.lastID, // เพิ่มเลขอ้างอิงในการตอบกลับ
            amount,
            creditsReceived: credits,
            newCredits: updatedUser.credits
        });

    } catch (error) {
        console.error('Error processing TrueMoney payment:', error);
        res.status(500).json({
            error: 'เกิดข้อผิดพลาดในการประมวลผลการชำระเงิน',
            details: error.code === "ENOTFOUND" ? "เซิร์ฟเวอร์ API ไม่ตอบสนอง" : error.message
        });
    }
});

// Admin Routes
app.get('/admin/codes', async (req, res) => {
    try {
        // ดึงข้อมูลโค้ดทั้งหมดจากฐานข้อมูล
        const codes = await db.all('SELECT * FROM redemption_codes');
        res.json(codes);
    } catch (err) {
        console.error('Error getting redemption codes:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลโค้ด' });
    }
});

app.post('/admin/codes/generate', async (req, res) => {
    try {
        const { credits, maxUses, expireHours } = req.body;
        
        if (!credits || credits <= 0 || !maxUses || maxUses <= 0 || !expireHours || expireHours <= 0) {
            return res.status(400).json({ error: 'กรุณาระบุข้อมูลให้ถูกต้อง' });
        }
        
        // สร้างโค้ดแบบสุ่ม
        const code = generateRandomCode(12);
        
        // คำนวณเวลาหมดอายุ
        const now = new Date();
        const expireTime = Math.floor(now.getTime() / 1000) + (expireHours * 60 * 60);
        
        // บันทึกลงฐานข้อมูล
        await db.run(
            'INSERT INTO redemption_codes (code, credits, max_uses, uses, expire_time) VALUES (?, ?, ?, ?, ?)',
            [code, credits, maxUses, 0, expireTime]
        );
        
        res.json({ success: true, code });
    } catch (err) {
        console.error('Error generating code:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการสร้างโค้ด' });
    }
});

app.delete('/admin/codes/:code', async (req, res) => {
    try {
        const code = req.params.code;
        
        const result = await db.run('DELETE FROM redemption_codes WHERE code = ?', [code]);
        
        if (result.changes === 0) {
            return res.status(404).json({ error: 'ไม่พบโค้ด' });
        }
        
        res.json({ success: true, message: 'ลบโค้ดสำเร็จ' });
    } catch (err) {
        console.error('Error deleting code:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการลบโค้ด' });
    }
});

app.post('/redeem', async (req, res) => {
    try {
        const { username, code } = req.body;
        
        if (!username || !code) {
            return res.status(400).json({ error: 'กรุณาระบุชื่อผู้ใช้และโค้ด' });
        }
        
        const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
        if (!user) {
            return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
        }
        
        const redemptionCode = await db.get('SELECT * FROM redemption_codes WHERE code = ?', [code]);
        if (!redemptionCode) {
            return res.status(404).json({ error: 'โค้ดไม่ถูกต้อง' });
        }
        
        // ตรวจสอบว่าโค้ดหมดอายุหรือยัง
        const now = Math.floor(Date.now() / 1000);
        if (redemptionCode.expire_time < now) {
            return res.status(400).json({ error: 'โค้ดหมดอายุแล้ว' });
        }
        
        // ตรวจสอบว่าโค้ดถูกใช้เกินจำนวนครั้งที่กำหนดหรือไม่
        if (redemptionCode.uses >= redemptionCode.max_uses) {
            return res.status(400).json({ error: 'โค้ดถูกใช้ครบตามจำนวนที่กำหนดแล้ว' });
        }
        
        // เพิ่มเครดิตให้ผู้ใช้
        await db.run('UPDATE users SET credits = credits + ? WHERE username = ?', [redemptionCode.credits, username]);
        
        // อัปเดตจำนวนครั้งที่ใช้โค้ด
        await db.run('UPDATE redemption_codes SET uses = uses + 1 WHERE code = ?', [code]);
        
        // ดึงข้อมูลผู้ใช้ที่อัปเดตแล้ว
        const updatedUser = await db.get('SELECT credits FROM users WHERE username = ?', [username]);
        
        res.json({ 
            success: true, 
            message: 'แลกเครดิตสำเร็จ', 
            creditsReceived: redemptionCode.credits,
            totalCredits: updatedUser.credits
        });
    } catch (err) {
        console.error('Error redeeming code:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการแลกโค้ด' });
    }
});

// ฟังก์ชันสำหรับสร้างโค้ดแบบสุ่ม
function generateRandomCode(length) {
    const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

// ประกาศเพิ่มเติมสำหรับระบบประกาศ
app.get('/announcements', (req, res) => {
    try {
        // อ่านไฟล์ announcements.json
        const announcementsData = fs.readFileSync('./announcements.json', 'utf8');
        const announcements = JSON.parse(announcementsData);
        
        // กรองเฉพาะประกาศที่ยังไม่หมดอายุ
        const now = Date.now();
        const activeAnnouncements = announcements.filter(announcement => 
            announcement.expire_time > now
        );
        
        res.json(activeAnnouncements);
    } catch (err) {
        console.error('Error loading announcements:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการโหลดประกาศ' });
    }
});

app.get('/admin/announcements', (req, res) => {
    try {
        // อ่านไฟล์ announcements.json
        const announcementsData = fs.readFileSync('./announcements.json', 'utf8');
        const announcements = JSON.parse(announcementsData);
        
        res.json(announcements);
    } catch (err) {
        console.error('Error loading announcements:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการโหลดประกาศ' });
    }
});

app.post('/admin/announcements', (req, res) => {
    try {
        const { title, message, type, expireHours } = req.body;
        
        // ตรวจสอบข้อมูลที่จำเป็น
        if (!title || !message || !type || !expireHours) {
            return res.status(400).json({ error: 'กรุณาระบุข้อมูลประกาศให้ครบถ้วน' });
        }
        
        // อ่านไฟล์ announcements.json
        const announcementsData = fs.readFileSync('./announcements.json', 'utf8');
        const announcements = JSON.parse(announcementsData);
        
        // สร้างประกาศใหม่
        const newAnnouncement = {
            id: crypto.randomBytes(8).toString('hex'),
            title,
            message,
            type,
            create_time: Date.now(),
            expire_time: Date.now() + (expireHours * 60 * 60 * 1000)
        };
        
        // เพิ่มประกาศใหม่
        announcements.push(newAnnouncement);
        
        // เขียนกลับไปที่ไฟล์
        fs.writeFileSync('./announcements.json', JSON.stringify(announcements, null, 2), 'utf8');
        
        res.json(newAnnouncement);
    } catch (err) {
        console.error('Error creating announcement:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการสร้างประกาศ' });
    }
});

app.delete('/admin/announcements/:id', (req, res) => {
    try {
        const announcementId = req.params.id;
        
        // อ่านไฟล์ announcements.json
        const announcementsData = fs.readFileSync('./announcements.json', 'utf8');
        let announcements = JSON.parse(announcementsData);
        
        // ตรวจสอบว่ามีประกาศนี้หรือไม่
        const index = announcements.findIndex(a => a.id === announcementId);
        if (index === -1) {
            return res.status(404).json({ error: 'ไม่พบประกาศที่ต้องการลบ' });
        }
        
        // ลบประกาศ
        announcements.splice(index, 1);
        
        // เขียนกลับไปที่ไฟล์
        fs.writeFileSync('./announcements.json', JSON.stringify(announcements, null, 2), 'utf8');
        
        res.json({ success: true, message: 'ลบประกาศสำเร็จ' });
    } catch (err) {
        console.error('Error deleting announcement:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการลบประกาศ' });
    }
});

// ตรวจสอบและสร้างไฟล์ announcements.json ถ้าไม่มี
function ensureAnnouncementsFileExists() {
    const announcementsPath = path.join(__dirname, 'announcements.json');
    if (!fs.existsSync(announcementsPath)) {
        console.log('ไม่พบไฟล์ announcements.json, กำลังสร้างไฟล์...');
        fs.writeFileSync(announcementsPath, JSON.stringify([], null, 2), 'utf8');
        console.log('สร้างไฟล์ announcements.json สำเร็จ');
    }
}

// เพิ่มฟังก์ชันสำหรับส่งการแจ้งเตือนผ่าน Telegram
async function sendTelegramNotification(message) {
    try {
        if (!settings.telegramNotifications || !settings.telegramNotifications.enabled) {
            return;
        }
        
        const token = settings.telegramNotifications.token;
        const chatId = settings.telegramNotifications.chatId;
        
        if (!token || !chatId) {
            console.error('Token หรือ Chat ID ของ Telegram ไม่ถูกกำหนดค่า');
            return;
        }
        
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: 'HTML'
            })
        });
        
        const data = await response.json();
        if (!data.ok) {
            console.error('ไม่สามารถส่งการแจ้งเตือน Telegram:', data.description);
        }
    } catch (error) {
        console.error('เกิดข้อผิดพลาดในการส่งการแจ้งเตือน Telegram:', error);
    }
}

// Add the scheduling endpoint
app.post('/schedule/:botId', async (req, res) => {
    const botId = req.params.botId;
    const { days, username } = req.body;
    
    try {
        // Validate input
        if (!days || isNaN(days) || days < 1 || days > 30) {
            return res.status(400).json({ error: 'กรุณาระบุจำนวนวันที่ถูกต้อง (1-30 วัน)' });
        }

        // Check if user owns the bot
        const botState = await db.get('SELECT * FROM bot_states WHERE bot_id = ?', [botId]);
        if (!botState || botState.owner !== username) {
            return res.status(403).json({ error: 'คุณไม่มีสิทธิ์ในการจัดการบอทนี้' });
        }

        // Get user credits
        const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
        if (!user) {
            return res.status(404).json({ error: 'ไม่พบผู้ใช้งาน' });
        }

        // Calculate required credits (days * price per day)
        const creditsPerDay = systemSettings.runBotCredits || 15; // Default 15 if not set
        const requiredCredits = days * creditsPerDay;

        // Check if user has enough credits
        if (user.credits < requiredCredits) {
            return res.status(400).json({
                error: 'เครดิตไม่เพียงพอ',
                currentCredits: user.credits,
                requiredCredits: requiredCredits
            });
        }

        // Calculate expiration time (current time + days in milliseconds)
        const expireTime = Date.now() + (days * 24 * 60 * 60 * 1000);
        
        // Deduct credits
        await db.run('UPDATE users SET credits = credits - ? WHERE username = ?', 
            [requiredCredits, username]);

        // Save expiration time to bot state
        await db.run('UPDATE bot_states SET expire_time = ? WHERE bot_id = ?', 
            [expireTime, botId]);

        // Update in-memory bot state
        if (bots[botId]) {
            bots[botId].expireTime = expireTime;
            bots[botId].logs.push(`[ข้อมูล] บอทถูกตั้งค่าให้ทำงานเป็นเวลา ${days} วัน (หมดอายุ: ${new Date(expireTime).toLocaleString('th-TH')})`);
        }

        // Start the bot automatically if it's not already running
        if (botState.status !== 'กำลังทำงาน') {
            // Start the bot process
            try {
                await startBotProcess(botId, username, res);
            } catch (startErr) {
                console.error(`Error starting bot ${botId} after scheduling:`, startErr);
                // Continue anyway since we've already charged and set expiration
            }
        }

        // Return success response
        return res.json({ 
            success: true, 
            message: `บอทถูกตั้งค่าให้ทำงานเป็นเวลา ${days} วัน`, 
            expireDate: new Date(expireTime).toLocaleString('th-TH'),
            remainingCredits: user.credits - requiredCredits
        });
        
    } catch (err) {
        console.error('Error scheduling bot:', err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการตั้งเวลาบอท' });
    }
});

async function startBotProcess(botId, username) {
    try {
        const botPath = bots[botId].mainPath;
        // For non-folder bots use its directory instead
        const cwd = bots[botId].isFolder ? botPath : require('path').dirname(botPath);
        let command;

        if (bots[botId].type === 'python') {
            command = bots[botId].isFolder 
                ? ['main.py']
                : [bots[botId].filename];
        } else { // javascript
            command = bots[botId].isFolder 
                ? ['index.js'] 
                : [bots[botId].filename];
        }

        const fullPath = bots[botId].isFolder 
            ? path.join(botPath, bots[botId].type === 'python' ? 'main.py' : 'index.js') 
            : botPath;
        if (!fs.existsSync(fullPath)) {
            await db.run('DELETE FROM bot_states WHERE bot_id = ?', [botId]);
            delete bots[botId];
            return false;
        }

        bots[botId].logs = [`[ข้อมูล] เริ่มรันบอทใหม่: ${botId}`];

        const botProcess = spawn(bots[botId].type === 'python' ? 'python3' : 'node', command, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

        bots[botId].status = 'กำลังทำงาน';
        bots[botId].process = botProcess;
        
        // อัปเดตสถานะในฐานข้อมูล
        await db.run('UPDATE bot_states SET status = ? WHERE bot_id = ?', ['กำลังทำงาน', botId]);

        botProcess.stdout.on('data', (data) => {
            if (bots[botId]) bots[botId].logs.push(`[ผลลัพธ์] ${data.toString().trim()}`);
        });
        botProcess.stderr.on('data', (data) => {
            if (bots[botId]) bots[botId].logs.push(`[ข้อผิดพลาด] ${data.toString().trim()}`);
        });
        botProcess.on('error', async (err) => {
            if (bots[botId]) {
                bots[botId].logs.push(`[ข้อผิดพลาด] ไม่สามารถรันบอทได้: ${err.message}`);
                bots[botId].status = 'หยุด';
                bots[botId].process = null;
                
                // อัปเดตสถานะในฐานข้อมูล
                await db.run('UPDATE bot_states SET status = ? WHERE bot_id = ?', ['หยุด', botId]);
            }
        });
        botProcess.on('close', async (code) => {
            if (bots[botId]) {
                const timestamp = new Date().toLocaleTimeString('th-TH');
                bots[botId].logs.push(`ℹ️ [${timestamp}] หยุดบอท ${botId} สำเร็จ`);
                bots[botId].logs.push(`🛑 [${timestamp}] บอทหยุดทำงาน (รหัส: ${code})`);
                bots[botId].status = 'หยุด';
                bots[botId].process = null;
                
                // อัปเดตสถานะในฐานข้อมูล
                await db.run('UPDATE bot_states SET status = ? WHERE bot_id = ?', ['หยุด', botId]);
            }
        });
        
        return true;
    } catch (err) {
        console.error('Error starting bot process:', err);
        return false;
    }
}

// เริ่มต้นแอปพลิเคชัน
async function startApp() {
    try {
        // ตรวจสอบและสร้างไฟล์ announcements.json ถ้าไม่มี
        ensureAnnouncementsFileExists();
        
        await initializeDatabase();
        await loadSettings(); // เพิ่มการโหลดการตั้งค่า
        await loadExistingBots();
        await loadBotStates();
        
        // Try to start HTTPS server if certificates exist
        const sslPath = '/etc/letsencrypt/live/scriptbotonline.vipv2boxth.xyz';
        if (fs.existsSync(`${sslPath}/privkey.pem`) && fs.existsSync(`${sslPath}/fullchain.pem`)) {
            const httpsServer = https.createServer({
                key: fs.readFileSync(`${sslPath}/privkey.pem`),
                cert: fs.readFileSync(`${sslPath}/fullchain.pem`)
            }, app);
            
            httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
                console.log(`เซิร์ฟเวอร์บอททำงานที่ https://0.0.0.0:${HTTPS_PORT}`);
            });
        }

        // Always start HTTP server for development/fallback
        const httpServer = http.createServer(app);
        httpServer.listen(PORT, '0.0.0.0', async () => {
            console.log(`เซิร์ฟเวอร์บอททำงานที่ http://0.0.0.0:${PORT}`);
            
            // โหลดและรันบอทที่เคยทำงานอยู่
            const states = await db.all('SELECT * FROM bot_states WHERE status = ?', ['กำลังทำงาน']);
            states.forEach(state => {
                setTimeout(() => {
                    console.log(`กำลังรันบอท ${state.bot_id} ที่เคยทำงานอยู่...`);
                    fetch(`http://0.0.0.0:${PORT}/start/${state.bot_id}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: state.owner })
                    });
                }, 2000);
            });
        });
    } catch (err) {
        console.error('Error starting application:', err);
    }
}

startApp();
