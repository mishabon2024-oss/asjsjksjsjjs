const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Твой токен от BotFather
const BOT_TOKEN = '8725627105:AAFgdBu8u-AYlHRaGtFLUP12uvqGDJRsuco';

// Базы данных в оперативной памяти (очищаются при перезапуске сервера)
const userChats = new Map();  // Хранит: cleanUsername -> { chatId, firstName, lastName }
const activeCodes = new Map(); // Хранит: cleanUsername -> { code, expires }

// --- ФУНКЦИЯ ОТПРАВКИ ЗАПРОСОВ В TELEGRAM API ---
async function sendTelegramRequest(method, body) {
    try {
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return await response.json();
    } catch (error) {
        console.error(`Ошибка при вызове метода ${method}:`, error);
        return { ok: false };
    }
}

// --- ЛОГИКА ТЕЛЕГРАМ-БОТА (ПОЛУЧЕНИЕ ОБНОВЛЕНИЙ ЧЕРЕЗ LONG POLLING) ---
let lastUpdateId = 0;
async function pollTelegramUpdates() {
    try {
        const result = await sendTelegramRequest('getUpdates', { offset: lastUpdateId + 1, timeout: 30 });
        
        if (result.ok && result.result.length > 0) {
            for (const update of result.result) {
                lastUpdateId = update.update_id;
                
                if (update.message && update.message.text) {
                    const chatId = update.message.chat.id;
                    const fromUser = update.message.from.username;
                    const firstName = update.message.from.first_name || '';
                    const lastName = update.message.from.last_name || '';

                    if (!fromUser) {
                        // Если у пользователя нет юзернейма в настройках Telegram
                        await sendTelegramRequest('sendMessage', {
                            chat_id: chatId,
                            text: '❌ У вас не установлен Username в настройках Telegram. Пожалуйста, установите его (например, @username) для авторизации в NotMess.'
                        });
                        continue;
                    }

                    const cleanUsername = fromUser.toLowerCase().trim();

                    // Сохраняем/обновляем связку юзернейма и полных данных из ТГ
                    userChats.set(cleanUsername, {
                        chatId: chatId,
                        firstName: firstName,
                        lastName: lastName
                    });

                    // Обработка команды /start
                    if (update.message.text === '/start') {
                        await sendTelegramRequest('sendMessage', {
                            chat_id: chatId,
                            text: `👋 Привет, ${firstName}! Твой аккаунт @${fromUser} успешно привязан к системе NotMess.\n\nТеперь вернись на сайт, введи свой никнейм, и я пришлю тебе код подтверждения.`
                        });
                    }
                }
            }
        }
    } catch (err) {
        console.error('Ошибка в цикле опроса обновлений Telegram:', err);
    }
    // Запуск следующего круга опроса через 1 секунду
    setTimeout(pollTelegramUpdates, 1000);
}

// Запускаем фонового бота
pollTelegramUpdates().then(() => console.log('🤖 Фоновый опрос Telegram бота успешно запущен.'));


// --- API ЭНДПОИНТЫ ДЛЯ ВЕБ-САЙТА (ФРОНТЕНДА) ---

// 1. Запрос кода авторизации (Шаг 1)
app.post('/api/send-code', async (req, res) => {
    const { username } = req.body;
    
    if (!username) {
        return res.status(400).json({ success: false, error: 'Введите ваш юзернейм!' });
    }

    const cleanUsername = username.replace('@', '').toLowerCase().trim();
    
    // Ищем профиль пользователя в нашей памяти чатов
    const userData = userChats.get(cleanUsername);

    if (!userData || !userData.chatId) {
        return res.json({ 
            success: false, 
            error: `Сначала перейдите в нашего бота в Telegram, нажмите СТАРТ, а затем повторите попытку.` 
        });
    }

    // Генерируем случайный 5-значный код
    const code = Math.floor(10000 + Math.random() * 90000).toString();
    
    // Сохраняем код в кэш на 5 минут
    activeCodes.set(cleanUsername, {
        code: code,
        expires: Date.now() + 5 * 60 * 1000
    });

    // Отправляем сгенерированный код пользователю прямо в Telegram чат
    const tgResponse = await sendTelegramRequest('sendMessage', {
        chat_id: userData.chatId,
        text: `🔐 Ваш код подтверждения для входа в NotMess:\n\n👉  ${code}  <-\n\nНикому не сообщайте этот код. Время действия: 5 минут.`
    });

    if (tgResponse.ok) {
        return res.json({ success: true, message: 'Код успешно отправлен в Telegram!' });
    } else {
        return res.status(500).json({ success: false, error: 'Не удалось отправить сообщение через Telegram API.' });
    }
});

// 2. Проверка введенного кода (Шаг 2)
app.post('/api/verify-code', (req, res) => {
    const { username, code } = req.body;
    
    if (!username || !code) {
        return res.json({ success: false, error: 'Данные авторизации не заполнены.' });
    }

    const cleanUsername = username.replace('@', '').toLowerCase().trim();
    const savedData = activeCodes.get(cleanUsername);

    if (!savedData) {
        return res.json({ success: false, error: 'Код не запрашивался или его время жизни истекло.' });
    }

    if (Date.now() > savedData.expires) {
        activeCodes.delete(cleanUsername);
        return res.json({ success: false, error: 'Срок действия кода истек. Запросите код заново.' });
    }

    if (savedData.code === code.trim()) {
        activeCodes.delete(cleanUsername); // Стираем код из памяти после успешного входа
        return res.json({ success: true });
    } else {
        return res.json({ success: false, error: 'Неверный код подтверждения!' });
    }
});

// 3. Синхронизация данных профиля Telegram (Шаг 3)
app.get('/api/get-profile/:username', (req, res) => {
    const cleanUsername = req.params.username.replace('@', '').toLowerCase().trim();
    const userData = userChats.get(cleanUsername);

    if (userData) {
        res.json({
            success: true,
            firstName: userData.firstName,
            lastName: userData.lastName,
            username: cleanUsername
        });
    } else {
        res.json({ 
            success: false, 
            error: 'Профиль Telegram не найден в базе данных сервера.' 
        });
    }
});

// Запуск сервера
const PORT = 3000;
app.use(express.static('.')); // Раздает файлы (index.html, app.js и т.д.), если они лежат в этой же папке
app.listen(PORT, () => {
    console.log(`🚀 Сервер NotMess успешно запущен!`);
    console.log(`🔗 Ссылка для проверки: http://localhost:${PORT}`);
});
