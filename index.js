require('dotenv').config(); // Для локального запуска (на Railway не нужно)
const express = require('express');
const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const { Pool } = require('pg');
const path = require('path');

// Подключение к БД PostgreSQL (Railway сам даст DATABASE_URL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Обязательно для Railway
});

// Создаем таблицу, если ее нет
pool.query(`
    CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        title TEXT NOT NULL,
        event_date TIMESTAMP NOT NULL,
        notify_prefs JSONB NOT NULL,
        sent_notifications JSONB DEFAULT '[]'
    )
`).then(() => console.log("Таблица проверена/создана")).catch(console.error);

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());

// --- БОТ ---
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

// --- АПИ ДЛЯ МИНИ АППА ---
app.use(express.static('public')); // Отдаем интерфейс

// Получить дела
app.get('/api/events', async (req, res) => {
    const userId = req.query.userId;
    const { rows } = await pool.query('SELECT * FROM events WHERE user_id = $1 ORDER BY event_date ASC', [userId]);
    res.json(rows);
});

// Создать дело
app.post('/api/events', async (req, res) => {
    const { userId, title, date, notifyPrefs } = req.body;
    await pool.query(
        'INSERT INTO events (user_id, title, event_date, notify_prefs) VALUES ($1, $2, $3, $4)',
        [userId, title, new Date(date), JSON.stringify(notifyPrefs)]
    );
    res.json({ success: true });
});

// Удалить дело (тебе это точно понадобится)
app.delete('/api/events/:id', async (req, res) => {
    await pool.query('DELETE FROM events WHERE id = $1', [req.params.id]);
    res.json({ success: true });
});

// --- СИСТЕМА УВЕДОМЛЕНИЙ ---
cron.schedule('* * * * *', async () => {
    const now = new Date();
    try {
        // Берем будущие события
        const { rows: events } = await pool.query('SELECT * FROM events WHERE event_date > NOW()');

        for (const event of events) {
            const diffMinutes = Math.floor((new Date(event.event_date) - now) / 60000);
            const prefs = event.notify_prefs || [];
            const sent = event.sent_notifications || [];

            for (const pref of prefs) {
                // Если пришло время и мы еще не отправляли
                if (diffMinutes <= pref && diffMinutes > pref - 2 && !sent.includes(pref)) {
                    const timeText = pref >= 60 ? (pref/60) + ' ч.' : pref + ' мин.';
                    await bot.telegram.sendMessage(
                        event.user_id, 
                        `🔔 Напоминание!\nСобытие: **${event.title}**\nНачнется через ${timeText}`
                    );
                    
                    // Записываем, что отправили
                    sent.push(pref);
                    await pool.query('UPDATE events SET sent_notifications = $1 WHERE id = $2', [JSON.stringify(sent), event.id]);
                }
            }
        }
    } catch (e) { console.error('Ошибка крона:', e); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));