# Временная диагностика Single Alert Age

Диагностика выключена по умолчанию. Она не вызывает refresh, не запрашивает
snapshot, не меняет алерты и не включает прежний `SINGLE_ALERT_AGE_DEBUG`.
Рабочие identity checks и grace limits остаются прежними.

Для свёрнутой одиночной группы с `missing-candidate` добавлено отдельное
подтверждение через существующий защищённый Angular reader: конкретная панель
должна содержать в модели единственную пару ID + AlertKey, глобально уникальную
в актуальном snapshot и в той же секции. Конфликты прежнего matching не обходятся.
Reader синхронный; неожиданная Promise не используется для отложенного repaint.
До и после MAIN-перехода проверяются snapshot и DOM. Старые диагностические
сопоставления соседних snapshots не участвуют в этом рабочем пути.

## Запуск в Chrome

1. В `chrome://extensions` перезагрузить Bosun Helper, затем обновить страницу
   Bosun. Это загружает диагностический код; уже запущенная сессия F5 не переживёт.
2. Открыть DevTools → Console. В меню JavaScript context (обычно `top`) выбрать
   content script **Bosun Helper**, то есть isolated world расширения.
   Проверить:

   ```javascript
   typeof BosunHelperSingleAlertAgeDiagnostics
   // "object"
   ```

   Если получено `undefined`, выбран MAIN world/другой frame либо расширение и
   страница ещё не перезагружены. Bridge и вставка script в MAIN не нужны.
3. Пока возраст отображается корректно, выполнить:

   ```javascript
   BosunHelperSingleAlertAgeDiagnostics.start({ durationMs: 90000 })
   ```

   Начальный read-only sample фиксирует состояние уже существующих панелей.
   Чтобы поймать первый prime, нужно успеть запустить запись до его завершения;
   запуск после prime не восстанавливает историю прошедших событий.
4. Оставить вкладку видимой. Дождаться сброса в `1 alerts`, затем ещё 15–30 секунд,
   чтобы наблюдать последующие snapshots. Не нажимать F5 во время записи.
   По умолчанию запись автоматически завершится через 90 секунд; максимум — 120.

## Получение отчёта и выключение

В том же isolated context:

```javascript
BosunHelperSingleAlertAgeDiagnostics.stop()
console.log(JSON.stringify(BosunHelperSingleAlertAgeDiagnostics.report(), null, 2))
```

Можно скопировать только сформированный безопасный JSON через DevTools:

```javascript
copy(JSON.stringify(BosunHelperSingleAlertAgeDiagnostics.report(), null, 2))
```

`copy` — функция Chrome DevTools, расширение clipboard API не вызывает.
Не копировать payload, DOM, старый debug или другие сообщения консоли.
`stop()` отключает диагностический observer/listener/timer, сохраняя отчёт в памяти.
После получения отчёта удалить его из памяти:

```javascript
BosunHelperSingleAlertAgeDiagnostics.clear()
```

Автоматическое завершение и `pagehide` также отключают диагностику. Новый `start`
создаёт новую сессию и новые временные номера панелей.

## Чтение отчёта

- `events` содержит события с локальным `sequence` и номером `generation` age-index.
  Generation увеличивается при каждом `update`, а не только для уникального payload.
- `snapshot-received` означает получение локальным fetch wrapper или вход в
  follower apply callback; `snapshot-applied` — применение к age-index.
  Их источники ограничены `prime/regular/leader/follower/direct/other`.
  Получение без применения и `snapshot-fetch-failed` помогают отделить acquisition
  от repaint. Отклонённые coordinator сообщения до apply callback здесь не видны.
- `panel-decision` сохраняет отдельно исходный `identityReason` и итоговый
  `presentationReason`. В частности, `strong-key-mismatch` не теряется при
  последующем `dom-child-count-mismatch`. `agoValid` и `renderedAgePresent` — booleans.
- При успешном новом подтверждении `identityReason` остаётся исходным
  `missing-candidate`, а `modelIdentityMatched=true` и
  `presentationReason=model-identity-match` показывают результат проверки живой
  модели панели. Возраст берётся из актуального record; diagnostic ID comparison
  не разрешает отображение. Явный конфликт исключает сохранение cached age;
  недоступный reader оставляет прежние ограниченные grace/restoreCount.
- Для раскрытого singleton исходный `identityReason=strong-key-mismatch`
  сохраняется. `presentationReason=expanded-model-identity-match` означает,
  что отдельная age-only MAIN-проверка подтвердила связь видимого child scope
  с `group.Children[0]`, видимый ID и точную пару ID + AlertKey текущего
  глобально уникального snapshot record. Дополнительно доказано различие
  составных ключей только по Subject группы; прежний DOM Subject не должен
  совпадать с другой текущей группой. Это не общее разрешение strong mismatch.
  Недоступность этой проверки оставляет счётчик без expanded grace.
- `restoreCountCalled` обозначает вызов, `restoreCountApplied` — вызов для ранее
  управляемого age node. По `state/result` видно, остался возраст или счётчик.
- `count-mutation` содержит только классы `age/count/other`, тип mutation и origin.
  Собственные `textContent` writes распознаются по объектам added/removed nodes,
  без сохранения текста в отчёте. Остальные обозначены `observed-dom-write`.
- `dom-repaint-start/end` и решения с `repaintAttempted` показывают попытку repaint
  и её результат. `not-repainted` — read-only наблюдение, не рабочее решение.
- Для одной временной `panel` сравнить generation N, N+1, N+2: исходное matching,
  точную identity-причину отказа и последующее восстановление либо повторный отказ.
  При замене panel выделяется новый номер; он не является alert ID и не участвует
  в сопоставлении. `panel-removed` обозначает исчезновение старого DOM-объекта.
- `snapshot-index-comparison` сравнивает старый и новый индексы относительно
  текущей DOM-панели **до** замены индекса. Событие появляется при потере ранее
  найденного record или изменении его count/group key. `previousSubjectMatch`
  и `previousIdentityReason` показывают исходное соответствие.
- `exactSubjectMatch` и `candidateCountInCurrentSection` проверяют текущий DOM
  Subject в своей секции. `candidateInOtherSection` и соответствующий count
  показывают наличие такого Subject в другой секции; это ещё не доказательство
  идентичности. `previousGroupKeyInOtherSection=true` означает, что полный ключ
  прежнего record присутствует в другой секции нового snapshot.
- `whitespaceNormalizedMatch` и `candidateCountAfterNormalization` сравнивают
  пробелы только для диагностики. Значение true при `exactSubjectMatch=false`
  выявляет различие представления; count больше 1 выявляет неоднозначность.
  `rawDomSubjectExactMatch` проверяет исходный textContent после trim, до схлопывания
  пробелов. `normalizedCandidateCountInOtherSection` проверяет другую секцию.
  Ни одна из этих проверок не разрешает показ возраста.
- `domSubjectPresent`, `domGroupKeyPresent`, `snapshotGroupKeyMatch` и
  `strongDomIdentityPresent` показывают доступность исходных оснований matching.
  `childCompositionComparable=true` означает сравнение двух уникальных records
  с одним точным Subject в одной секции. Только в этом случае интерпретировать
  `childCountChanged` и `groupKeyRepresentationChanged`. Изменение ключа само по
  себе не доказывает смену incident: ключ без ID может включать Subject/Ago.
- `cachedMappingPresent`, `cachedPanelIdentityMatches`, `graceTimeLimitExceeded`
  и `graceSnapshotLimitExceeded` фиксируются перед рабочим решением refresh.
  Они помогают различить истечение 15 секунд и превышение двух поколений;
  сами пределы не изменены. Read-only samples отражают состояние на момент чтения.
- `sectionChanged` относится к перемещению того же DOM-объекта. Замена panel
  получает новый номер: диагностика не связывает старую и новую панели по порядку
  и не утверждает `domPanelReplaced` для конкретного алерта без доказательств.
- `summary` — последняя попытка refresh; `totals` — накопленные counts сессии;
  `panels` — последние наблюдения. До первого refresh summary может быть пустой.

Случай A подтверждается рабочим решением с `restoreCountApplied=true` и отказом
identity/presentation. Для случая B искать `observed-dom-write` age → count и
дальнейшие наблюдения count: был ли repaint, совпадала ли identity и приходили ли
новые snapshots. Один пропущенный snapshot не доказывает постоянную потерю matching.

## Ограничения и приватность

В отчёте нет AlertKey, Subject, реальных ID, имён, хостов, URL, Ago timestamps,
текстов, хешей идентичностей или payload. Только коды, booleans, counts и локальные
номера. Диагностика не использует storage, сеть или постоянное логирование.
Наблюдатель только читает DOM; получение отчёта не исправляет отображение.

Лимиты: 512 отслеживаемых панелей и 2000 событий. При переполнении сохраняются
первые 50 событий и последние события, увеличивается `droppedEvents`; превышение
лимита панелей отмечается `panelLimitReached`. Частые синхронные записи Text node
могут объединяться браузером; анализировать их вместе с рабочими решениями и
snapshot generations, не делать вывод о LIVE-причине по одной mutation.

## Следующий LIVE-прогон

### Отказ MAIN expanded reader

`expandedReaderReason` в `model-fallback` и `panel-decision` содержит только
фиксированный код первого обнаруженного отказа нового age-only MAIN-reader.
Старый `read(parent)` и рабочие проверки не изменены. Поле `not-reported`
означает, что MAIN-причина для этого решения не сообщалась; `unknown` — что
код отсутствовал либо не вошёл в закрытый список. Текст exception не передаётся.

Основные группы причин:

- `parent-reader-rejected` / `parent-not-singleton`: прежняя проверка родителя
  отказала либо родитель содержит больше одного ребёнка. Первый код не раскрывает
  внутреннюю ветку старого reader; его поведение не инструментируется.
- `visible-child-count`, `visible-child-structure`, `visible-id-count`,
  `visible-id-format`, `visible-id-mismatch`: структура раскрытия либо видимый ID.
  Reader принимает `#ID` и штатный Bosun `#ID:` с единственным завершающим
  двоеточием. Остальной текст, дополнительные двоеточия, неканонические ID
  и несовпадение с моделью продолжают отклоняться. Проверка формата включена
  в обычный browser suite и доступна отдельно:
  `node tests/browser-test.js --single-alert-age-visible-id-format-regression`.
- `child-scope-unavailable`, `child-binding-missing`, `child-binding-accessor`:
  нужная модель недоступна. Диагностика не вызывает getter binding.
- `child-binding-inherited-parent`: собственный `scope.child` отсутствует,
  но data descriptor в ограниченной цепочке прототипов указывает на точный
  `group.Children[0]`. Это диагностический факт, а не разрешение repaint.
  `child-binding-inherited-other` означает другой inherited descriptor;
  он не подтверждает ребёнка родителя.
- `child-parent-reference-mismatch`, `child-id-mismatch`,
  `child-alertkey-mismatch`, `child-alertkey-conflict`: конфликт модели/identity.
- `state-alias-same-identity`: отдельный объект `scope.state`, его собственные
  ID и AlertKey совпадают. `state-alias-same-id-no-key`: совпадает ID, но
  AlertKey alias недоступен. Оба случая продолжают отклоняться по прежнему
  требованию ссылочного равенства. `state-alias-reference-mismatch` — остальные
  случаи отличающегося alias.
- `*-changed`, `parent-recheck-rejected`, `identity-changed`, `dom-changed`:
  изменение модели или DOM во время синхронной проверки.
- `reader-exception`: ошибка MAIN без сохранения текста или объекта ошибки.

В `totals.expandedReaderReasons` хранится число отказов по каждому коду,
а `totals.modelFallbacks` — число диагностированных вызовов fallback обоих
типов. Это числа вызовов, **не уникальных панелей**. Они не зависят от вытеснения
событий. `totals.refreshes` считает проходы age refresh; каждый проход может
вызвать fallback для нескольких панелей. `model-fallback` записывается при
каждой попытке даже без изменения состояния, поэтому большой журнал сам по себе
не доказывает observer-loop. Диагностический observer только снимает состояние
и не вызывает refresh.

Для короткого прогона перезагрузить расширение и страницу, выбрать isolated
контекст Bosun Helper и выполнить:

```javascript
BosunHelperSingleAlertAgeDiagnostics.start({ durationMs: 20000 })
```

Раскрыть проблемную одиночную группу, свернуть и раскрыть ещё раз. После перехода
в счётчик остановить запись и скопировать безопасный отчёт:

```javascript
BosunHelperSingleAlertAgeDiagnostics.stop()
copy(JSON.stringify(BosunHelperSingleAlertAgeDiagnostics.report(), null, 2))
BosunHelperSingleAlertAgeDiagnostics.clear()
```

При `droppedEvents > 0` не считать события полной историей. Сначала сравнить
агрегированные причины с последними `panels`, затем доступные переходы.
Потеря событий не позволяет восстановить их последовательность задним числом.

Синтетическое ограничение inherited binding воспроизводится отдельным
ожидаемо красным тестом, исключённым из обычного suite:

```bash
node tests/browser-test.js --single-alert-age-inherited-child-regression
```

Это кандидатный FAIL-BEFORE (`1 alerts` вместо возраста) при точной ссылке
inherited child на ребёнка родителя. Он не доказывает, что LIVE использует такую
структуру. Обычный expanded regression проверяет сохранение fail-closed и
точные MAIN-коды, включая реальный чужой child и конфликтующий alias.

### Почему model fallback отказал

В рабочем `panel-decision` раздельно фиксируются:

- `fallbackAttempted`: выполнен вход в model fallback;
- `fallbackReaderCalled`: адаптер действительно вызвал защищённый reader;
- `fallbackReaderReason`: `reader-unavailable`, `reader-called`, `reader-empty`,
  `reader-returned`, `reader-rejected`, `reader-threw`, `unexpected-promise`,
  `stale-before-read`/`stale-after-read` либо `not-called`;
- `fallbackReason`: `matched`, `unavailable`, `invalid-model`, `id-mismatch`,
  `alertkey-mismatch`, `duplicate`, `duplicate-or-unindexed`, `section-mismatch`,
  `model-child-count`, `snapshot-child-count`, `index-unavailable` либо отказ
  до входа: `identity-ineligible`, `dom-not-collapsed`, `snapshot-unavailable`;
- Для expanded пути дополнительно доступны `composite-key-mismatch`
  (различие ключей не ограничено Subject) и `subject-conflict`
  (прежний DOM Subject присутствует в текущем индексе).
- `modelIndexAvailable` и `modelIndexReason`: доступен ли индекс и какое
  ограничение помешало его построить. Коды различают некорректный непустой
  раздел, некорректных/пустых детей, лимит детей, некорректный ID/AlertKey и конфликт
  двух AlertKey-полей. `ready` означает построение индекса, а не matching панели.

`model-index` фиксируется после построения age model index для поколения.
`model-fallback` фиксирует результат попытки и `attemptGeneration` даже при
`stale-state`, когда рабочий refresh немедленно прекращается и не пишет DOM.
Read-only samples не означают новую попытку; смотреть `repaintAttempted` и события.

Успешный исторический child-ID comparison не подтверждает DOM identity и не
используется для repaint. `stableChildComparisonComplete=false` может означать
как неполные данные детей, так и отсутствие пустого раздела; само значение не
выбирает единственную причину отказа.

Исправлен воспроизведённый отказ age model index при пустой противоположной секции.
Отсутствующий или null раздел трактуется как [] только при построении этого индекса;
исходный payload не меняется. Валидные пустые секции теперь допускают `ready` и
`matched`. Некорректный непустой раздел и неполные child records по-прежнему
отклоняются. Глобальная уникальность ID + AlertKey, секция и singleton проверяются
прежним защищённым resolver. Grace и restoreCount не менялись.

В прежней версии это могло давать немедленный restore-count: model-identity-mismatch
не допускает сохранение cached age. При настоящем противоречии это остаётся
необходимым fail-closed поведением. Старые коды snapshot-section-missing/null
не должны появляться для допустимых пустых секций в новой версии.
Полное устранение пяти конкретных LIVE-отказов требует нового прогона.

Существующий bridge возвращает только отклонённую identity без детализации MAIN.
По `reader-rejected` нельзя отличить отсутствие Angular scope, неоднозначную
принадлежность модели и внутренние ограничения reader. Протокол не расширен.

Регрессия пустого противоположного раздела (FAIL-BEFORE → PASS-AFTER):

```powershell
node tests/browser-test.js --single-alert-age-empty-section-regression
```

Проверяет обе секции и формы omitted/null/[], смену Subject, ID + AlertKey,
обновление Ago, раскрытие/сворачивание, неизменность payload и отсутствие restoreCount.
Входит также в обычный browser suite.

### Исследование скачка при раскрытии

Возраст подтверждённой одиночной группы формируется из Children[0].Ago текущего
snapshot и при раскрытии, и при сворачивании. Нативный child age, State/Since и
Angular-модель расширение не изменяет. Некорректный snapshot Ago не заменяется
старым DOM-текстом. В рабочем `panel-decision` ожидается `ageSource=snapshot-child`.
`preserved-snapshot-child` по-прежнему обозначает существующий ограниченный grace,
`count` — штатный счётчик, `not-repainted` — read-only sample. `rendered-child` был
источником заголовка в старой версии и больше не используется для repaint.

`renderedAgeTextEqualsSnapshot` сравнивает только форматированные значения. False
показывает расхождение текста; true не доказывает равенство timestamp из-за
округления. `snapshotChildAgoMatchesLastEvent` интерпретировать только при
`snapshotChildAgoPresent=true` и `snapshotLastEventTimePresent=true`.
Пара `snapshotIncidentStartPresent`/`snapshotChildAgoMatchesIncidentStart` позволяет
отличить начало incident от времени последнего события. Верхнеуровневый group Ago
Single Alert Age не использует; его наличие фиксируется `snapshotGroupAgoPresent`.

В `snapshot-index-comparison` признаки `sameGroupKeyAgoComparable` и
`sameGroupKeyAgoTimestampChanged` показывают изменение Ago между соседними
snapshots с тем же ключом. Для уникального прежнего одиночного child ID доступны
`stableChildAgoComparable`, `stableChildAgoChanged`, `stableChildAgoMovedForward`:
последний означает более новый timestamp и, следовательно, меньший возраст.
Самих timestamp, разниц времени, ID или хешей в отчёте нет.

Запустить запись до раскрытия, раскрыть проблемную группу, затем снова свернуть,
оставаясь в одной сессии. Сравнить ageSource, DOM child count, identity/presentation
reasons и признаки времени. При необходимости повторить после следующего snapshot.
Bridge не расширялся: сырой Ago Angular-модели и State/Since из MAIN диагностика
не читает. По одному несовпадению текста нельзя установить серверную причину.

Регрессия единого источника (FAIL-BEFORE → PASS-AFTER):

```powershell
node tests/browser-test.js --single-alert-age-source-regression
```

При неизменных часах раскрытие не подменяет текущий snapshot age дочерним DOM age.
Проверены обе секции, согласованные и разные ревизии времени, unique-subject,
group-key, предшествующий model fallback, обновление Ago и отказ при неверном Ago.
Входит также в обычный browser suite. Для fallback
в fixture заголовок при раскрытии согласуется с текущим Subject; без согласования
старый Subject плюс сильная child identity обязан продолжать fail-closed.

### Сравнение по stable child ID

`snapshot-index-comparison` теперь сравнивает прежний record с новым snapshot по
положительным безопасным целым `Children[].State.Id` (number либо каноническая
десятичная string). Предыдущий payload передаётся из уже существующего runtime
только на время вызова. Диагностика не сохраняет payload, ID или их хеши;
в отчёте остаются только следующие признаки:

- `previousStableChildIdAvailable`, `previousStableChildIdCount`: доступны ли ID
  хотя бы одного ребёнка прежней однозначно найденной группы.
- `stableChildFoundInNewSnapshot`, `stableChildMatchCount`: найдены ли прежние ID
  в обеих секциях, сколько найдено вхождений. Count больше 1 для одиночной прежней
  группы требует проверки `stableChildIdAmbiguous`; совпадения не разрешают repaint.
- `sameStableChildDifferentSubject`, `sameStableChildDifferentSection`,
  `sameStableChildDifferentGroupKey`: присутствуют вхождения прежних ID с иным
  Subject/секцией/ключом. При ambiguity это признаки кандидатов, не новое matching.
- `stableChildDestinationGroupCount`, `allPreviousStableChildrenFound`,
  `stableChildDestinationHasAdditionalChildren`: сколько новых групп содержит
  прежние ID, сохранились ли все, есть ли дополнительные дети. Они помогают
  выявить split/merge состава, но не доказывают причину серверной перегруппировки.
- `stableChildComparisonComplete`: у всех прежних детей доступны уникальные ID,
  обе новые секции представлены массивами и все новые группы имеют детей с
  корректными ID. Это полнота проверки наличия, не гарантия уникальности новых ID.
- `previousGroupDisappeared=true` разрешён только при полной проверке, отсутствии
  всех прежних ID, Subject и group key в обеих секциях. Он означает отсутствие
  прежнего представления группы **в этом snapshot**, а не доказанное закрытие,
  удаление или исчезновение логического алерта на сервере. False при неполной
  проверке означает неизвестность, а не подтверждение сохранения группы.

Для LIVE-панелей, потерявших соответствие, сравнить первое событие перехода:
stable child найден + differentSubject=true подтверждает смену Subject вокруг
того же child ID; differentSection=true показывает смену секции. Нет child ID
или неполная проверка — не делать вывода об исчезновении. После потери matching
диагностика не сохраняет старые ID для дальнейшего поиска: анализируется именно
переход между соседними snapshot, где прежний record ещё однозначно найден.

### Порядок записи

Запустить `start({ durationMs: 120000 })`, пока matching ещё успешно; дождаться
сброса и как минимум двух последующих применённых snapshot. Скопировать отчёт
перед F5/автоперезагрузкой: pagehide завершает запись, но память документа после
перезагрузки исчезает. Если включён пользовательский auto-refresh страницы,
временно отключить его обычной настройкой и после прогона восстановить.
Сравнить **в пределах этой сессии** первые потерянные панели:

1. `previousSubjectMatch=true`, текущий exact=false, other=true: тот же Subject
   теперь доступен в другой секции. Полный прежний key в другой секции усиливает
   вывод о перемещении; один Subject такого вывода не гарантирует.
2. exact=false, normalized=true: расхождение whitespace; проверить count на
   коллизии. Это диагностическая гипотеза, не разрешение нормализовать matching.
3. exact=false, other=false, normalized=false: прежний DOM Subject отсутствует
   в обоих индексах. Причина переименования/перегруппировки/удаления по этим
   признакам неразличима, если свёрнутый DOM не содержит устойчивых child ID.
4. exact=true при `missing-candidate` для той же секции и решения: противоречие
   ожидаемому индексированию, требующее отдельного расследования.

Без исходников/версии целевого Bosun нельзя установить его частоту native DOM
refresh. Расширение обновляет свой индекс отдельно от Angular schedule; общей
версии DOM/API нет. Источник follower/leader сам по себе не доказывает причину.
Синтетические browser-проверки воспроизводят длительное отсутствие возраста при
несогласованном DOM/API для обоих источников и восстановление после согласования.
Изменение только child ID при неизменном уникальном Subject свёрнутой группы
сохраняет matching; изменение child count сохраняет identity, но возвращает count.
