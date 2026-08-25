# Bosun Helper

Bosun Helper — расширение Manifest V3 для Chrome и других Chromium-браузеров.
Оно упрощает работу с алертами в Bosun и помогает переносить PromQL в
настроенную панель Grafana.

Расширение не выполняет Ack, Note или Close самостоятельно. Оно изменяет
представление страниц и локальные формы, а окончательное действие всегда
остаётся за пользователем.

## Возможности

### Главная страница Bosun

- скрытие silenced-алертов с отображением количества скрытых элементов;
- сворачивание всей секции **Acknowledged**;
- фильтр Needs Acknowledgement без активного пользовательского комментария;
- обозначения алертов с активным Note и без Note;
- возраст вместо `1 alerts` для однозначно сопоставленной одиночной группы в
  **Needs Acknowledgement** и **Acknowledged**;
- сохранение штатного `N alerts` для групп из нескольких алертов и безопасный
  fallback к `1 alerts`, если время или соответствие определить нельзя;
- кнопки **Копировать** и **Копировать все** с очисткой служебного текста;
- копирование текста последней заметки без автора и времени;
- преобразование HTTP(S)-адресов в заметках в кликабельные ссылки;
- адаптивные строки: длинный Subject сокращается, а кнопки, возраст или
  `N alerts` и checkbox остаются справа без переноса;
- исходный checkbox Bosun размером около `16×16px` с кликабельной областью
  `28×28px`, hover/focus-состоянием и мягкой подсветкой выбранной строки;
- настраиваемое обновление страницы после бездействия с диапазоном от 10 до
  3600 секунд; обновление откладывается при редактировании поля или выделенном
  тексте и не выполняется, пока вкладка скрыта;
- звуковые и постоянные визуальные уведомления о новых Needs Ack, которые
  исчезают после появления Note;
- защита от повторного звука при работе в нескольких вкладках.

Возраст одиночной группы берётся из текущего `/api/alerts` snapshot и
синхронизируется с DOM после обновлений Bosun/Angular. Раскрывать группу для
этого не требуется. Уже отрисованный дочерний возраст может использоваться как
более точный источник, но неоднозначные данные никогда не подменяются возрастом
другой группы.

### Частые комментарии

На странице `/action?type=...` расширение показывает шаблоны отдельно для:

- `note`;
- `ack`;
- `close`.

Кнопка ⚙ рядом с заголовком **Частые комментарии** открывает компактный
редактор. В нём можно добавлять, изменять, удалять и переставлять шаблоны, а
также сбрасывать текущий тип к встроенным значениям. Пустые строки и дубликаты
при сохранении удаляются. Если для текущего типа нет корректной сохранённой
настройки, используются встроенные значения по умолчанию.
Редактор ограничивает один тип 50 шаблонами, 500 символами на шаблон и
10 000 символами суммарно, чтобы повреждённые настройки не перегружали страницу.

Нажатие шаблона только вставляет текст в textarea и не отправляет форму.
Настройки разных типов сохраняются независимо в `chrome.storage.local` и
синхронизируются между вкладками расширения.

При открытии поддерживаемой страницы `/action` расширение также снимает флаг
`Notify` в локальной форме. Это не отправляет форму и не выполняет действие в
Bosun автоматически.

### Grafana

- выбор graph query из `$usage_graph` текущего raw Bosun rule definition и
  безопасное добавление instance alert tags из `/api/alerts`;
- direct `promras`, variable chain и query/scalar arithmetic поддерживаются;
  vector/vector arithmetic разрешается только при доказуемо эквивалентном
  label matching, а `dropna` пока fail closed;
  unrelated `promras` вне dependency graph не создают ложную ambiguity;
- multi-query `merge(addtags(...), ...)` распознаётся, но не превращается в
  меняющий семантику `or` и пока не создаёт single-query Grafana action;
- отказ от Grafana-действия при повреждённом rule/PromQL/tags, unsupported graph
  или неоднозначной identity алерта;
- предварительный просмотр полного запроса до открытия Grafana;
- выбор между **Вставить** и **Вставить и выполнить**;
- адресованный запрос с коротким сроком действия вместо передачи PromQL в URL;
- однократное потребление запроса и проверка единственного видимого model-backed
  редактора перед удалением pending-запроса или выполнением Run.

## Синхронизация вкладок и обновление данных

На главной странице вкладки выбирают одного лидера для опроса
`/api/alerts?filter=`. Видимый лидер обычно обновляет snapshot раз в 4 секунды,
скрытый — раз в 10 секунд. При появлении видимой вкладки лидерство может быть
передано ей.

Остальные вкладки получают snapshot через `BroadcastChannel`. Скрытая
follower-вкладка хранит только последний snapshot и применяет его к данным и DOM
после возвращения пользователя. Если координация недоступна, вкладка переходит в
безопасный локальный режим и периодически пытается восстановить совместную
работу.

## Настройки и feature toggles

Настройки проходят через единый versioned store. Схема версии 1 хранит каждое
значение отдельным ключом `bosunSettingsV1:<path>` и использует
`bosunSettingsSchemaVersion` как общий номер версии. Такой формат не требует
перезаписывать весь объект настроек и позволяет вкладкам сходиться через
`chrome.storage.onChanged`: изменения разных параметров не затирают друг друга,
а конфликт одного параметра разрешается последней записью Chrome storage.

При первом запуске store переносит существующие настройки фильтров, звука,
автообновления, диагностики и action templates. Корректное canonical-значение
имеет приоритет; повреждённый или частичный storage даёт безопасный default
только для затронутого параметра. Reset удаляет только ключи настроек и не
затрагивает tracker новых алертов, coordinator, session baseline, Grafana
handoff или диагностический журнал.

Без reload можно включать и выключать возраст одиночного алерта, улучшения
checkbox, copy buttons, фильтры, сворачивание Acknowledged, звуковые и визуальные
уведомления, auto refresh, action templates и Bosun-side Grafana integration.
При выключении принадлежащие функции controls, listeners, timers и async work
очищаются независимо. Изменение Last Action links/copy в этой итерации требует
reload: исходная DOM-трансформация необратима без риска изменить штатный текст
Bosun.

## Требования

- Google Chrome, Chromium или Microsoft Edge с поддержкой Manifest V3;
- доступ к настроенным HTTPS-адресам Bosun и Grafana;
- Node.js 20 или новее — только для настройки и разработки;
- Node.js 22 или новее рекомендуется для browser-тестов и используется в CI.

Runtime-зависимостей нет: расширение работает без сборщика и без
`node_modules`.

## Установка из исходников

1. Скачайте или клонируйте репозиторий.
2. При необходимости настройте адреса по инструкции ниже.
3. Откройте `chrome://extensions/`.
4. Включите **Режим разработчика**.
5. Нажмите **Загрузить распакованное расширение**.
6. Выберите директорию, в которой находится `manifest.json`.
7. Обновите открытые вкладки Bosun и Grafana.

После изменения исходников нажмите **Обновить** на карточке расширения и
перезагрузите целевые страницы.

## Настройка адресов

Сгенерированная конфигурация хранится в `config.js`, а разрешённые origin — в
`manifest.json`. Эти файлы должны оставаться синхронизированными.

Создайте локальную конфигурацию:

```powershell
Copy-Item config.example.js config.local.js
```

Для Bash:

```bash
cp config.example.js config.local.js
```

Заполните `config.local.js`:

```js
globalThis.BosunHelperLocalConfig = {
  bosunHosts: ['bosun.example.com', 'bosun-test.example.com'],
  grafanaHost: 'grafana.example.com',
  grafanaPanelUrl: 'https://grafana.example.com/d/example/dashboard?editPanel=1'
};
```

Допускаются hosts с портом, например `grafana.example.com:8443`. URL Grafana
должен использовать HTTPS, соответствовать `grafanaHost` и вести на нужную
панель редактирования.

Синхронизируйте конфигурацию:

```bash
npm run sync-config
```

Скрипт проверяет hosts и URL, затем обновляет `config.js` и разрешённые адреса
в `manifest.json`. После выполнения просмотрите оба файла перед коммитом.

`config.local.js` находится в `.gitignore` и не должен попадать в репозиторий.
Не публикуйте внутренние hosts, URL панелей и данные алертов в issues, тестах или
отчётах.

## Использование

### Bosun

Откройте главную страницу `/`. Панель Bosun Helper появится над дашбордом и
позволит:

- показать или скрыть silenced-алерты;
- включить фильтр **Без комментария**;
- скрыть или показать **Acknowledged**;
- включить или выключить звук;
- настроить обновление страницы после бездействия.

Клик по основной части строки по-прежнему раскрывает группу. Клик по штатному
checkbox или его увеличенной области меняет выбор, не раскрывая строку.
Стандартные Bosun controls `select all`, `normal`, `warning`, `critical`,
`unknown` и `none` продолжают управлять теми же исходными input-элементами.

На `/action` выберите шаблон, чтобы вставить его в поле комментария. Откройте
⚙ для настройки шаблонов текущего `note`, `ack` или `close`. Расширение не
нажимает кнопку отправки и не меняет серверное состояние без действия
пользователя.

### Grafana

Нажмите **Grafana** возле алерта и проверьте запрос в preview:

- **Отмена** — ничего не открывать;
- **Вставить** — заполнить редактор без запуска;
- **Вставить и выполнить** — заполнить редактор и нажать Run queries.

Всегда проверяйте запрос, alert tags и диапазон времени перед выполнением.
Для открытия новой вкладки браузер должен разрешать всплывающие окна с Bosun.

Bosun expression `promras(promql, stepDuration, startDuration, endDuration)`
поддерживается в штатной четырёхаргументной форме. Неполный вызов, неверное
число duration-аргументов или невалидный PromQL не создают Grafana action.
Несколько queries внутри alert сами по себе не являются ambiguity: resolver
следует только `$usage_graph`. Если rule source временно недоступен, старый
`State.Expr` используется только когда содержит ровно один уникальный валидный
`promras`.

## Данные, конфиденциальность и безопасность

### Разрешения и сеть

- из browser API permissions используется только `storage`;
- доступ content scripts ограничен настроенными HTTPS-origin Bosun и Grafana из
  `manifest.json`;
- web-accessible resources ограничены звуками для Bosun и page bridge для
  настроенного Grafana origin;
- `/api/alerts?filter=` запрашивается только как credentialed same-origin ресурс
  текущего Bosun;
- `/api/config/running_hash` и Rule Editor endpoint `/api/config?hash=` также
  читаются только same-origin и `no-store`; running hash используется
  как version token до/после config fetch, raw RuleConf не сохраняется и не
  логируется;
- переход Grafana разрешён только на настроенный HTTPS host и путь панели;
- расширение самостоятельно не отправляет телеметрию и не выполняет запросы к
  сторонним endpoint; переход по ссылке из заметки происходит только по
  действию пользователя.

### Что хранится локально

| Данные | Хранилище | Срок и назначение |
| --- | --- | --- |
| Versioned settings schema: feature toggles, UI, звук, фильтры и автообновление | `chrome.storage.local` | До изменения, reset или удаления расширения |
| Пользовательские шаблоны `note` / `ack` / `close` в settings schema | `chrome.storage.local` | До изменения, reset или удаления расширения |
| ID, severity и время обнаружения новых Needs Ack | `chrome.storage.local` | Пока алерт актуален и ожидает Note |
| Lease и token координатора вкладок | `chrome.storage.local` | Служебные метаданные для выбора лидера |
| Pending PromQL и режим запуска | `chrome.storage.local` | Логический TTL 2 минуты; удаляется после подтверждённой вставки или при ближайшей очистке |
| Baseline Needs Ack и ограниченный cache маркеров | `sessionStorage` | В пределах сессии вкладки; cache маркеров действителен до 10 минут |
| Короткая запись дедупликации звука | `localStorage` страницы Bosun | Предотвращает одновременный повторный звук во вкладках |
| Диагностический журнал | `localStorage` страницы Bosun | Заполняется только при включённой внутренней диагностике; размер ограничен |

Полные snapshots `/api/alerts` не записываются в `chrome.storage`,
`localStorage` или `sessionStorage`. Они находятся в памяти и временно
передаются между вкладками через `BroadcastChannel`. В `sessionStorage`
сохраняются только ограниченные производные ID, ключи, флаги и счётчики,
необходимые для baseline и восстановления маркеров.

Полный raw RuleConf также никогда не попадает в browser storage: memory cache
содержит только разобранные per-alert graph results текущего running hash.

Pending PromQL может содержать операционные идентификаторы. Просроченная запись
логически отвергается даже если физическое удаление из browser storage не
удалось; stale-записи повторно очищаются при следующих передачах.
После подтверждённой вставки request ID на время исходного TTL помечается как
потреблённый в ограниченном `sessionStorage` cache. Поэтому ошибка физического
удаления pending-записи и reload вкладки не приводят к повторному Run.

### Границы Grafana bridge

Запрос передаётся из isolated content script в page context Grafana через
same-origin `postMessage`. Проверяются source, origin, channel token, request ID,
operation ID и таймаут. Результат page bridge считается только подсказкой:
расширение отдельно проверяет единственный подключённый и видимый editor root.
Неоднозначные/скрытые editors, истёкший deadline и DOM-only fallback отклоняются;
Run разрешён только для повторно подтверждённого model-backed editor.

Скрипты, уже выполняющиеся на самой странице Grafana, технически могут видеть
same-window сообщения. Bridge не создаёт дополнительной cross-origin передачи
и не отправляет запрос третьим сторонам.

Внешние значения добавляются в интерфейс через безопасные текстовые DOM API.
Расширение не отправляет Ack, Note или Close автоматически.

## Разработка

### Команды

| Команда | Назначение |
| --- | --- |
| `npm test` | Smoke, integration и regression-тесты в Node.js |
| `npm run test:browser` | Headless DOM, interaction и layout-тесты в реальном Chromium engine |
| `npm run check` | Проверка manifest/config, синтаксиса всех JS и повторный запуск Node-набора |
| `npm run sync-config` | Валидация локальной конфигурации и синхронизация hosts |

Node-тесты используют `vm` и лёгкие DOM/Chrome stubs, а не jsdom. Browser-suite
требует Node.js с глобальным `WebSocket` (рекомендуется Node.js 22+) и запускает
headless Chrome/Chromium/Edge через CDP на локальной тестовой странице. Он
проверяет настоящий DOM/CSS engine, но не заменяет ручную проверку установленного
расширения на живых Bosun и Grafana.

Путь к браузеру можно указать явно:

```powershell
$env:BOSUN_HELPER_BROWSER = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run test:browser
```

В Linux:

```bash
BOSUN_HELPER_BROWSER=/usr/bin/google-chrome npm run test:browser
```

CI использует Ubuntu и Node.js 22 и запускает `npm test`,
`npm run test:browser` и `npm run check` для каждого push и pull request.

### Уровни тестирования

| Файл | Что проверяет |
| --- | --- |
| `smoke-test.js` | Загрузка модулей, публичные API и небольшие unit-сценарии |
| `rule-graph-test.js` | `$usage_graph` parser, hash-bound cache и stale fetch regressions |
| `integration-test.js` | Инициализация content scripts, remount UI и границы Bosun/Grafana |
| `regression-test.js` | Координатор вкладок, storage-races, tracker и редакторы Grafana |
| `browser-test.js` | Реальные DOM, CSS, responsive-layout, keyboard/pointer interactions |

### Структура проекта

| Файл | Ответственность |
| --- | --- |
| `manifest.json` | MV3 permissions, порядок content scripts и доступные ресурсы |
| `package.json` | Требование Node.js и команды разработки |
| `config.example.js` | Безопасный пример локальной конфигурации |
| `config.js` | Сгенерированная runtime-конфигурация |
| `shared-utils.js` | Общая нормализация данных и DOM-значений |
| `diagnostics.js` | Ограниченный внутренний журнал диагностики |
| `sound.js` | Звук и межвкладочная защита от повторов |
| `alerts-data.js` | Загрузка `/api/alerts`, retry и индекс алертов |
| `single-alert-age.js` | Сопоставление snapshot с DOM и возраст одиночных групп |
| `needack-baseline.js` | Baseline для обнаружения новых Needs Ack |
| `needack-severity.js` | Stable keys и определение warning/critical/unknown |
| `promql.js` | Fail-closed извлечение PromQL, валидация и безопасное добавление alert tags |
| `bosun-rule-graph.js` | Hash-bound memory-only RuleConf resolver для `$usage_graph` |
| `page-utils.js` | Проверки маршрутов и небольшие DOM-интеграции Bosun |
| `styles.js` | Инъекция scoped CSS и responsive/accessibility states |
| `activity.js` | Активность пользователя и обновление после бездействия |
| `action-templates.js` | Редактор шаблонов `/action` и локальное хранение |
| `grafana-handoff.js` | Preview, pending request, режим запуска и TTL |
| `new-alert-tracker.js` | Новые алерты, ожидающие Note |
| `refresh-coordinator.js` | Leader election и обмен snapshots между вкладками |
| `content.js` | Основной UI и lifecycle страницы Bosun |
| `grafana-content.js` | TTL/consume-once проверка pending-запроса и isolated-world bridge |
| `grafana-page.js` | Однозначная model-backed работа с редактором Grafana в page context |
| `scripts/sync-config.js` | Генерация `config.js` и обновление разрешённых hosts |
| `scripts/check.js` | Проверки manifest/config, синтаксиса и Node-набора |
| `.github/workflows/checks.yml` | CI для push и pull request |

## Проверка изменений перед коммитом

```bash
npm test
npm run test:browser
npm run check
git diff --check
```

Не добавляйте в коммит `config.local.js`, локальные browser-профили, временные
файлы и персональные настройки среды разработки.

## Устранение неполадок

### Панель не появилась в Bosun

- проверьте, что host присутствует в `config.js` и `manifest.json`;
- перезагрузите расширение на `chrome://extensions/`;
- обновите вкладку Bosun после перезагрузки расширения.

### Одиночная группа показывает `1 alerts`

Это штатный fallback, если в snapshot нет корректного `Ago`, группа не найдена
или соответствие неоднозначно. Убедитесь, что `/api/alerts?filter=` успешно
загружается и содержит ровно один дочерний алерт для этой группы.

Временная точечная диагностика перехода `age → 1 alerts` по умолчанию отключена.
Для временного включения установите `SINGLE_ALERT_AGE_DEBUG = true` в
`single-alert-age.js`. Она выводит не более 20 записей с prefix
`[BosunHelper][single-alert-age-problem]`; в лог попадают hashes Subject/group
key и короткие метаданные, но не полный snapshot и не DOM nodes.

### Шаблоны комментариев не сохраняются

- убедитесь, что URL содержит поддерживаемый `type=note`, `type=ack` или
  `type=close`;
- проверьте доступность `chrome.storage.local` и сообщение статуса редактора;
- повреждённые значения storage игнорируются, после чего используются defaults.

### Grafana не открывается или запрос не вставляется

- разрешите всплывающие окна для Bosun;
- проверьте `grafanaHost`, `grafanaPanelUrl` и параметр `editPanel`;
- убедитесь, что открыта именно настроенная HTTPS-панель;
- pending-запрос старше двух минут намеренно не применяется.
- несколько разных `promras()`, повреждённые tags/PromQL, несколько видимых
  editors или невозможность подтвердить backing model намеренно дают safe fallback
  без вставки и Run.

### Browser-тест не находит Chrome

Установите Chrome/Chromium/Edge или задайте путь через
`BOSUN_HELPER_BROWSER`.

## Участие в разработке

Перед pull request:

1. Создайте отдельную ветку.
2. Не включайте персональные hosts, локальные конфигурации и операционные данные.
3. Сохраняйте порядок content scripts в `manifest.json`.
4. Добавьте тесты для изменённого поведения.
5. Выполните все команды из раздела проверки перед коммитом.
6. Опишите пользовательское изменение, риски и способ проверки.

## Лицензия

Проект распространяется по лицензии MIT. Полный текст находится в файле
[`LICENSE`](LICENSE).
