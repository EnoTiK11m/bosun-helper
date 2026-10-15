# Grafana: сохранение вычислений PromQL

Ранее Tags добавлялись в каждый селектор. Это ограничивало глобальные `count`,
знаменатели отношений и операнды `and/or/unless`, меняя результат. Существующий
regex/negative matcher блокировал уточнение по имени метки, а output-derived
labels отклонялись даже там, где безопасная фильтрация была возможна.

Теперь исходный запрос остаётся целиком неизменным:

```promql
(
  original_expression
) and on (name, zone) (
  label_replace(
    label_replace(vector(1), "name", "channel-alpha", "", ".*"),
    "zone", "zone-one", "", ".*"
  )
)
```

`and` сохраняет значения и labels левого результата, проверяя только совпадение
выбранных меток. Правый вектор постоянный, поэтому запрос к метрикам вычисляется
один раз. Новые строки защищают обёртку от trailing comments. Literal `$` сначала
экранируется для Go replacement, затем значение — для PromQL string.
Семантика: [Prometheus operators](https://prometheus.io/docs/prometheus/latest/querying/operators/#logical-set-binary-operators).

Ограниченный lexer/precedence parser проверяет типы, function signatures,
prefix/postfix `by/without`, binary matching, ranges/subqueries, `offset` и `@`.
Он отслеживает возможные выходные метки и явно удалённые метки. `by` не может
восстановить метку, удалённую вложенной агрегацией. `topk/bottomk` сохраняют метки
выбранных исходных серий; `count_values`, `label_replace/join` учитываются на выходе.
При `or` фильтр может выбрать только одну из ветвей, не меняя расчёт обеих.

Без схемы метрики bare selector имеет открытый набор labels. Подтверждённые Tags
конкретного Bosun instance служат свидетельством выбора серии; это не проверка
существования метки в live Prometheus. Отсутствующая серия или метка даёт пустой
результат, а не подстановку в исходный селектор. Для известного удаления метки
выдаётся `output_label_unavailable`. Scalar/matrix с Tags, неизвестные функции,
неподдерживаемый синтаксис и превышение budgets дают явный отказ.

Размеры source/result ограничены 16 KiB, количество токенов и глубина разбора
ограничены; cache анализа содержит максимум 128 выражений. Полный RuleConf не
сохраняется. Диагностика content script получает только reason codes и количества.
Identity/collision checks, hash-bound resolver, preview, TTL, consume-once и
повторная проверка editor перед явным Run сохраняются.

## Локальная проверка конфигурации

`node scripts/audit-grafana-rules.js bosun-rules.conf` выводит только агрегаты.
Файл конфигурации игнорируется Git; упаковка использует allowlist runtime ресурсов.
Аудит не является проверкой всех живых экземпляров алертов: `/api/alerts` и
production time series не использовались.

Проверено 499 блоков реальной локальной конфигурации. Числа окончательного аудита
и ограничения приведены ниже; названия и содержимое правил не включены.

| Результат анализа графа | Количество |
| --- | ---: |
| Однозначный поддерживаемый граф | 482 |
| Несколько отдельных запросов | 0 |
| Неподдерживаемая форма legacy `prom` | 0 |
| Неподдерживаемые вычисления Bosun, включая wrappers | 7 |
| Нет доказуемого graph source | 8 |
| Unresolved variable | 0 |
| Invalid `promras` | 1 |
| Invalid rule source | 1 |

Из 482 графов: 435 direct `promras`, 32 проверяемых вычисления, 12 direct `prom`
и 3 direct `promrate`. Все 482 имеют валидный instant-vector PromQL в поддерживаемой грамматике.
У 469 анализ находит возможные выходные labels, у 13 результат без labels:
последние доступны только без instance Tags. Это статическое покрытие графов,
а не гарантия кнопки для каждого живого алерта. Tags вне выхода и неоднозначная
identity по-прежнему запрещают действие. Перед расширением поддержки разрешались
460 графов. После этапа merge — 469, после локальной интерполяции — 470.
Для всех исходных 460 сохранены успешное разрешение и точный SHA-256 текста query;
после второго этапа также проверена сохранность результатов первого этапа.
Последний этап legacy дал 470 → 482: девять ранее отклонённых `prom` и три
`promrate`. Перед ним baseline зафиксирован для всех 499 правил; для прежних 470
совпали успешность, SHA-256 исходного query и SHA-256 результата внешней фильтрации
с синтетическими Tags. SHA-256 production-конфига до/после также совпал.

## Расширение merge и локальных переменных

Поддерживается корневой `merge` из 2–16 непосредственных `addtags`-ветвей.
Каждая ветвь проходит существующий структурный анализ PromQL: instant vector,
конечный известный набор возможных labels, одинаковая schema у всех ветвей.
Discriminator должен быть новым label для каждой ветви, иметь одно имя и
попарно разные значения. Значения допускают ASCII-буквы, цифры, `_`, `-`, `.`;
имена служебных labels и конфликты запрещены. Неизвестная schema, несовпадающие
метки, одинаковые значения, nested wrappers и превышение budgets дают отказ.
Прежние ограничительные signatures для Bosun arithmetic не расширялись.

Это доказательство позволяет использовать `or`: добавленный discriminator
делает label sets разных ветвей непересекающимися. Полное выражение каждой ветви
сохраняется, включая арифметику, quantiles, range-функции и vector matching.
Закрывающая обёртка защищена от trailing comments. Tags фильтруют общий конечный
результат. Девять прежних `multi_query_graph` теперь разрешаются.

Внутри строковых matcher-значений `promras` разрешена ограниченная интерполяция
предшествующих локальных raw string assignments и точных aliases `$variable`.
Позиции определяются lexer, а не заменой по всему query. Значения ограничены
4096 символами и алфавитом `[A-Za-z0-9_.|:-]`; исходные точки и pipes сохраняют
regex semantics. Проверяются порядок, циклы, глубина/число зависимостей и итоговый
размер PromQL. Кавычки, backslashes, multiline, выражения, глобальные переменные,
замена имени метрики/функции/label и подстановка в строки функций запрещены.
Экранирование выполняется как для PromQL string, затем весь запрос валидируется.
Alert Tags не участвуют в разрешении переменных. Добавлен один граф с локальными
regex-списками; названия и значения production-переменных в fixtures не копируются.

Случай без `$usage_graph`/`$q`, но с одним `promras` в `$value`, проверен браузерным
fixture: существующий `State.Expr` fallback переносит однозначный развёрнутый
запрос. Новый автоматический выбор переменной не добавлялся. Реальный `State.Expr`
не получался; если он не содержит полного единственного вызова, действие остаётся
недоступным. Статический `no_usage_graph` для таких правил сохраняется.

## Legacy prom и promrate

Пользователь подтвердил выполнение exact-name selectors и `rate` на рабочем
Grafana datasource. Проверена также upstream-реализация
[Bosun promQueryTemplate](https://github.com/bosun-monitor/bosun/blob/master/cmd/bosun/expr/prom.go).
Это подтверждает выбранную конструкцию, но не полную числовую эквивалентность
при разных шагах/диапазонах и не доступность всех legacy-метрик.

Разрешены только полные прямые строковые вызовы выбранного `$usage_graph` либо
существующего fallback `$q`:

```text
prom(metric, grouping, filter, aggregation, step, start, end)
promrate(metric, grouping, filter, aggregation, rateWindow, step, start, end)
```

Для dotted metric создаётся ровно один точный `__name__` matcher. Имя не
нормализуется. Прежние bare selectors сохраняют старый текст, поэтому ранее
поддержанные legacy-запросы не изменились. Analyzer разрешает metricless selector
только с одним непустым `__name__="literal"`; broad/regex-name selectors и любые
дополнительные `__name__` matchers у named selector запрещены. Интерполяция имени
через `__name__` также запрещена.

Сохраняются `=`, `!=`, `=~`, `!~`, порядок grouping labels и значения matchers.
Разрешены `sum`, `avg`, `min`, `max`, `count`, `group`, `stddev`, `stdvar`.
Пустая grouping создаёт `by ()`: Tags, отсутствующие на выходе, отклоняются.
Дубликаты grouping/filter labels, `__name__` в исходном filter/grouping,
неизвестные или параметризованные агрегаторы, malformed args и escaping вне
поддерживаемого подмножества дают отказ. Legacy regex grammar допускает литералы
ASCII, `.`, `.*`, `.+`, непустые альтернативы и внешние `^`/`$`; сложные RE2
конструкции отклоняются, а не интерпретируются JavaScript RegExp.

Окно `rateWindow` вставляется как исходный положительный integer PromQL duration,
включая секунды, ms и compound units, после проверки существующим analyzer.
`rate` выполняется до агрегации. Empty/zero, decimal и Bosun month `n` rate windows,
повторённые/переставленные units и overflow запрещены. Окно не заменяется шагом.

`step/start/end` проверяются отдельно по ограниченной Bosun duration grammar:
`ms/s/m/h/d/w/n/y`, compound durations, положительный шаг, start > end, пустой end
означает zero. Поддержаны точные десятичные значения до 9 знаков без округления
sub-nanosecond; проверяется int64 overflow и overflow float64 accumulation перед
upstream int64 conversion. Негативные/future durations и неподдерживаемые формы
отклоняются. Исходные time arguments не переносятся в Grafana time picker.

Синтетические примеры:

```promql
sum({__name__="demo.worker.state"}) by (job)
sum(rate({__name__="demo.audit.total", type=~".+Errors"}[1m])) by (hostname, type)
```

Tags применяются только существующим внешним `and on(...)`. Результаты успеха —
`direct_prom` / `direct_promrate`; отказы — `legacy_prom[_arity|_arguments|_metric|_grouping|_aggregation|_matchers|_duration|_query]`
и аналогичные `legacy_promrate...`. Codes не содержат имён, фильтров и данных алерта.
Wrappers, arithmetic, variable aliases/nonliteral args и backend prefixes остаются
fail-closed; новые источники графиков не угадываются.

## Осознанно оставленные ограничения

Bosun `dropna` удаляет NaN и обе бесконечности и возвращает ошибку, если вся серия
опустела. PromQL `(E < +Inf) > -Inf` корректно фильтрует значения, но в последнем
случае возвращает пустой vector, не ту же ошибку. Engine fixture подтверждает это
различие результата; source-of-truth для ошибки —
[Bosun DropValues/DropNA](https://github.com/bosun-monitor/bosun/blob/master/cmd/bosun/expr/funcs.go).
Без изменения контракта или отдельного execution adapter эквивалентность не
доказана. Три целевых `dropna` и прочие unsupported wrappers остаются закрыты.

Все 12 целевых legacy-правил теперь разрешаются статически. Из 17 остальных
отказов: 8 `no_usage_graph`, 7 `computed_graph` (dropna, неподтверждённый matching,
ошибочные выражения), 1 `invalid_promras`, 1 `invalid_rule_source`. Поддержка этих
категорий не расширялась. Ошибки исходного Bosun/PromQL не исправляются в расширении.
Наличие всех метрик, совпадение datasource и равенство временных параметров между
Bosun/Grafana требуют дополнительной проверки на production.

Инвентаризация полного файла обнаружила 1 052 вызова `promras`. Для всех 499
алертов проверены выбранные зависимости `$usage_graph`/`$q`, `merge/addtags`,
legacy `prom`, арифметика и wrappers. В конфигурации встречаются `sum/min/max/avg`,
`count`, `rate/increase`, histogram quantiles и over-time функции.
Неподдерживаемые `dropna`, неоднозначные merge, неподтверждённое
Bosun vector matching, циклы и unresolved/forward dependencies не преобразуются.
Metric-less selectors без точного `__name__` отклоняются. Общая поддержка всех функций PromQL
или всех расширений конкретного backend не заявляется.
RE2-шаблоны внутри строк сохраняются без изменений; локальный parser не заменяет
проверку regex в Prometheus. Некорректный шаблон может дать явную ошибку backend.

Постоянные тесты используют обезличенные структуры реальных правил. Node matrix
проверяет global guard, ratio, topk и `or` на контролируемых рядах. Дополнительный
`npm run test:promql-engine -- <promtool>` выполняет 51 выражение настоящим
Prometheus engine, включая контроль со старой ошибочной подстановкой и проверку,
что `on` не восстанавливает отсутствующую метку.
Новые engine cases проверяют три непересекающиеся ветви, арифметику, историю,
trailing comment, dotted discriminator, внешний Tags filter, контроль потери
ветвей без discriminator, локальную regex-интерполяцию, finite-value filtering
и точное имя синтетической dotted metric.
Legacy matrix покрывает все 12 обезличенных структур, запросы с Tags/без Tags,
empty/multi-label grouping, четыре matcher operators, восемь aggregations,
counter reset, разные окна `rate`, отличие dotted/underscore метрик и отказные paths.
Прежние 17 engine expressions сохраняют strict comparison; 34 новых используют
документированный `fuzzy_compare` Prometheus для одного бита mantissa при rate
extrapolation. Label sets и наличие серий сравниваются точно; широкого tolerance нет.
Browser suite проверяет RuleConf → Tags → button → handoff, derived labels,
отказы, collision, hash changes и lifecycle; editor/Run regression suite сохранён.
Для всех 12 новых fixture запросы проходят реальный preview/storage handoff и
page bridge к синтетическому model-backed Monaco editor: 9 Insert без Run,
3 явных Insert+Run с проверкой текста при клике. Это browser fixture, не live Grafana.
Шаг/диапазон Bosun не переносятся в панель Grafana автоматически.

Локальный замер пяти холодных проходов по всему конфигу: медиана 115 мс для
прежней реализации и 150 мс для структурной проверки. Это увеличение стоимости
полного config parse, а не каждого hash check. Тысяча преобразований одного
закэшированного выражения с различными синтетическими Tags заняла 13 мс.
Network cadence и snapshot publication не менялись. Это локальные замеры,
не гарантия производительности на всех браузерах и размерах конфигурации.

## Изменённые файлы и проверки

- `src/grafana/promql.js`: разбор, type/label analysis, output filter, cache и reason codes.
- `src/grafana/bosun-rule-graph.js`: проверка типов и bounded значений duration arguments.
- `src/bosun/content.js`: общий transform и агрегированная диагностика отказов.
- `tests/promql-semantics-test.js`, `tests/promql-engine-test.js`: новые семантические проверки.
- `tests/rule-graph-extensions-test.js`: 13 групп merge/interpolation регрессий,
  положительные случаи и fail-closed при конфликтах, injection и budgets.
- `tests/legacy-prom-test.js`: 12 обезличенных legacy fixtures, durations, filters,
  конкретные reason codes и отрицательная матрица. Подключён к `npm test`.
- `tests/smoke-test.js`, `tests/rule-graph-test.js`, `tests/browser-test.js`:
  регрессии и ожидания безопасного поведения.
- `tests/package-internal-test.js`: приватный config-canary не попадает в архив.
- `scripts/audit-grafana-rules.js`: локальный агрегированный аудит.
- `.gitignore`, `package.json`, `README.md`, этот документ; локальные
  `docs/ARCHITECTURE.md` и `docs/TESTING.md` также актуализированы.

Fail-before подтверждён для изменения глобального count и восстановления метки
через `on`, а также malformed Bosun duration. После исправлений проходят 13 групп
Node semantics, 13 групп merge/interpolation, legacy matrix и 51 выражение настоящего Prometheus engine. Независимое review
не оставило блокирующих замечаний. RE2 limitation описан выше.
Итоговые `npm test`, `npm run test:browser` (Chrome), `npm run check` и
`git diff --check` прошли успешно. Engine suite выполнен с локальным promtool 3.15.0.

`bosun-rules.conf` не редактировался; `git check-ignore -v` подтверждает корневое
правило `/bosun-rules.conf`, а `git ls-files` не содержит файл. Commit/push не выполнялись.
