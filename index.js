require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS events (
                id SERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                title TEXT NOT NULL,
                event_date TIMESTAMP NOT NULL,
                notify_prefs JSONB NOT NULL,
                sent_notifications JSONB DEFAULT '[]',
                comment TEXT,
                is_all_day BOOLEAN DEFAULT FALSE
            );
        `);
        // Обновляем таблицу для новых фич, если колонок еще нет
        await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS color VARCHAR(20) DEFAULT 'blue';`);
        await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS is_completed BOOLEAN DEFAULT FALSE;`);
        
        console.log("База данных проверена и готова");
    } catch (e) { console.error("Ошибка БД:", e); }
}
initDB();

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());
app.use(express.static('public'));

bot.start((ctx) => {
    ctx.reply('Привет! Твой личный ежедневник готов 📅\n\nМожешь нажать на кнопку ниже или просто написать мне текст, например:\n— "Завтра в 15:00 тренировка"\n— "Послезавтра работа"\n— "25.12 в 10:00 созвон"', {
        reply_markup: {
            inline_keyboard: [[ { text: 'Открыть ежедневник', web_app: { url: process.env.WEBAPP_URL } } ]]
        }
    });
});

// Умное добавление дел через текст в боте
bot.on('text', async (ctx) => {
    const text = ctx.message.text.toLowerCase();
    let targetDate = new Date();
    let isAllDay = true;
    let hours = 0, minutes = 0;

    // Ищем время (например "в 15:00")
    const timeMatch = text.match(/в\s+(\d{1,2}):(\d{2})/);
    if (timeMatch) {
        isAllDay = false;
        hours = parseInt(timeMatch[1]);
        minutes = parseInt(timeMatch[2]);
    }

    // Ищем дату
    if (text.includes('завтра')) {
        targetDate.setDate(targetDate.getDate() + 1);
    } else if (text.includes('послезавтра')) {
        targetDate.setDate(targetDate.getDate() + 2);
    } else {
        const dateMatch = text.match(/(\d{1,2})[\.\/ -](\d{1,2})/);
        if (dateMatch) {
            targetDate.setMonth(parseInt(dateMatch[2]) - 1);
            targetDate.setDate(parseInt(dateMatch[1]));
        }
    }
    targetDate.setHours(hours, minutes, 0, 0);

    // Убираем дату и время из текста, чтобы получить название
    let title = ctx.message.text
        .replace(/сегодня|завтра|послезавтра/gi, '')
        .replace(/в\s+\d{1,2}:\d{2}/gi, '')
        .replace(/\d{1,2}[\.\/ -]\d{1,2}/gi, '')
        .trim();
    
    if (!title) title = "Новое дело";
    // Сделаем первую букву заглавной
    title = title.charAt(0).toUpperCase() + title.slice(1);

    // Определяем цвет по ключевым словам
    let color = 'blue';
    if (title.toLowerCase().includes('работ') || title.toLowerCase().includes('смен')) color = 'red';
    if (title.toLowerCase().includes('тренировк')) color = 'green';
    if (title.toLowerCase().includes('отдых')) color = 'purple';

    try {
        await pool.query(
            'INSERT INTO events (user_id, title, event_date, notify_prefs, is_all_day, color) VALUES ($1, $2, $3, $4, $5, $6)', 
            [ctx.from.id, title, targetDate, '[]', isAllDay, color]
        );
        const timeStr = isAllDay ? '(весь день)' : targetDate.toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});
        ctx.reply(`✅ Добавлено в график:\n📌 ${title}\n📅 ${targetDate.toLocaleDateString('ru-RU')} ${timeStr}`);
    } catch (e) {
        ctx.reply('❌ Ошибка при добавлении в базу.');
        console.error(e);
    }
});
bot.launch();

// API Ежедневника
app.get('/api/events', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM events WHERE user_id = $1 ORDER BY event_date ASC', [req.query.userId]);
    res.json(rows);
});

app.post('/api/events', async (req, res) => {
    const { userId, title, dates, notifyPrefs, comment, isAllDay, color } = req.body;
    for (const d of dates) {
        await pool.query(
            'INSERT INTO events (user_id, title, event_date, notify_prefs, comment, is_all_day, color) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [userId, title, new Date(d), JSON.stringify(notifyPrefs), comment || null, isAllDay || false, color || 'blue']
        );
    }
    res.json({ success: true });
});

app.put('/api/events/:id', async (req, res) => {
    const { title, date, notifyPrefs, comment, isAllDay, color } = req.body;
    await pool.query(
        `UPDATE events SET title=$1, event_date=$2, notify_prefs=$3, comment=$4, is_all_day=$5, color=$6, sent_notifications='[]' WHERE id=$7`,
        [title, new Date(date), JSON.stringify(notifyPrefs), comment || null, isAllDay || false, color || 'blue', req.params.id]
    );
    res.json({ success: true });
});

app.delete('/api/events/:id', async (req, res) => {
    await pool.query('DELETE FROM events WHERE id = $1', [req.params.id]);
    res.json({ success: true });
});

app.post('/api/events/bulk-delete', async (req, res) => {
    if (!req.body.ids || req.body.ids.length === 0) return res.json({ success: true });
    await pool.query('DELETE FROM events WHERE id = ANY($1::int[])', [req.body.ids]);
    res.json({ success: true });
});

// НОВОЕ: Переключение статуса "Выполнено"
app.patch('/api/events/:id/toggle', async (req, res) => {
    const { isCompleted } = req.body;
    await pool.query('UPDATE events SET is_completed = $1 WHERE id = $2', [isCompleted, req.params.id]);
    res.json({ success: true });
});

// Крон для уведомлений (игнорирует выполненные дела)
cron.schedule('* * * * *', async () => {
    const now = new Date();
    try {
        const { rows: events } = await pool.query('SELECT * FROM events WHERE event_date > NOW() AND is_completed = FALSE');
        for (const event of events) {
            const diffMinutes = Math.floor((new Date(event.event_date) - now) / 60000);
            const prefs = event.notify_prefs || [];
            const sent = event.sent_notifications || [];
            for (const pref of prefs) {
                if (diffMinutes <= pref && diffMinutes > pref - 2 && !sent.includes(pref)) {
                    const timeText = pref >= 60 ? (pref/60) + ' ч.' : pref + ' мин.';
                    await bot.telegram.sendMessage(event.user_id, `🔔 Напоминание!\nСобытие: **${event.title}**${event.comment ? `\n📝 ${event.comment}` : ''}\nНачнется через ${timeText}`);
                    sent.push(pref);
                    await pool.query('UPDATE events SET sent_notifications = $1 WHERE id = $2', [JSON.stringify(sent), event.id]);
                }
            }
        }
    } catch (e) { console.error('Ошибка крона:', e); }
});

app.listen(process.env.PORT || 3000, () => console.log('Сервер запущен'));
