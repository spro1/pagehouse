# 모니터링

[English](monitoring.md)

설정 없이 바로 보는 화면부터 알림까지, 세 단계가 있습니다.

## 1. 관리 → 개요 → 서버 상태

항상 켜져 있습니다. 30초마다 새로 고치고, 확인할 것이 있으면 맨 위에 먼저 보여 줍니다.

| 항목 | 경고가 뜨는 경우 |
|---|---|
| DB 응답 | 간단한 쿼리가 200 ms를 넘거나, DB 연결을 기다리는 요청이 있을 때 |
| 서버 지연(p99) | 서버가 바빠 작업이 제때 실행되지 못할 때(200 ms 초과) |
| 요청, 서버 오류, 느린 요청 | 최근 15분 사이 서버 오류가 한 건이라도 있을 때. 최근 오류는 시각, 요청, 메시지와 함께 목록으로 보입니다 |
| 동시 편집 | (참고용) 공동 편집 중인 페이지와 사람 수 |
| 대기: 메일 / 웹훅 | 알림이 평소보다 오래 메일이나 채팅으로 나가지 못하고 있을 때 |
| 백업 | 자동 백업이 주기의 1.5배를 넘겨 늦었을 때 |
| 웹훅 | 관리자 웹훅의 마지막 전송이 실패했을 때 |

숫자는 그 요청에 답한 서버 인스턴스 기준입니다. 여러 대로 운영한다면 아래 `/metrics`를 쓰세요.

## 2. 로드밸런서·오케스트레이터용 상태 확인

`GET /healthz`는 DB가 응답하면 `200 {"ok":true,"version":"…"}`를, 아니면 `503`을 돌려줍니다. 인스턴스가 다른 인스턴스와 1분 넘게 연결이 끊겨도 `503`입니다. Docker 이미지와 Helm 차트에는 이미 들어가 있습니다.

## 3. Prometheus: `/metrics`

`.env`에 토큰을 넣고 재시작합니다.

```sh
METRICS_TOKEN=$(openssl rand -hex 24)   # 이 값을 .env에 넣으세요
docker compose up -d
curl -H "Authorization: Bearer <토큰>" http://localhost:3000/metrics
```

`METRICS_TOKEN`이 없으면 404를 돌려줍니다. 쿠버네티스에서는 Secret에서 `extraEnv`로 넘기세요.

수집 설정:

```yaml
scrape_configs:
  - job_name: pagehouse
    metrics_path: /metrics
    authorization:
      credentials_file: /etc/prometheus/pagehouse-token   # METRICS_TOKEN 값
    static_configs:
      - targets: ["wiki.example.com:3000"]   # 로드밸런서가 아니라 앱 인스턴스마다
```

### 지표

| 지표 | 종류 | 뜻 |
|---|---|---|
| `pagehouse_info{version}` | gauge | 실행 중인 버전 |
| `pagehouse_http_requests_total{method,route,status}` | counter | 요청 수. `route`는 경로 모양(`/api/pages/:id`)이고 ID가 그대로 들어가지 않습니다 |
| `pagehouse_http_request_duration_seconds{route}` | histogram | 요청 처리 시간 |
| `pagehouse_server_errors_total` | counter | 예상하지 못한 오류로 실패한 요청 |
| `pagehouse_db_latency_seconds` | gauge | 수집 시점의 `SELECT 1` 응답 시간 |
| `pagehouse_db_pool_connections`, `pagehouse_db_pool_waiting` | gauge | 잡고 있는 DB 연결 수, 연결을 기다리는 쿼리 수 |
| `pagehouse_process_resident_memory_bytes`, `pagehouse_process_heap_used_bytes` | gauge | 메모리 |
| `pagehouse_event_loop_delay_p99_seconds` | gauge | 작업이 실행되기까지 기다린 시간(서버가 바쁜지) |
| `pagehouse_process_uptime_seconds` | gauge | 인스턴스 실행 시간 |
| `pagehouse_collab_rooms`, `pagehouse_collab_connections` | gauge | 이 인스턴스의 동시 편집 |
| `pagehouse_storage_bytes{kind}`, `pagehouse_storage_limit_bytes` | gauge | DB와 첨부 파일 크기, 관리자가 정한 한도(0이면 없음) |
| `pagehouse_backup_last_success_timestamp_seconds` | gauge | 마지막 자동 백업 시각(0이면 없거나 백업 폴더가 마운트되지 않음) |
| `pagehouse_notification_backlog{channel}` | gauge | `mail`, `webhook`으로 너무 오래 나가지 못한 알림 |
| `pagehouse_mail_sent_total{result}` | counter | 알림 메일 `ok` / `failed` |
| `pagehouse_webhook_deliveries_total{kind,result}` | counter | 웹훅 전송, `admin` / `personal`, `ok` / `failed` |
| `pagehouse_webhooks_failing` | gauge | 마지막 전송에 실패한 관리자 웹훅 수 |
| `pagehouse_users`, `pagehouse_pages` | gauge | 활성 계정, 휴지통에 없는 페이지 |

counter는 인스턴스가 재시작하면 0부터 다시 셉니다. 평소처럼 `rate()` / `increase()`로 보세요.

### 알림 규칙 예시

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
        expr: time() - pagehouse_backup_last_success_timestamp_seconds > 36 * 3600   # 매일 백업 기준
      - alert: PagehouseStorageNearLimit
        expr: pagehouse_storage_limit_bytes > 0 and sum without (kind) (pagehouse_storage_bytes) / pagehouse_storage_limit_bytes > 0.8
      - alert: PagehouseNotificationsStuck
        expr: pagehouse_notification_backlog > 0
        for: 30m
      - alert: PagehouseWebhookFailing
        expr: pagehouse_webhooks_failing > 0
        for: 30m
```

## 로그

컨테이너마다 표준 출력으로 로그를 남깁니다: `docker compose logs -f app`(`backup`, `db`도 같은 방식). 예상하지 못한 서버 오류는 요청 정보와 함께 로그에 남고, 서버 상태 화면에도 보입니다.
