# Bitrix24 Funnel Agent

Отдельный агент для ежедневной аналитики Bitrix24. Он не связан с Google Sheets, МойСклад, рейтингами или планами из основного проекта.

## Что делает

- Находит воронку сделок по названию.
- Загружает стадии этой воронки.
- Загружает сделки из воронки через `crm.deal.list`.
- Считает количество активных сделок по ответственным и стадиям.
- Отправляет отчёт в личный чат Bitrix24 через `im.message.add`.

По понедельникам в заголовке отчёта указывается, что это отчёт “за выходные и утро понедельника”. Сам отчёт показывает текущее состояние воронки на момент запуска.

## Настройка

```bash
cd bitrix24-funnel-agent
cp .env.example .env
```

В `.env` укажите реальный входящий вебхук:

```bash
BITRIX24_WEBHOOK_URL=https://crm.example.ru/rest/123/secret/
BITRIX24_FUNNEL_NAME=КПК - СПб
BITRIX24_REPORT_RECIPIENT_USER_ID=123874
BITRIX24_REPORT_TIME=10:20
BITRIX24_TIMEZONE=Europe/Moscow
```

Вебхук должен иметь права:

- `crm`
- `user`
- `im`

## Проверка без отправки

```bash
BITRIX24_DRY_RUN=1 node report.mjs
```

Если всё найдено правильно, команда выведет текст отчёта в терминал.

## Ручная отправка

```bash
node report.mjs
```

## GitHub Actions

В репозитории есть workflow `.github/workflows/daily-report.yml`. Он запускается:

- автоматически по будням в 10:20 МСК;
- вручную через `Actions` -> `Daily Bitrix24 Funnel Report` -> `Run workflow`.

В GitHub нужно добавить secret:

```text
BITRIX24_WEBHOOK_URL
```

И при желании variables:

```text
BITRIX24_FUNNEL_NAME=КПК - СПб
BITRIX24_REPORT_RECIPIENT_USER_ID=123874
```

## Cron на сервере

На сервере с московским временем добавьте cron:

```cron
20 10 * * 1-5 cd /path/to/moysklad-sheets-agent/bitrix24-funnel-agent && /usr/bin/env node report.mjs >> bitrix24-funnel.log 2>&1
```

Это запустит отчёт с понедельника по пятницу в 10:20. В выходные отчёт не отправляется, поэтому понедельничный запуск покрывает состояние после выходных.

Если сервер живёт не в московском часовом поясе, настройте timezone сервера или используйте планировщик, который умеет запуск по `Europe/Moscow`.
