require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const { Pool } = require('pg');
const path = require('path');

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
        console.log("База данных проверена и готова");
    } catch (e) {
        console.error("Ошибка БД:", e);
    }
}
initDB();

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());

bot.start((ctx) => {
    ctx.reply('Привет! Твой личный ежедневник готов 📅', {
        reply_markup: {
            inline_keyboard: [[
                { text: 'Открыть ежедневник', web_app: { url: process.env.WEBAPP_URL } }
            ]]
        }
    });
});
bot.launch();

app.use(express.static('public'));

// Получить все дела
app.get('/api/events', async (req, res) => {
    const userId = req.query.userId;
    const { rows } = await pool.query('SELECT * FROM events WHERE user_id = $1 ORDER BY event_date ASC', [userId]);
    res.json(rows);
});

// Создать новые дела (одно или несколько дат)
app.post('/api/events', async (req, res) => {
    const { userId, title, dates, notifyPrefs, comment, isAllDay } = req.body;
    
    for (const d of dates) {
        await pool.query(
            'INSERT INTO events (user_id, title, event_date, notify_prefs, comment, is_all_day) VALUES ($1, $2, $3, $4, $5, $6)',
            [userId, title, new Date(d), JSON.stringify(notifyPrefs), comment || null, isAllDay || false]
        );
    }
    res.json({ success: true });
});

// НОВОЕ: Обновить существующее дело
app.put('/api/events/:id', async (req, res) => {
    const { title, date, notifyPrefs, comment, isAllDay } = req.body;
    await pool.query(
        `UPDATE events 
         SET title = $1, event_date = $2, notify_prefs = $3, comment = $4, is_all_day = $5, sent_notifications = '[]' 
         WHERE id = $6`,
        [title, new Date(date), JSON.stringify(notifyPrefs), comment || null, isAllDay || false, req.params.id]
    );
    res.json({ success: true });
});

// Удалить дело
app.delete('/api/events/:id', async (req, res) => {
    await pool.query('DELETE FROM events WHERE id = $1', [req.params.id]);
    res.json({ success: true });
});

// Крон для уведомлений
cron.schedule('* * * * *', async () => {
    const now = new Date();
    try {
        const { rows: events } = await pool.query('SELECT * FROM events WHERE event_date > NOW()');

        for (const event of events) {
            const diffMinutes = Math.floor((new Date(event.event_date) - now) / 60000);
            const prefs = event.notify_prefs || [];
            const sent = event.sent_notifications || [];

            for (const pref of prefs) {
                if (diffMinutes <= pref && diffMinutes > pref - 2 && !sent.includes(pref)) {
                    const timeText = pref >= 60 ? (pref/60) + ' ч.' : pref + ' мин.';
                    const commentText = event.comment ? `\n📝 Примечание: ${event.comment}` : '';
                    await bot.telegram.sendMessage(
                        event.user_id, 
                        `🔔 Напоминание!\nСобытие: **${event.title}**${commentText}\nНачнется через ${timeText}`
                    );
                    sent.push(pref);
                    await pool.query('UPDATE events SET sent_notifications = $1 WHERE id = $2', [JSON.stringify(sent), event.id]);
                }
            }
        }
    } catch (e) { console.error('Ошибка крона:', e); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
