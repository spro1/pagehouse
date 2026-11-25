# 설치 가이드

[English](install.md)

Pagehouse는 컨테이너 세 개(앱, PostgreSQL, 백업 작업)로 동작합니다. 설정은 `.env` 파일 하나에 들어갑니다.

| 방법 | 이럴 때 |
|---|---|
| [1. 한 줄 설치](#1-한-줄-설치) | 인터넷이 되는 Linux·macOS 서버 |
| [2. 오프라인 설치](#2-오프라인-설치-폐쇄망) | 인터넷이 막힌 폐쇄망 |
| [3. 쿠버네티스(Helm)](#3-쿠버네티스helm) | 이미 클러스터를 운영할 때 |
| [4. 소스로 설치](#4-소스로-설치) | 개발하거나 이미지를 직접 빌드할 때 |

아래 명령의 `spro1/pagehouse`는 Pagehouse를 배포하는 GitHub 저장소입니다.

## 필요 사항

| 규모 | CPU | 메모리 | 디스크 | 비고 |
|---|---|---|---|---|
| **최소** (체험, ~20명) | 1 vCPU | 1GB | 5GB + 첨부 × 15 | HDD도 가능 |
| **권장** (~50명) | 2 vCPU | 2GB | 20GB SSD + 첨부 × 15 | |
| **권장** (~200명) | 2~4 vCPU | 4GB | 50GB SSD + 첨부 × 15 | 동시 편집과 대량 가져오기가 잦은 팀 |
| **더 큰 조직** | 앱 여러 대 | 앱당 1~2GB | 외부 PostgreSQL + 공유 스토리지 | 쿠버네티스 `replicaCount`, ReadWriteMany 볼륨 |

- **실측:** 대기 상태에서 앱은 메모리 약 50MB, DB 약 50MB를 씁니다. 이미지는 앱 약 190MB, DB 약 300MB입니다. 남는 메모리는 PostgreSQL 캐시와 내보내기·가져오기에 쓰입니다. 3,000쪽 기준으로 페이지 트리 6ms, 검색 3ms에 응답했습니다.
- **디스크:** 백업은 매번 전체 사본(DB + 첨부)을 만들고 기본으로 14개를 보관하므로 `(DB + 첨부) × 15`만큼 잡으세요. 백업을 서버 밖으로 옮긴다면 줄여도 됩니다.
- **CPU 아키텍처:** amd64(x86_64), arm64

| 소프트웨어 | 지원 | 비고 |
|---|---|---|
| 컨테이너 런타임 | Docker 24 이상과 Compose v2, 또는 Podman 4 이상과 `podman compose` | Podman 6.0에서 확인 |
| 쿠버네티스 | 1.21 이상(차트가 쓰는 `batch/v1` CronJob 기준), Helm 3 | 여러 대로 늘리려면 ReadWriteMany 스토리지 |
| 외부 PostgreSQL | 14 이상, `pg_trgm` 확장 | 선택 |
| 브라우저 | 최신 Chrome, Edge, Firefox, Safari | 수백 MB짜리 내보내기 파일을 가져올 때는 브라우저에 1~2GB 여유 메모리가 필요합니다(압축을 풀고 폴더를 선택하면 덜 씁니다) |

## 1. 한 줄 설치

```sh
curl -fsSL https://github.com/spro1/pagehouse/releases/latest/download/install.sh | sh
```

스크립트는 `./pagehouse` 폴더를 만들고 무작위 DB 비밀번호로 `.env`를 작성한 다음 이미지를 받아 실행하고 정상 상태가 될 때까지 기다립니다. 옵션은 이렇게 줍니다.

```sh
curl -fsSL .../install.sh | sh -s -- --dir /opt/pagehouse --port 8080 --version 0.2.0
```

스크립트를 먼저 읽어 보고 싶다면 내려받아 확인한 뒤 `sh install.sh`로 실행하세요.

`http://<서버>:3000`에 접속합니다. **처음 만든 계정이 관리자가 되고** 그 직후 가입이 닫힙니다. 다른 사람은 **관리 → 팀원 초대**로 초대합니다.

## 2. 오프라인 설치 (폐쇄망)

인터넷이 되는 PC에서 릴리스 페이지의 다음 파일을 받습니다.

- `pagehouse-<버전>-offline-amd64.tar.gz` (대부분의 서버) 또는 `-arm64` (ARM 서버)
- `SHA256SUMS` (복사 후 파일 확인용)

서버로 옮긴 뒤 다음을 실행합니다.

```sh
sha256sum -c SHA256SUMS --ignore-missing     # 선택: 복사본 확인
tar xzf pagehouse-<버전>-offline-amd64.tar.gz
sh pagehouse-<버전>/install.sh --dir /opt/pagehouse
```

번들 안에 컨테이너 이미지가 들어 있어 아무것도 내려받지 않습니다. 업그레이드도 새 번들로 같은 `--dir`을 지정해 똑같이 하면 됩니다.

## 3. 쿠버네티스(Helm)

릴리스 페이지에서 `pagehouse-<버전>.tgz`를 받습니다.

```sh
helm install wiki pagehouse-<버전>.tgz -n wiki --create-namespace \
  --set ingress.enabled=true --set ingress.host=wiki.example.com \
  --set ingress.annotations."nginx\.ingress\.kubernetes\.io/proxy-body-size"=50m
```

앱(레플리카 1개), PostgreSQL StatefulSet, 전용 볼륨에 쓰는 일일 백업 CronJob, 생성된 DB 비밀번호가 든 Secret이 만들어집니다. 주요 값:

| 값 | 기본값 | 의미 |
|---|---|---|
| `image.repository` | 배포된 이미지 | 폐쇄망에서는 사내 레지스트리 미러를 지정하세요 |
| `replicaCount` + `persistence.accessMode=ReadWriteMany` | 1 | 앱 파드 여러 개(첨부 파일용 ReadWriteMany 스토리지 필요). 동시 편집은 PostgreSQL을 거쳐 파드 사이에서도 동작 |
| `persistence.size` / `postgresql.size` / `backup.size` | 10Gi / 10Gi / 20Gi | 볼륨 크기 |
| `postgresql.enabled=false` + `externalDatabase.url` | | 외부 PostgreSQL 14 이상 사용 |
| `backup.schedule` / `backup.keep` | `0 3 * * *` / 14 | 백업 주기와 보관 개수 |
| `allowSignup` | false | 공개 가입 허용 |

**데이터 보호:** `helm uninstall`을 해도 DB 볼륨, 첨부 볼륨, 백업 볼륨, DB Secret은 남습니다. 업그레이드할 때는 기존 DB 비밀번호를 그대로 씁니다. 정말 모두 지울 때만 직접 삭제하세요.

업그레이드: `helm upgrade wiki pagehouse-<새 버전>.tgz -n wiki --reuse-values`

## 4. 소스로 설치

```sh
git clone https://github.com/spro1/pagehouse && cd pagehouse
cp .env.example .env        # POSTGRES_PASSWORD 설정, 직접 빌드하려면 COMPOSE_FILE 주석 해제
docker compose up -d --build
```

## 설정 (`.env`)

바꾼 뒤에는 `docker compose up -d`로 다시 띄웁니다.

| 변수 | 기본값 | 의미 |
|---|---|---|
| `POSTGRES_PASSWORD` | 설치 스크립트가 생성 | DB 비밀번호. 나중에 바꾸려면 Postgres 안에서도 바꿔야 합니다 |
| `SECRET_KEY` | 설치 스크립트가 생성 | 저장된 비밀값(SSO Client secret)을 암호화합니다. DB와 백업에는 들어가지 않으니 **`.env`를 따로 안전한 곳에 보관하세요.** 키가 다른 서버로 복원하면 SSO 시크릿을 다시 입력해야 합니다. 예전 설치본은 업그레이드할 때 자동으로 생깁니다. |
| `PORT` | `3000` | 서버에서 열 포트 |
| `BIND_ADDRESS` | `0.0.0.0` | 같은 서버의 리버스 프록시로만 받으려면 `127.0.0.1`(이때 `TRUST_PROXY=1`도) |
| `ALLOW_SIGNUP` | `0` | `1`이면 접속 가능한 누구나 가입 |
| `PUBLIC_URL` | (요청에서 추정) | 사용자가 접속하는 주소. 예: `https://wiki.example.com`. SSO 리디렉션과 메일 링크에 쓰임 |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | 비어 있음 | **보통은 관리 → SSO 화면에서 설정하면 됩니다**([SSO 연결 가이드](sso.ko.md)). 여기에 넣으면 화면 설정보다 우선하고 화면은 읽기 전용이 됩니다. OpenID Connect SSO(Keycloak으로 테스트). 리디렉션 URI: `<PUBLIC_URL>/api/auth/oidc/callback` |
| `OIDC_LABEL` | `SSO` | 로그인 버튼 문구 |
| `OIDC_AUTO_CREATE` | `1` | `0`이면 같은 이메일 계정이 이미 있는 사람만 로그인 |
| `PASSWORD_LOGIN` | `1` | SSO를 켠 상태에서 `0`이면 관리자만 비밀번호 로그인 가능 |
| `TRUST_PROXY` | `0` | 앞단 리버스 프록시 수. 프록시 뒤라면 `1`로 두어야 로그인 시도 제한과 감사 로그가 실제 접속 주소를 씁니다. 직접 접속이면 `0`(Helm은 인그레스를 켜면 자동으로 `1`) |
| `OIDC_TRUST_EMAIL` | `0` | SSO 계정은 이메일로 연결되므로 제공자가 확인(verified)한 이메일만 받습니다. `email_verified`를 보내지 않는 제공자(일부 Entra ID)에서 `1`. 사용자가 제공자 쪽 이메일을 직접 바꿀 수 없을 때만 쓰세요 |
| `SMTP_URL`, `SMTP_FROM` | 비어 있음 | 읽지 않은 알림 메일과 "비밀번호를 잊으셨나요?" 재설정 메일. 예: `smtp://user:pass@mail.example.com:587`. 메일 속 링크는 `PUBLIC_URL`이 있어야 함 |
| `METRICS_TOKEN` | 비어 있음 | 넣으면 `/metrics`(Prometheus)가 켜지고, 이 값을 bearer 토큰으로 보내야 볼 수 있습니다. [모니터링](monitoring.ko.md) 참고 |
| `WEBHOOK_ALLOW` | 비어 있음 | 개인 알림 웹훅이 보낼 수 있는 내부망 호스트. 예: `chat.corp.local,.corp.local`. 목록에 없으면 사설·루프백 주소는 막힙니다. 관리자 웹훅은 어디로든 보낼 수 있습니다 |
| `LINK_PREVIEW` / `LINK_PREVIEW_ALLOW` | `1` / 비어 있음 | 링크 카드: 서버가 붙여 넣은 링크의 제목과 이미지를 가져옴. 사설·루프백 주소는 목록에 있어야 허용. 예: `jira.corp.local,.gitlab.corp.local` |
| `PAGEHOUSE_VERSION` | 설치 스크립트가 지정 | 이미지 버전. 업그레이드가 바꿉니다 |
| `BACKUP_INTERVAL_HOURS` / `BACKUP_KEEP` | `24` / `14` | 자동 백업 주기와 보관 개수의 기본값. **관리 → 개요 → 백업 정책**에서 바꾸면 그 값이 우선하고, 재시작하지 않아도 됩니다 |

## HTTPS

TLS를 처리하는 리버스 프록시 뒤에 둡니다. 프록시는 로그인 쿠키에 `Secure`가 붙도록 `X-Forwarded-Proto`를 넘겨야 하고 업로드를 50MB까지 허용해야 합니다. `BIND_ADDRESS=127.0.0.1`로 두면 평문 포트가 밖에서 보이지 않습니다.

**Caddy** (인증서 자동):

```
wiki.example.com {
    reverse_proxy localhost:3000
}
```

**nginx**:

```nginx
server {
    listen 443 ssl;
    server_name wiki.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;
    client_max_body_size 50m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # Live co-editing uses WebSockets.
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }
}
```

## 데이터는 이렇게 보호됩니다

Pagehouse는 사용자가 원하지 않는 한 쓴 내용이 사라지지 않도록 만들어졌습니다.

| 위험 | 보호 장치 |
|---|---|
| 페이지 삭제 | 하위 페이지와 함께 휴지통으로 갑니다. 언제든 복원할 수 있고 자동으로 비워지지 않습니다. 삭제 직후 **실행 취소**가 뜹니다 |
| 댓글 삭제 | 숨겨질 뿐 지워지지 않습니다. 삭제 직후 **실행 취소** |
| 실수로 본문을 지움 | 내용이 눈에 띄게 줄어드는 저장은 항상 새 이력을 만들어서 지우기 전 내용이 **이력**에 남습니다 |
| 이전 버전으로 되돌림 | 지금 내용이 먼저 별도 이력으로 남습니다 |
| 네트워크 끊김, 탭 닫힘, 동시 수정 충돌 | 저장하지 못한 수정은 브라우저에 보관됩니다. 다음에 페이지를 열면 복원할지 묻습니다 |
| 서버·디스크 장애, `docker compose down -v` | 24시간마다 서버의 `./backups`에 자동 백업(14개 보관). 이 폴더는 서버 밖으로도 복사하세요 |
| 업그레이드 실패 | 업그레이드 전에 자동 백업합니다 (`backups/before-upgrade/`) |
| 잘못된 백업으로 복원 | `restore.sh`가 현재 상태를 먼저 백업하고(`backups/before-restore/`) 되돌리는 명령을 알려 줍니다 |
| `helm uninstall` | 볼륨과 DB Secret이 남습니다 |

## 백업과 복원

자동 백업은 따로 할 일이 없습니다. 실행될 때 한 번, 그 뒤 `BACKUP_INTERVAL_HOURS`마다 만들어집니다. 파일 이름은 `backups/pagehouse-auto-<시각>.tar.gz`이고 시각은 UTC 기준입니다. NAS로 매일 `rsync` 하는 식으로 서버 밖에도 복사해 두세요.

**백업 정책**(관리 → 개요): 자동 백업 주기와 보관 개수를 정하고, 필요하면 며칠 지난 자동 백업이나 수동·업그레이드 전 백업(`backups/pagehouse-<시각>.tar.gz`, `backups/before-upgrade/`)을 지우게 할 수 있습니다. 따로 정하지 않으면 수동 백업은 지우지 않습니다. 오래된 백업은 새 백업이 성공한 뒤에만 지우고, `backups/`의 다른 파일은 건드리지 않습니다. Kubernetes에서는 백업 주기를 Helm values의 `backup.schedule`로 정하고, 보관 설정은 똑같이 적용됩니다.

직접 백업하려면 다음을 실행합니다.

```sh
scripts/backup.sh                    # backups/pagehouse-<시각>.tar.gz
```

복원하면 지금의 페이지·이력·계정을 덮어씁니다. 덮어쓰기 전에 현재 상태를 먼저 백업합니다.

```sh
scripts/restore.sh backups/pagehouse-auto-20261124-030000.tar.gz
```

가끔 다른 장비에서 복원을 시험해 보세요. 복원해 본 적 없는 백업은 믿을 수 없습니다.

## 업그레이드

버전마다 확인할 것(DB 변경, 새 설정, 동작 변경)은 [업그레이드 가이드](upgrading.ko.md)에 있습니다.

```sh
cd /opt/pagehouse
scripts/upgrade.sh            # 최신 버전
scripts/upgrade.sh 0.2.0      # 특정 버전
```

스크립트는 먼저 백업한 뒤 `.env`와 모든 데이터를 그대로 둔 채 새 이미지를 받아 다시 띄웁니다. DB 구조 변경은 앱이 시작할 때 자동으로 적용됩니다. 문제가 생기면 `.env`의 `PAGEHOUSE_VERSION`을 이전 버전으로 되돌리고 `scripts/restore.sh backups/before-upgrade/<파일>`을 실행하세요.

오프라인 환경에서는 새 오프라인 번들의 `install.sh --dir /opt/pagehouse`를 실행합니다.

## 외부 PostgreSQL 사용 (compose)

`pg_trgm` 확장을 쓸 수 있는 PostgreSQL 14 이상이 필요합니다. 앱이 첫 실행 때 `CREATE EXTENSION pg_trgm`을 실행하므로 그 계정에 확장 생성 권한을 주거나 슈퍼유저로 미리 한 번 실행해 두세요. `docker-compose.yml`에서 앱의 `DATABASE_URL`을 바꾸고 `db` 서비스와 `depends_on` 부분을 지웁니다. 자동 백업 서비스와 스크립트는 함께 뜨는 DB만 다룹니다. 외부 DB는 `pg_dump`로, `files` 볼륨은 따로 백업하세요.

## 데이터 위치

| 데이터 | 위치 |
|---|---|
| 페이지, 이력, 댓글, 계정 | compose 볼륨 `db` (PostgreSQL) |
| 첨부 파일 | compose 볼륨 `files` (앱 안의 `/data/files`) |
| 백업 | 설치 폴더의 `./backups` |
| 설정 | `.env` (권한 600, DB 비밀번호 포함) |

## 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 페이지가 안 열림 | `docker compose ps`에서 컨테이너가 `healthy`인지, `docker compose logs app` |
| `POSTGRES_PASSWORD` 오류 | `.env`가 있는 설치 폴더에서 compose를 실행했는지 |
| 설치가 "a database volume from an earlier install … still exists"로 멈춤 | 같은 이름의 폴더에 했던 예전 설치의 데이터가 남아 있고 그 `.env`는 없는 상태입니다. 그 데이터를 살리려면 예전 `.env`를 되돌려 놓고, 새로 시작하려면 메시지에 나온 볼륨을 지운 뒤 다시 실행하세요 |
| 포트가 이미 사용 중 | `.env`의 `PORT`를 바꾸세요 |
| 로그인해도 다시 로그인 화면 | HTTPS인데 프록시가 `X-Forwarded-Proto`를 안 넘기거나, 두 주소로 번갈아 접속 |
| 큰 파일 업로드 실패 | 프록시 업로드 크기 제한(nginx `client_max_body_size`)을 올리세요 |
| 새 백업이 안 생김 | `docker compose logs backup`, 디스크 여유 공간 |
| 실행 중인 버전 확인 | `curl localhost:3000/healthz` |
| 갑자기 빈 화면 | 업그레이드 직후 열려 있던 탭이면 새로고침 한 번. 그래도 나오면 "화면을 표시하지 못했습니다" 안내와 함께 원인이 콘솔에 남습니다 |
| 복사 버튼이 안 됨 | 최신 버전에서는 HTTP 주소에서도 동작합니다. 오래된 탭이면 새로고침 |
| `/healthz`가 503 (`relay: down`) | 여러 대 구성에서 DB 알림 연결이 1분 넘게 끊김. DB 상태를 확인하면 앱이 다시 연결합니다 |
| 비밀번호를 잊음 | `SMTP_URL`이 있으면 로그인 화면에서 재설정 메일, 없으면 관리자가 **관리 → 사용자**에서 재설정 링크·임시 비밀번호 발급 |

## 제거

```sh
docker compose down        # 모두 멈춤, 데이터와 백업은 남음
```

`docker compose down -v`는 DB와 첨부 볼륨까지 지웁니다. `backups` 폴더는 남지만 실행하기 전에 최근 백업이 있는지 꼭 확인하세요.
