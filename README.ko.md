<div align="center">

<img src="docs/images/logo.svg" width="72" height="72" alt="Pagehouse 로고">

# Pagehouse

**작은 회사와 팀이 자기 서버에 설치해 쓰는 온프레미스 팀 위키**<br>
주간보고, 회의록, 기술 문서를 우리 망 안에서 한곳에 관리합니다.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/spro1/pagehouse/actions/workflows/ci.yml/badge.svg)](https://github.com/spro1/pagehouse/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/spro1/pagehouse?include_prereleases&sort=semver)](https://github.com/spro1/pagehouse/releases)
![Docker | Podman | Kubernetes](https://img.shields.io/badge/runs%20on-Docker%20%7C%20Podman%20%7C%20Kubernetes-2f6feb)
![Air-gapped](https://img.shields.io/badge/air--gapped-supported-2f6feb)

[도입 판단](#도입-판단) · [설치](#설치) · [도입 첫날](#도입-첫날-체크리스트) · [운영](#운영) · [데이터 이관](#기존-위키에서-옮기기) · [FAQ](#자주-묻는-질문) · [English](README.md)

<img src="docs/images/screenshot-light.png" alt="체크리스트, 배포 표, 코드 블록, 패널이 있는 Pagehouse 페이지" width="100%">

</div>

## 이런 조직을 위해 만들었습니다

- 유료 위키(SaaS) 비용이 부담되거나, 계약 갱신 때마다 사용자 수를 세야 하는 **5~200명 규모의 회사와 팀**
- 문서가 **회사 밖 서버에 저장되면 안 되는** 조직: 보안 규정, 고객사 요구, 폐쇄망 환경
- 전담 운영 인력 없이 **서버 한 대에 올려 두고 신경 쓸 일이 적어야 하는** 팀

## 도입 판단

| | Pagehouse |
|---|---|
| **데이터 위치** | 전부 우리 서버 안(PostgreSQL과 파일 볼륨). 앱은 외부로 어떤 요청도 보내지 않고, 외부 글꼴·CDN·원격 수집도 없습니다 |
| **인터넷 없는 환경** | 이미지가 든 오프라인 번들로 설치·업그레이드 가능 |
| **비용** | Apache-2.0 오픈소스, 사용자 수 제한 없음 |
| **필요한 것** | Linux 서버 한 대와 Docker 또는 Podman. 쿠버네티스를 쓴다면 Helm 차트 |
| **구성 요소** | 앱, PostgreSQL, 백업 작업. 컨테이너 세 개뿐이고 외부 서비스 의존 없음 |
| **데이터 보호** | 삭제는 휴지통(자동으로 비워지지 않음), 버전 이력, 매일 자동 백업, 업그레이드·복원 전 자동 백업 |
| **나갈 때** | 스페이스 전체를 Markdown과 첨부 ZIP으로 내보내기. 데이터가 특정 형식에 묶이지 않습니다 |
| **아직 없는 것** | SSO(OIDC), 실시간 공동 편집, 메일 알림. [로드맵](#로드맵) 참고 |

## 주요 기능

| | |
|---|---|
| ✍️ **에디터** | `/` 블록 메뉴, Markdown 단축 입력, 셀 병합·분할되는 표, 25개 언어 코드 강조, 정보·주의 패널, 할 일, 붙여넣기·끌어 놓기로 이미지·파일 첨부, `@` 멘션 |
| 🏠 **홈과 알림** | 로그인하면 최근 본 페이지, 새로 만든 페이지, 나를 언급한 문서와 댓글이 모인 홈. 알림 종에 읽지 않은 수 표시 |
| 🗂️ **정리** | 스페이스, 끌어서 옮기는 하위 페이지, 템플릿(주간보고·회의록·기술 문서), 실행 취소되는 휴지통 |
| 🔎 **검색** | ⌘K 빠른 검색과 전체 검색 페이지. 한국어 포함 모든 단어 일치, 스페이스·작성자·기간 필터 |
| 🔒 **권한** | 스페이스별 공개 범위(모두 편집·모두 보기·비공개)와 멤버 역할, 페이지별 보기·편집 제한. 권한 밖의 문서는 검색·첨부·이력 어디에도 나오지 않음 |
| 💬 **협업** | 답글과 해결 처리가 되는 댓글, 되돌릴 수 있는 버전 이력, 동시 수정 덮어쓰기 방지 |
| 📦 **이관** | Confluence HTML, Notion, Markdown, HTML 가져오기. Markdown+첨부 ZIP 내보내기 |
| 📊 **관리** | 저장 공간 사용량과 한도, 디스크 여유, 백업 상태, 활동, 큰 파일 |
| 🌐 **화면** | 한국어·영어, 라이트·다크 테마(계정별 설정) |

<table>
  <tr>
    <td width="50%"><img src="docs/images/screenshot-dark.png" alt="다크 테마"></td>
    <td width="50%"><img src="docs/images/screenshot-search.png" alt="빠른 검색"></td>
  </tr>
  <tr>
    <td align="center"><sub>다크 테마</sub></td>
    <td align="center"><sub>⌘K 빠른 검색</sub></td>
  </tr>
</table>

## 서버 사양

| 규모 | CPU / 메모리 | 디스크 |
|---|---|---|
| ~50명 | 1 vCPU / 1GB | 10GB + 첨부 용량 |
| ~200명 | 2 vCPU / 4GB | 20GB + 첨부 용량 |

- 백업은 매번 전체 사본이고 기본 14개를 보관하므로, `(DB + 첨부) × 15` 정도의 여유를 잡아 두세요.
- 위 수치는 참고 기준입니다. 3,000쪽 기준으로 페이지 트리는 6ms, 검색은 3ms에 응답하는 것을 확인했습니다.

## 설치

필요한 것은 Docker 24 이상 또는 Podman 4 이상입니다. 환경에 맞는 방법을 고르세요.

### A. 인터넷이 되는 서버 한 대

```sh
curl -fsSL https://github.com/spro1/pagehouse/releases/latest/download/install.sh | sh -s -- --dir /opt/pagehouse
```

베타 기간에는 버전을 지정합니다:

```sh
curl -fsSL https://github.com/spro1/pagehouse/releases/download/v0.1.0-beta.2/install.sh | sh -s -- --dir /opt/pagehouse --version 0.1.0-beta.2
```

설치 스크립트는 다음을 처리합니다.

- 무작위 DB 비밀번호가 든 `.env`를 권한 600으로 만듭니다.
- 이미지를 받아 서비스를 띄웁니다.
- 정상 상태가 될 때까지 기다립니다.

### B. 폐쇄망 (인터넷 없음)

인터넷이 되는 PC에서 릴리스 페이지의 `pagehouse-<버전>-offline-amd64.tar.gz`(ARM 서버는 `-arm64`)와 `SHA256SUMS`를 받아 서버로 옮긴 뒤:

```sh
sha256sum -c SHA256SUMS --ignore-missing
tar xzf pagehouse-<버전>-offline-amd64.tar.gz
sh pagehouse-<버전>/install.sh --dir /opt/pagehouse
```

번들 안에 컨테이너 이미지가 들어 있어 아무것도 내려받지 않습니다.

### C. 쿠버네티스

```sh
helm install wiki pagehouse-<버전>.tgz -n wiki --create-namespace \
  --set ingress.enabled=true --set ingress.host=wiki.example.com
```

PostgreSQL, 일일 백업 CronJob, 생성된 DB 비밀번호가 함께 설치됩니다. 폐쇄망 클러스터라면 `image.repository`를 사내 레지스트리 미러로 지정하세요. 자세한 값은 [설치 가이드](docs/install.ko.md#3-쿠버네티스helm)에 있습니다.

## 도입 첫날 체크리스트

1. **관리자 계정**: `http://<서버>:3000`에 접속해 첫 계정을 만듭니다. 이 계정이 관리자가 되고, 그 뒤 가입이 닫힙니다.
2. **HTTPS**: 사내 리버스 프록시(nginx, Caddy 등) 뒤에 두고, `.env`에서 `BIND_ADDRESS=127.0.0.1`로 설정합니다. [설정 예시](docs/install.ko.md#https)
3. **팀원 초대**: **관리 → 사용자**에서 초대 링크를 만들어 메신저로 전달합니다. 메일 서버는 필요 없습니다.
4. **스페이스**: 팀별로 만들고, 인사·경영처럼 민감한 곳은 **비공개**로 둡니다.
5. **백업 확인**: **관리 → 개요**에 "마지막 자동 백업"이 보이는지 확인하고, `/opt/pagehouse/backups`를 NAS 등 서버 밖으로 복사하도록 설정합니다.
6. **저장 한도**(선택): **관리 → 개요**에서 정합니다. 한도에 도달해도 글은 계속 저장되고, 새 파일 업로드만 막힙니다.
7. **기존 문서 이관**: 아래 [기존 위키에서 옮기기](#기존-위키에서-옮기기)를 참고합니다.

## 운영

| 작업 | 방법 |
|---|---|
| 백업 | 자동: 24시간마다 `backups/pagehouse-auto-*.tar.gz`(14개 보관). 수동: `scripts/backup.sh` |
| 복원 | `scripts/restore.sh <백업 파일>`. 현재 상태를 먼저 백업하고, 되돌리는 명령을 알려 줍니다 |
| 업그레이드 | `scripts/upgrade.sh [버전]`. 먼저 백업하고, `.env`와 데이터는 그대로 둡니다. 폐쇄망은 새 번들의 `install.sh --dir`로 합니다 |
| 상태 확인 | `curl localhost:3000/healthz`(버전 포함), 관리 화면의 저장 공간·백업·활동 |
| 로그 | `docker compose logs app` |

데이터는 compose 볼륨 `db`(페이지·이력·계정)와 `files`(첨부), 설치 폴더의 `backups/`에 있습니다. 외부 PostgreSQL을 쓰는 방법은 [설치 가이드](docs/install.ko.md#외부-postgresql-사용-compose)를 보세요.

## 기존 위키에서 옮기기

**홈 → 가져오기**에 파일이나 ZIP을 넣으면 됩니다.

| 원본 | 내보내는 방법 | 옮겨지는 것 |
|---|---|---|
| **Confluence** | 스페이스 도구 → 내보내기 → HTML | 페이지 계층(breadcrumb 기준), 첨부·이미지, 정보·경고 매크로를 패널로, 코드 매크로 |
| **Notion** | 설정 → 내보내기 → Markdown & CSV | 하위 페이지 계층, 이미지, 페이지 간 링크 |
| **Markdown·HTML 폴더** | 폴더째 ZIP으로 | 폴더를 상위 페이지로, 링크된 이미지·파일 |
| **Pagehouse** | 스페이스 메뉴 → 내보내기 | 전부 그대로(계층, 첨부, 링크) |

가져오기는 항상 새 페이지로 추가하고 기존 페이지는 건드리지 않습니다. 결과가 마음에 들지 않으면 휴지통으로 옮기고 다시 하면 됩니다.

## 보안

- **데이터가 망 밖으로 나가지 않습니다.** 외부 호출, 원격 수집, 외부 자원 로딩이 없습니다.
- **권한이 서버에서 적용됩니다.** 권한 밖의 페이지는 화면에서만 숨기는 것이 아니라 API, 검색, 첨부, 이력, 내보내기 모든 경로에서 404로 응답합니다.
- **브라우저 방어:**
  - 엄격한 Content-Security-Policy를 씁니다.
  - 다른 사이트에서 오는 쓰기 요청을 차단합니다.
  - 로그인 시도를 제한합니다.
  - 업로드 파일은 격리(sandbox)해 다운로드로만 제공합니다.
- **컨테이너:**
  - 앱과 DB를 root가 아닌 사용자로 실행합니다.
  - 이미지에 패키지 관리자와 쓰지 않는 TLS 라이브러리가 없습니다.
  - 고칠 수 있는 CVE가 하나라도 있으면 CI가 실패합니다(Trivy).
  - Dependabot이 매주 의존성 업데이트를 엽니다.

취약점은 공개 이슈 대신 [SECURITY.md](SECURITY.md)의 방법으로 알려 주세요.

## 자주 묻는 질문

**인터넷 연결이 필요한가요?**
아니요. 설치(오프라인 번들), 사용, 업그레이드 모두 인터넷 없이 됩니다.

**몇 명까지 쓸 수 있나요?**
사용자 수 제한은 없습니다. 서버 한 대 구성으로 수백 명 규모를 목표로 합니다.

**회사 계정(SSO)으로 로그인할 수 있나요?**
아직은 안 됩니다. 자체 계정과 초대 링크를 씁니다. OIDC 기반 SSO를 준비하고 있습니다.

**관리자는 비공개 문서도 볼 수 있나요?**
사이트 관리자는 잠긴 문서를 풀어 줄 수 있도록 모든 스페이스와 페이지에 접근할 수 있습니다. 관리자 계정은 꼭 필요한 사람에게만 주세요.

**서버가 죽으면 데이터는요?**
매일 자동 백업이 서버의 `backups/` 폴더에 쌓입니다. 이 폴더를 서버 밖으로 복사해 두면 새 서버에 설치한 뒤 `scripts/restore.sh`로 복원할 수 있습니다.

**나중에 다른 도구로 옮길 수 있나요?**
스페이스 전체를 표준 Markdown과 첨부 파일로 내보낼 수 있습니다.

## 로드맵

- SSO (OIDC: Keycloak, Microsoft Entra, Google Workspace 등)
- 실시간 공동 편집
- 메일·메신저(웹훅) 알림
- 에이전트를 위한 API 토큰과 MCP 서버

## 문서

- [설치 가이드](docs/install.ko.md): 설치 방법, HTTPS, 백업·복원, 업그레이드, 쿠버네티스, 문제 해결
- [사용 가이드](docs/user-guide.ko.md): 에디터, 검색, 권한, 멘션·알림, 가져오기·내보내기, 관리
- [기여하기](CONTRIBUTING.md) · [보안 정책](SECURITY.md) · [릴리스](docs/releasing.md)

## 개발

```sh
npm install
podman run -d --rm --name pagehouse-testdb -e POSTGRES_USER=pagehouse -e POSTGRES_PASSWORD=pagehouse \
  -e POSTGRES_DB=pagehouse_test -p 55432:5432 docker.io/library/postgres:17-alpine
npm test && npm run typecheck
DATABASE_URL=postgres://pagehouse:pagehouse@localhost:55432/pagehouse_test npm run dev
```

구조:

- `server/`: API, 마이그레이션
- `web/`: React + Tiptap 에디터, 화면 문구는 `web/i18n.ts`
- `scripts/`: 설치, 업그레이드, 백업, 복원, 릴리스
- `charts/pagehouse/`: Helm 차트
- `docker/postgres/`: 보안 강화 PostgreSQL 이미지

## 라이선스

[Apache-2.0](LICENSE). 회사 내부 사용, 수정, 재배포 모두 자유롭습니다.
