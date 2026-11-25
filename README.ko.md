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

- 유료 위키(SaaS) 비용이 부담되거나 계약 갱신 때마다 사용자 수를 세야 하는 5~200명 규모의 회사와 팀
- 보안 규정, 고객사 요구, 폐쇄망 환경 때문에 문서를 회사 밖 서버에 저장하면 안 되는 조직
- 전담 운영 인력 없이 서버 한 대에 올려 두고 신경을 덜 쓰고 싶은 팀

## 도입 판단

| | Pagehouse |
|---|---|
| **데이터 위치** | 전부 우리 서버 안(PostgreSQL과 파일 볼륨). 외부 글꼴·CDN·원격 수집이 없고, 외부 요청은 직접 켠 SSO·메일과 링크 카드 미리보기뿐입니다(`LINK_PREVIEW=0`으로 끔) |
| **인터넷 없는 환경** | 이미지가 든 오프라인 번들로 설치·업그레이드 가능 |
| **비용** | Apache-2.0 오픈소스, 사용자 수 제한 없음 |
| **필요한 것** | Linux 서버 한 대와 Docker 또는 Podman. 쿠버네티스를 쓴다면 Helm 차트 |
| **구성 요소** | 앱, PostgreSQL, 백업 작업. 컨테이너 세 개뿐이고 외부 서비스 의존 없음 |
| **데이터 보호** | 삭제는 휴지통(자동으로 비워지지 않음), 버전 이력, 매일 자동 백업, 업그레이드·복원 전 자동 백업 |
| **나갈 때** | 스페이스 전체를 Markdown 또는 HTML(브라우저로 바로 열람) ZIP으로 내보내기. 데이터가 특정 형식에 묶이지 않습니다 |
| **로그인** | 초대 링크로 만드는 자체 계정, 또는 OpenID Connect SSO(Keycloak, Entra ID, Google Workspace, Okta 등). 비밀번호 분실 시 메일 재설정 링크나 관리자 임시 비밀번호 |

## 주요 기능

| | |
|---|---|
| ✍️ **에디터** | 상단 서식 툴바와 `/` 블록 메뉴, Markdown 단축 입력, 셀 병합·분할되는 표, 25개 언어 코드 강조(복사 버튼), Mermaid 다이어그램, 정보·주의 패널, 할 일, 링크 카드, 붙여넣기·끌어 놓기로 이미지·파일 첨부, `@` 멘션, 제목 이모지 |
| 🏠 **홈과 알림** | 로그인하면 최근 본 페이지, 새로 만든 페이지, 나를 언급한 문서와 댓글이 모인 홈. 페이지 지켜보기, 읽지 않은 알림 메일 발송(SMTP) |
| 🗂️ **정리** | 스페이스, 끌어서 옮기는 하위 페이지(트리의 `⋯`·`+` 메뉴), 하위 페이지까지 복사, 라벨, 즐겨찾기·최근 본 페이지, 기본 템플릿과 우리 팀 템플릿, 실행 취소되는 휴지통 |
| 🔎 **검색** | ⌘K 빠른 검색과 전체 검색 페이지. 모든 단어 일치(한국어 조사 처리), 댓글·첨부 파일명까지 검색, 스페이스·작성자·기간 필터 |
| 🔒 **권한** | 스페이스별 공개 범위(모두 편집·모두 보기·비공개)와 사람·그룹 단위 역할, 페이지별 보기·편집 제한. 권한 밖의 문서는 검색·첨부·이력 어디에도 나오지 않음 |
| 💬 **협업** | 상대 커서가 보이는 실시간 공동 편집, 본문 일부에 다는 인라인 댓글, 답글·해결 처리되는 댓글, 변경 비교와 복원이 되는 버전 이력 |
| 🛡️ **감사 로그** | 로그인(실패 포함), 계정·그룹·권한 변경, 삭제, 내보내기 기록을 관리자가 확인 |
| 👤 **계정** | 이름·프로필 사진 변경, 메일로 비밀번호 재설정(SMTP 설정 시), 관리자가 발급하는 임시 비밀번호(첫 로그인 때 변경) |
| 🤖 **AI 에이전트** | 내장 MCP 서버. 개인 API 토큰으로 에이전트가 내 권한 그대로 페이지를 검색·읽기·작성 |
| 📦 **이관** | Confluence CSV·HTML 내보내기(페이지 트리와 순서, 폴더, 첨부, 라벨, 코드·패널·Jira·drawio 등 매크로), Notion, Markdown, HTML 가져오기. Markdown·HTML ZIP과 페이지 PDF 내보내기 |
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

| | CPU | 메모리 | 디스크 |
|---|---|---|---|
| **최소** (체험, ~20명) | 1 vCPU | 1GB | 5GB + 첨부 × 15 |
| **권장** (~50명) | 2 vCPU | 2GB | 20GB SSD + 첨부 × 15 |
| **권장** (~200명) | 2~4 vCPU | 4GB | 50GB SSD + 첨부 × 15 |
| **더 큰 조직** | 쿠버네티스에서 앱 여러 대 | 앱당 1~2GB | 외부 PostgreSQL + 공유 스토리지 |

- 백업은 매번 전체 사본이고 기본 14개를 보관하므로 `(DB + 첨부) × 15` 정도의 여유를 잡아 두세요.
- 위 수치는 참고 기준입니다. 대기 상태에서 앱과 DB는 각각 메모리 약 50MB를 쓰고, 3,000쪽 기준으로 페이지 트리는 6ms, 검색은 3ms에 응답했습니다. 자세한 내용은 [설치 가이드](docs/install.ko.md#필요-사항)에 있습니다.

## 설치

Docker 24 이상 또는 Podman 4 이상이 있으면 됩니다. 환경에 맞는 방법을 고르세요.

### A. 인터넷이 되는 서버 한 대

```sh
curl -fsSL https://github.com/spro1/pagehouse/releases/latest/download/install.sh | sh -s -- --dir /opt/pagehouse
```

베타 기간에는 버전을 지정합니다.

```sh
curl -fsSL https://github.com/spro1/pagehouse/releases/download/v0.2.0-beta.3/install.sh | sh -s -- --dir /opt/pagehouse --version 0.2.0-beta.3
```

설치 스크립트는 무작위 DB 비밀번호가 든 `.env`를 권한 600으로 만들고 이미지를 받아 서비스를 띄운 뒤 정상 상태가 될 때까지 기다립니다.

### B. 폐쇄망 (인터넷 없음)

인터넷이 되는 PC에서 릴리스 페이지의 `pagehouse-<버전>-offline-amd64.tar.gz`(ARM 서버는 `-arm64`)와 `SHA256SUMS`를 받아 서버로 옮긴 뒤 다음을 실행합니다.

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

1. **관리자 계정**: `http://<서버>:3000`에 접속해 첫 계정을 만듭니다. 이 계정이 관리자가 되고 그 뒤 가입이 닫힙니다.
2. **HTTPS**: 사내 리버스 프록시(nginx, Caddy 등) 뒤에 두고 `.env`에서 `BIND_ADDRESS=127.0.0.1`, `TRUST_PROXY=1`로 설정합니다. [설정 예시](docs/install.ko.md#https)
   - HTTP로 IP 주소에 바로 접속해도 쓸 수는 있지만 로그인 쿠키를 보호하려면 HTTPS를 권장합니다.
3. **팀원 초대**: **관리 → 사용자**에서 초대 링크를 만들어 메신저로 전달합니다. 메일 서버는 필요 없습니다.
4. **스페이스**: 팀별로 만들고 인사·경영처럼 민감한 곳은 **비공개**로 둡니다.
5. **백업 확인**: **관리 → 개요**에 "마지막 자동 백업"이 보이는지 확인하고 `/opt/pagehouse/backups`를 NAS 등 서버 밖으로 복사하도록 설정합니다.
6. **저장 한도**(선택): **관리 → 개요**에서 정합니다. 한도에 닿아도 글은 계속 저장되고 새 파일 업로드만 막힙니다.
7. **메일**(선택): `.env`에 `SMTP_URL`을 넣으면 알림 메일과 "비밀번호를 잊으셨나요?" 재설정 메일이 동작합니다. 없으면 관리자가 **관리 → 사용자**에서 재설정 링크나 임시 비밀번호를 발급합니다.
8. **기존 문서 이관**: 아래 [기존 위키에서 옮기기](#기존-위키에서-옮기기)를 참고합니다.

## 운영

| 작업 | 방법 |
|---|---|
| 백업 | 자동: 24시간마다 `backups/pagehouse-auto-*.tar.gz`(14개 보관). 수동: `scripts/backup.sh` |
| 복원 | `scripts/restore.sh <백업 파일>`. 현재 상태를 먼저 백업하고 되돌리는 명령을 알려 줍니다 |
| 업그레이드 | [버전별 확인 사항](docs/upgrading.ko.md)을 먼저 보고 `scripts/upgrade.sh [버전]`. 먼저 백업하고 `.env`와 데이터는 그대로 둡니다. 폐쇄망은 새 번들의 `install.sh --dir`로 합니다 |
| 상태 확인 | `curl localhost:3000/healthz`(버전 포함), 관리 화면의 저장 공간·백업·활동·감사 로그 |
| 여러 대로 늘리기 | 쿠버네티스에서 `replicaCount`를 올리고 첨부 볼륨을 ReadWriteMany로. 실시간 공동 편집은 PostgreSQL을 거쳐 인스턴스 사이에서도 동작합니다 |
| 로그 | `docker compose logs app` |

데이터는 compose 볼륨 `db`(페이지·이력·계정)와 `files`(첨부), 설치 폴더의 `backups/`에 있습니다. 외부 PostgreSQL을 쓰는 방법은 [설치 가이드](docs/install.ko.md#외부-postgresql-사용-compose)를 보세요.

## 기존 위키에서 옮기기

**홈 → 가져오기**(또는 스페이스 메뉴 → 페이지 가져오기)에 파일이나 ZIP을 넣거나, 압축을 푼 폴더를 고르면 됩니다.

| 원본 | 내보내는 방법 | 옮겨지는 것 |
|---|---|---|
| **Confluence (권장)** | 스페이스 설정 → 내보내기 → **CSV** | Confluence 원본 페이지 소스에서: 페이지·폴더 계층과 순서, 첨부(원래 파일명), 라벨, 페이지 간 링크, 코드·정보 패널·펼치기·Jira·drawio·할 일 등 매크로 |
| **Confluence** | 스페이스 설정 → 내보내기 → HTML | 페이지 계층, 첨부·이미지, 주요 매크로 |
| **Confluence 페이지 하나** | 페이지 → 내보내기 → Markdown | 본문(동적 매크로는 링크로만 남음) |
| **Notion** | 설정 → 내보내기 → Markdown & CSV | 하위 페이지 계층, 이미지, 페이지 간 링크 |
| **Markdown·HTML 폴더** | 폴더째 ZIP으로 | 폴더를 상위 페이지로, 링크된 이미지·파일 |
| **Pagehouse** | 스페이스 메뉴 → 내보내기 | 전부 그대로(계층, 첨부, 링크) |

가져오기는 항상 새 페이지로 추가하고 기존 페이지는 건드리지 않습니다. 결과가 마음에 들지 않으면 휴지통으로 옮기고 다시 하면 됩니다.

- 끝나면 **확인할 항목**이 원인별로 정리되어 나옵니다. 예를 들어 50MB를 넘어 올리지 못한 첨부, 다른 스페이스로 가는 링크가 여기에 표시되고 항목마다 할 일이 적혀 있습니다.
- Confluence의 작성자·날짜·댓글·권한·수정 이력은 옮겨지지 않습니다. CSV에는 사용자 이름이 없어서 @멘션은 "@사용자"로 표시됩니다.
- 수백 MB가 넘는 내보내기는 압축을 풀어 **폴더 선택**으로 고르면 브라우저 메모리를 덜 씁니다.

## 보안

- **직접 켜지 않으면 데이터가 망 밖으로 나가지 않습니다.** 원격 수집과 외부 자원 로딩이 없습니다. 외부 요청은 설정한 SSO·메일과 링크 카드 미리보기뿐이고 미리보기는 허용 목록에 없는 사설 주소에는 접근하지 않습니다(`LINK_PREVIEW=0`으로 끔).
- **권한은 서버에서 검사합니다.** 권한 밖의 페이지는 화면에서만 숨기는 것이 아니라 API, 검색, 첨부, 이력, 내보내기 모든 경로에서 404로 응답합니다.
- **브라우저 방어:**
  - 엄격한 Content-Security-Policy를 씁니다.
  - 다른 사이트에서 오는 쓰기 요청을 차단합니다.
  - 로그인 시도를 주소별·계정별로 제한합니다. 프록시 뒤라면 `TRUST_PROXY`를 설정해야 실제 접속 주소로 셉니다.
  - 업로드 파일은 격리(sandbox)해 다운로드로만 제공합니다.
- **계정:**
  - SSO는 제공자가 확인한(verified) 이메일만 기존 계정과 연결합니다.
  - 비밀번호 재설정 메일은 계정이 있든 없든 같은 응답을 줍니다.
  - 관리자가 아니면 페이지를 옮겨서 물려받은 열람 제한을 풀 수 없습니다.
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
사용자 수 제한은 없습니다. 서버 한 대 구성으로 수백 명 규모를 목표로 합니다. 더 크게 쓰려면 쿠버네티스에서 앱을 여러 대로 늘릴 수 있습니다.

**회사 계정(SSO)으로 로그인할 수 있나요?**
네. OpenID Connect를 지원하는 SSO라면 됩니다. **관리 → SSO**에서 Issuer URL과 Client ID·Secret을 넣고 켜면 됩니다(`.env`의 `OIDC_*`로도 설정 가능, [설치 안내](docs/install.ko.md)). 계정은 이메일로 연결됩니다.

**비밀번호를 잊어버렸어요.**
메일(SMTP)을 설정했다면 로그인 화면의 "비밀번호를 잊으셨나요?"에서 재설정 링크를 받습니다. 아니면 관리자가 **관리 → 사용자**에서 재설정 링크나 임시 비밀번호를 만들어 줍니다. 임시 비밀번호로 들어가면 바로 새 비밀번호를 정해야 합니다.

**관리자는 비공개 문서도 볼 수 있나요?**
사이트 관리자는 잠긴 문서를 풀어 줄 수 있도록 모든 스페이스와 페이지에 접근할 수 있습니다. 관리자 계정은 꼭 필요한 사람에게만 주세요.

**서버가 죽으면 데이터는요?**
매일 자동 백업이 서버의 `backups/` 폴더에 쌓입니다. 이 폴더를 서버 밖으로 복사해 두면 새 서버에 설치한 뒤 `scripts/restore.sh`로 복원할 수 있습니다.

**나중에 다른 도구로 옮길 수 있나요?**
스페이스 전체를 표준 Markdown과 첨부 파일로, 또는 브라우저로 바로 여는 HTML로 내보낼 수 있습니다. 스페이스 메뉴 → 스페이스 내보내기에서 형식을 고릅니다.

## 로드맵

- LDAP / SAML 로그인
- 메신저(Slack, Teams, Mattermost) 웹훅 알림
- Confluence 서버에서 API로 바로 가져오기, @멘션 사용자 매핑
- 첨부 파일(PDF, Office) 본문 검색

## 문서

- [설치 가이드](docs/install.ko.md): 설치 방법, HTTPS, 백업·복원, 업그레이드, 쿠버네티스, 문제 해결
- [업그레이드 가이드](docs/upgrading.ko.md): 버전별 DB 변경, 새 설정, 동작 변경, 되돌리는 방법
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
