# 설치 가이드

[English](install.md)

Pagehouse는 앱, PostgreSQL, 백업 작업, 이렇게 컨테이너 세 개로 동작합니다. 설정은 `.env` 파일 하나에 들어갑니다.

| 방법 | 이럴 때 |
|---|---|
| [1. 한 줄 설치](#1-한-줄-설치) | 인터넷이 되는 Linux·macOS 서버 |
| [2. 오프라인 설치](#2-오프라인-설치-폐쇄망) | 인터넷이 막힌 폐쇄망 |
| [3. 쿠버네티스(Helm)](#3-쿠버네티스helm) | 이미 클러스터를 운영할 때 |
| [4. 소스로 설치](#4-소스로-설치) | 개발하거나 이미지를 직접 빌드할 때 |

아래 명령의 `spro1/pagehouse`는 Pagehouse를 배포하는 GitHub 저장소입니다.

## 필요 사항

| | 최소 | 비고 |
|---|---|---|
| 컨테이너 런타임 | Docker 24 이상과 Compose v2, 또는 Podman 4 이상과 `podman compose` | Podman 6.0에서 확인 |
| CPU / 메모리 | 1 vCPU, 1GB | 50명 정도 팀에 충분 |
| 디스크 | 2GB + 첨부 + 백업 | 백업은 매번 전체 사본이며 기본 14개를 보관합니다 |
| 브라우저 | 최신 Chrome, Edge, Firefox, Safari | |

## 1. 한 줄 설치

```sh
curl -fsSL https://github.com/spro1/pagehouse/releases/latest/download/install.sh | sh
```

`./pagehouse` 폴더를 만들고, 무작위 DB 비밀번호로 `.env`를 쓰고, 이미지를 받아 실행한 뒤 정상이 될 때까지 기다립니다. 옵션:

```sh
curl -fsSL .../install.sh | sh -s -- --dir /opt/pagehouse --port 8080 --version 0.2.0
```

스크립트를 먼저 읽어 보고 싶다면 내려받아 확인한 뒤 `sh install.sh`로 실행하세요.

`http://<서버>:3000`에 접속합니다. **처음 만든 계정이 관리자가 되고**, 그 직후 가입이 닫힙니다. 다른 사람은 **관리 → 팀원 초대**로 초대합니다.

## 2. 오프라인 설치 (폐쇄망)

인터넷이 되는 PC에서 릴리스 페이지의 파일을 받습니다.

- `pagehouse-<버전>-offline-amd64.tar.gz` (대부분의 서버) 또는 `-arm64` (ARM 서버)
- `SHA256SUMS` (복사 후 파일 확인용)

서버로 옮긴 뒤:

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
| `PORT` | `3000` | 서버에서 열 포트 |
| `BIND_ADDRESS` | `0.0.0.0` | 같은 서버의 리버스 프록시로만 받으려면 `127.0.0.1` |
| `ALLOW_SIGNUP` | `0` | `1`이면 접속 가능한 누구나 가입 |
| `PAGEHOUSE_VERSION` | 설치 스크립트가 지정 | 이미지 버전. 업그레이드가 바꿉니다 |
| `BACKUP_INTERVAL_HOURS` / `BACKUP_KEEP` | `24` / `14` | 자동 백업 주기와 보관 개수 |

## HTTPS

TLS를 처리하는 리버스 프록시 뒤에 둡니다. 프록시는 `X-Forwarded-Proto`를 넘겨야 하고(로그인 쿠키에 `Secure`가 붙도록), 50MB까지 업로드를 허용해야 합니다. `BIND_ADDRESS=127.0.0.1`로 두면 평문 포트가 밖에서 보이지 않습니다.

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
    }
}
```

## 데이터는 이렇게 보호됩니다

Pagehouse는 사용자가 원하지 않는 한 쓴 내용이 사라지지 않도록 만들어졌습니다.

| 위험 | 보호 장치 |
|---|---|
| 페이지 삭제 | 하위 페이지와 함께 휴지통으로 갑니다. 언제든 복원할 수 있고 자동으로 비워지지 않습니다. 삭제 직후 **실행 취소**가 뜹니다 |
| 댓글 삭제 | 숨겨질 뿐 지워지지 않습니다. 삭제 직후 **실행 취소** |
| 실수로 본문을 지움 | 내용이 눈에 띄게 줄어드는 저장은 항상 새 이력을 만들므로, 지우기 전 내용이 **이력**에 남습니다 |
| 이전 버전으로 되돌림 | 지금 내용이 먼저 별도 이력으로 남습니다 |
| 네트워크 끊김, 탭 닫힘, 동시 수정 충돌 | 저장되지 못한 수정은 브라우저에 보관되고, 다음에 페이지를 열면 복원할지 묻습니다 |
| 서버·디스크 장애, `docker compose down -v` | 24시간마다 서버의 `./backups`에 자동 백업(14개 보관). 이 폴더는 서버 밖으로도 복사하세요 |
| 업그레이드 실패 | 업그레이드 전에 자동 백업합니다 (`backups/before-upgrade/`) |
| 잘못된 백업으로 복원 | `restore.sh`가 현재 상태를 먼저 백업하고(`backups/before-restore/`) 되돌리는 명령을 알려 줍니다 |
| `helm uninstall` | 볼륨과 DB Secret이 남습니다 |

## 백업과 복원

자동 백업은 따로 할 일이 없습니다. 실행될 때 한 번, 그 뒤 `BACKUP_INTERVAL_HOURS`마다 만들어집니다. 파일 이름은 `backups/pagehouse-auto-<시각>.tar.gz`이고 시각은 UTC 기준입니다. NAS로 매일 `rsync` 하는 식으로 서버 밖에도 복사해 두세요.

직접 백업하려면:

```sh
scripts/backup.sh                    # backups/pagehouse-<시각>.tar.gz
```

복원은 현재의 페이지·이력·계정을 바꿉니다. 바꾸기 전에 현재 상태를 먼저 백업합니다.

```sh
scripts/restore.sh backups/pagehouse-auto-20261124-030000.tar.gz
```

가끔 다른 장비에서 복원을 시험해 보세요. 복원해 본 적 없는 백업은 믿을 수 없습니다.

## 업그레이드

```sh
cd /opt/pagehouse
scripts/upgrade.sh            # 최신 버전
scripts/upgrade.sh 0.2.0      # 특정 버전
```

먼저 백업하고, `.env`와 모든 데이터를 그대로 둔 채 새 이미지를 받아 다시 띄웁니다. DB 구조 변경은 앱이 시작할 때 자동으로 적용됩니다. 문제가 생기면 `.env`의 `PAGEHOUSE_VERSION`을 이전 버전으로 되돌리고 `scripts/restore.sh backups/before-upgrade/<파일>`을 실행하세요.

오프라인: 새 오프라인 번들의 `install.sh --dir /opt/pagehouse`를 실행합니다.

## 외부 PostgreSQL 사용 (compose)

`pg_trgm` 확장을 쓸 수 있는 PostgreSQL 14 이상이 필요합니다. 첫 실행 때 `CREATE EXTENSION pg_trgm`을 실행하므로, 그 계정에 확장 생성 권한을 주거나 슈퍼유저로 미리 한 번 실행해 두세요. `docker-compose.yml`에서 앱의 `DATABASE_URL`을 바꾸고 `db` 서비스와 `depends_on` 부분을 지웁니다. 자동 백업 서비스와 스크립트는 함께 뜨는 DB만 다룹니다. 외부 DB는 `pg_dump`로, `files` 볼륨은 따로 백업하세요.

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
| 포트가 이미 사용 중 | `.env`의 `PORT`를 바꾸세요 |
| 로그인해도 다시 로그인 화면 | HTTPS인데 프록시가 `X-Forwarded-Proto`를 안 넘기거나, 두 주소로 번갈아 접속 |
| 큰 파일 업로드 실패 | 프록시 업로드 크기 제한(nginx `client_max_body_size`)을 올리세요 |
| 새 백업이 안 생김 | `docker compose logs backup`, 디스크 여유 공간 |
| 실행 중인 버전 확인 | `curl localhost:3000/healthz` |

## 제거

```sh
docker compose down        # 모두 멈춤, 데이터와 백업은 남음
```

`docker compose down -v`는 DB와 첨부 볼륨까지 지웁니다. `backups` 폴더는 남지만, 하기 전에 최근 백업이 있는지 꼭 확인하세요.
