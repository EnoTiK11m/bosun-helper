# Bosun Silence Hider

Версия: **1.0.0**

Chrome/Chromium-расширение для дашборда Bosun. Помогает дежурному быстрее разбирать алерты: скрывает лишний шум, подсвечивает состояние алертов, упрощает копирование, обновляет страницу при простое и подает звук при появлении новых событий.

Расширение работает только в браузере и не меняет данные на сервере Bosun.

## Что умеет

- скрывает silenced alerts только в секции **Acknowledged**;
- оставляет silenced alerts видимыми в **Needs Acknowledgement**;
- добавляет метку **Silenced** рядом с muted-алертами;
- подсвечивает алерты и группы в **Needs Acknowledgement** по наличию Note;
- добавляет кнопки **Copy** и **Copy all**;
- делает выделение текста чище, убирая служебные элементы из selection;
- автоматически обновляет главную страницу Bosun при простое;
- проигрывает звук при появлении новых Needs Ack алертов;
- снимает чекбокс `Notify` на странице `/action`.

## Поддерживаемые адреса

- `https://bosun.edna.ru/*`
- `https://bosun-test.edna.ru/*`

Другие адреса нужно добавить в `manifest.json`.

## Установка

1. Откройте `chrome://extensions/`.
2. Включите **Developer mode**.
3. Нажмите **Load unpacked**.
4. Выберите папку проекта с `manifest.json`.
5. Обновите страницу Bosun.

После изменения файлов расширения нажмите **Reload** у расширения в `chrome://extensions/` и обновите страницу Bosun.

## Проверка

Быстрая локальная проверка:

```bash
node smoke-test.js
```

Проверка синтаксиса:

```bash
node --check shared-utils.js
node --check diagnostics.js
node --check sound.js
node --check alerts-data.js
node --check needack-baseline.js
node --check needack-severity.js
node --check page-utils.js
node --check styles.js
node --check activity.js
node --check content.js
node --check smoke-test.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json', 'utf8')); console.log('manifest json ok')"
```

## Структура

```text
manifest.json                     # Manifest V3, permissions, content scripts
content.js                        # основная логика расширения
shared-utils.js                   # общие helpers
diagnostics.js                    # внутренний диагностический лог
sound.js                          # звуковые уведомления
alerts-data.js                    # загрузка и разбор /api/alerts
needack-baseline.js               # baseline для новых Needs Ack алертов
needack-severity.js               # severity и стабильные ключи алертов
page-utils.js                     # helpers для страниц Bosun
styles.js                         # CSS расширения
activity.js                       # активность пользователя и автообновление
smoke-test.js                     # локальная smoke-проверка
bosun_notification_alert_chime.wav
bosun_notification_soft_chime.wav
```

## Важные настройки

В `content.js`:

```js
const DATA_REFRESH_MS = 6000;
const AUTO_REFRESH_DEFAULT_IDLE_SECONDS = 60;
const AUTO_REFRESH_MIN_IDLE_SECONDS = 10;
const AUTO_REFRESH_MAX_IDLE_SECONDS = 3600;
```

В `alerts-data.js`:

```js
const DEFAULT_REQUEST_TIMEOUT_MS = 4500;
const DEFAULT_RETRY_DELAY_MS = 350;
const DEFAULT_RETRY_ATTEMPTS = 2;
```

## Production notes

- `/api/alerts` вызывается только на главной странице Bosun;
- сетевые запросы имеют timeout и короткий retry;
- ошибки внешнего API не ломают интерфейс;
- ошибки `chrome.storage.local` логируются;
- диагностический лог рендерит данные безопасно через `textContent`;
- расширение не использует внешние скрипты и не делает запросы на сторонние домены;
- секреты, токены и пароли в проекте не хранятся.
