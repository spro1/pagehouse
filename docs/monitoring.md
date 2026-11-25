# Monitoring

[한국어](monitoring.ko.md)

Three levels, from nothing to set up to a full alerting setup.

## 1. Admin → Overview → Server health

Always on. Refreshes every 30 seconds and lists what needs a look first:

| Shown | Warns when |
|---|---|
| Database response | a trivial query takes over 200 ms, or queries wait for a connection |
| Server delay (p99) | the server is too busy to run tasks on time (over 200 ms) |
| Requests, server errors, slow requests | any server error in the last 15 minutes; the latest errors are listed with time, request and message |
| Live editing | (information) pages open for co-editing and people in them |
| Waiting: mail / webhooks | notifications wait longer than usual to be emailed or posted to chat |
| Backup | the automatic backup is later than 1.5 × its interval |
| Webhooks | an admin webhook failed its last delivery |

The numbers are for the instance that answered. With several instances, use `/metrics` below.

## 2. Health check for load balancers and orchestrators

`GET /healthz` answers `200 {"ok":true,"version":"…"}` when the database answers, and `503` otherwise (or when an instance has been cut off from the others for over a minute). The Docker image and the Helm chart already use it.

## 3. Prometheus: `/metrics`

Set a token in `.env` and restart:

```sh
METRICS_TOKEN=$(openssl rand -hex 24)   # put the value in .env
docker compose up -d
curl -H "Authorization: Bearer <token>" http://localhost:3000/metrics
```

Without `METRICS_TOKEN` the endpoint answers 404. On Kubernetes, pass it with `extraEnv` from a Secret.

Scrape config:

```yaml
scrape_configs:
  - job_name: pagehouse
    metrics_path: /metrics
    authorization:
      credentials_file: /etc/prometheus/pagehouse-token   # the METRICS_TOKEN value
    static_configs:
      - targets: ["wiki.example.com:3000"]   # each app instance, not the load balancer
```

### Metrics

| Metric | Type | Meaning |
|---|---|---|
| `pagehouse_info{version}` | gauge | Running version |
| `pagehouse_http_requests_total{method,route,status}` | counter | Requests. `route` is the path shape (`/api/pages/:id`), never an id |
| `pagehouse_http_request_duration_seconds{route}` | histogram | Request duration |
| `pagehouse_server_errors_total` | counter | Requests that failed with an unexpected error |
| `pagehouse_db_latency_seconds` | gauge | Time for `SELECT 1` at scrape time |
| `pagehouse_db_pool_connections`, `pagehouse_db_pool_waiting` | gauge | Database connections held, queries waiting for one |
| `pagehouse_process_resident_memory_bytes`, `pagehouse_process_heap_used_bytes` | gauge | Memory |
| `pagehouse_event_loop_delay_p99_seconds` | gauge | How long tasks wait to run (busy server) |
| `pagehouse_process_uptime_seconds` | gauge | Since the instance started |
| `pagehouse_collab_rooms`, `pagehouse_collab_connections` | gauge | Live editing on this instance |
| `pagehouse_storage_bytes{kind}`, `pagehouse_storage_limit_bytes` | gauge | Database and attachment size, the admin's limit (0 = none) |
| `pagehouse_backup_last_success_timestamp_seconds` | gauge | Time of the last automatic backup (0 = none or the folder isn't mounted) |
| `pagehouse_notification_backlog{channel}` | gauge | Notifications waiting too long, for `mail` and `webhook` |
| `pagehouse_mail_sent_total{result}` | counter | Notification emails, `ok` or `failed` |
| `pagehouse_webhook_deliveries_total{kind,result}` | counter | Webhook posts, `admin` or `personal`, `ok` or `failed` |
| `pagehouse_webhooks_failing` | gauge | Enabled admin webhooks whose last delivery failed |
| `pagehouse_users`, `pagehouse_pages` | gauge | Active accounts, pages not in the trash |

Counters reset when an instance restarts; use `rate()` / `increase()` as usual.

### Example alerts

```yaml
groups:
  - name: pagehouse
    rules:
      - alert: PagehouseDown
        expr: up{job="pagehouse"} == 0
        for: 2m
      - alert: PagehouseServerErrors
        expr: increase(pagehouse_server_errors_total[10m]) > 0
      - alert: PagehouseSlow
        expr: histogram_quantile(0.95, sum by (le) (rate(pagehouse_http_request_duration_seconds_bucket{route!~"/api/collab.*"}[5m]))) > 1
        for: 10m
      - alert: PagehouseDatabaseSlow
        expr: pagehouse_db_latency_seconds > 0.2 or pagehouse_db_pool_waiting > 0
        for: 5m
      - alert: PagehouseBackupOverdue
        expr: time() - pagehouse_backup_last_success_timestamp_seconds > 36 * 3600   # daily backups
      - alert: PagehouseStorageNearLimit
        expr: pagehouse_storage_limit_bytes > 0 and sum without (kind) (pagehouse_storage_bytes) / pagehouse_storage_limit_bytes > 0.8
      - alert: PagehouseNotificationsStuck
        expr: pagehouse_notification_backlog > 0
        for: 30m
      - alert: PagehouseWebhookFailing
        expr: pagehouse_webhooks_failing > 0
        for: 30m
```

## Logs

Each container logs to stdout: `docker compose logs -f app` (also `backup`, `db`). Unexpected server errors are logged with the request, and show up in Server health.
