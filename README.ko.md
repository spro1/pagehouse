<div align="center">

<img src="docs/images/logo.svg" width="72" height="72" alt="Pagehouse 로고">

# Pagehouse

**작은 회사와 팀을 위한 설치형 팀 위키.**<br>
주간보고, 회의록, 기술 문서를 하나의 페이지 트리로, 우리 서버에서.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/spro1/pagehouse/actions/workflows/ci.yml/badge.svg)](https://github.com/spro1/pagehouse/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/spro1/pagehouse?include_prereleases&sort=semver)](https://github.com/spro1/pagehouse/releases)
![Docker | Podman | Kubernetes](https://img.shields.io/badge/runs%20on-Docker%20%7C%20Podman%20%7C%20Kubernetes-2f6feb)

[설치](#설치) · [기능](#기능) · [문서](#문서) · [기여하기](CONTRIBUTING.md) · [English](README.md)

<img src="docs/images/screenshot-light.png" alt="체크리스트, 배포 표, 코드 블록, 패널이 있는 Pagehouse 페이지" width="100%">

</div>

## 왜 Pagehouse인가

- **직접 운영합니다.** 어떤 Linux 서버에서든 `curl | sh` 한 줄, 폐쇄망용 오프라인 번들, 또는 Helm 차트. 컨테이너 둘과 백업 작업뿐이고, 외부 서비스나 원격 수집이 없습니다.
- **데이터를 잃기 어렵습니다.** 삭제는 스스로 비워지지 않는 휴지통으로 가고, 큰 삭제 전의 내용은 이력에 남으며, 연결이 끊겨도 저장 못 한 수정이 보관되고, 서버는 매일 스스로 백업합니다.
- **쓰던 위키를 가져옵니다.** Confluence HTML 내보내기, Notion 내보내기, Markdown, HTML을 페이지 계층과 첨부까지 옮깁니다.
- **작습니다.** TypeScript 약 5,000줄. 3,000쪽 스페이스의 페이지 트리를 6ms에 엽니다.

## 기능

| | |
|---|---|
| ✍️ **에디터** | `/` 블록 메뉴, Markdown 단축 입력, 셀 병합·분할되는 표, 25개 언어 코드 강조, 정보·주의 패널, 할 일, 붙여넣기·끌어 놓기로 이미지와 파일 첨부 |
| 🗂️ **정리** | 스페이스, 끌어서 옮기는 하위 페이지, 템플릿(주간보고, 회의록, 기술 문서), 실행 취소되는 휴지통 |
| 🔎 **검색** | ⌘K 빠른 검색과 전체 검색 페이지: 모든 단어 일치, 스페이스·작성자·기간 필터, 위치와 강조 표시 |
| 🔒 **접근 관리** | 초대 링크, 관리자·멤버 역할, 하위 페이지로 상속되는 페이지별 *보기*/*편집* 제한(트리, 검색, 파일, 이력 모두 적용) |
| 💬 **협업** | 답글과 해결 처리가 되는 댓글, 되돌릴 수 있는 버전 이력, 동시 수정 덮어쓰기 방지 |
| 📦 **가져오기·내보내기** | Confluence, Notion, Markdown, HTML 가져오기, Markdown+첨부 ZIP 내보내기(그대로 다시 가져오기 가능) |
| 📊 **관리** | 설정한 한도 대비 저장 공간, 디스크 여유, 백업 상태, 활동, 큰 파일 |
| 🌐 **언어** | 영어와 한국어, 계정별 설정 |

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

## 설치

Docker 24 이상 또는 Podman 4 이상이 필요합니다.

```sh
curl -fsSL https://github.com/spro1/pagehouse/releases/latest/download/install.sh | sh
```

베타 기간에는 버전을 지정해 설치합니다: `curl -fsSL https://github.com/spro1/pagehouse/releases/download/v0.1.0-beta.1/install.sh | sh -s -- --version 0.1.0-beta.1`

`http://<서버>:3000`에 접속해 첫 계정을 만들면 관리자가 됩니다. 나머지 사람은 **관리 → 사용자**에서 초대하세요.

| 그 밖의 방법 | |
|---|---|
| **오프라인(폐쇄망)** | 이미지가 들어 있는 `pagehouse-<버전>-offline-{amd64,arm64}.tar.gz`를 풀고 `install.sh` 실행 |
| **쿠버네티스** | `helm install wiki pagehouse-<버전>.tgz` (PostgreSQL, 백업, Ingress 포함) |
| **업그레이드** | `scripts/upgrade.sh`: 먼저 백업하고, 데이터와 설정은 그대로 둡니다 |

HTTPS, 백업, 외부 PostgreSQL, 문제 해결은 [설치 가이드](docs/install.ko.md)를 보세요.

## 구조

```
 브라우저 ──HTTP──▶ app (Node 24, Hono)  ──▶ PostgreSQL 17 (페이지, 이력, 계정, 검색)
                     │                    ╰─▶ /data 볼륨 (첨부, 같은 내용은 한 번만 저장)
                     ╰── React + Tiptap 에디터 제공
 백업 작업 ── 24시간마다 ──▶ ./backups/pagehouse-auto-*.tar.gz  (DB + 첨부, 14개 보관)
```

페이지는 ProseMirror JSON으로 저장해 형식을 바꿔도 내용이 빠지지 않습니다. 검색은 PostgreSQL trigram 색인을 써서 별도 검색 서버 없이 한국어도 찾습니다.

## 보안

- 컨테이너 이미지에는 패키지 관리자와 쓰지 않는 TLS 라이브러리가 없고, 고칠 수 있는 CVE가 하나라도 있으면 CI가 실패합니다([Trivy](https://trivy.dev)).
- 릴리스 시점에 `npm audit`, OSV, Grype 모두 의존성에서 알려진 취약점을 찾지 못했습니다.
- 엄격한 Content-Security-Policy, 다른 사이트에서 오는 쓰기 요청 차단, 로그인 시도 제한, 업로드 파일은 격리(sandbox)해 다운로드로만 제공.
- 앱과 DB는 root가 아닌 사용자로 실행됩니다.

취약점을 발견하셨다면 공개하지 말고 [SECURITY.md](SECURITY.md)의 방법으로 알려 주세요.

## 문서

- [설치 가이드](docs/install.ko.md): 필요 사항, HTTPS, 백업, 업그레이드, 쿠버네티스, 문제 해결
- [사용 가이드](docs/user-guide.ko.md): 에디터, 검색, 접근 권한, 가져오기·내보내기, 관리자 작업
- [릴리스](docs/releasing.md): 관리자(메인테이너)용

## 개발

```sh
npm install
podman run -d --rm --name pagehouse-testdb -e POSTGRES_USER=pagehouse -e POSTGRES_PASSWORD=pagehouse \
  -e POSTGRES_DB=pagehouse_test -p 55432:5432 docker.io/library/postgres:17-alpine
npm test            # 서버·번역 테스트 (*_test DB를 비웁니다)
npm run typecheck
DATABASE_URL=postgres://pagehouse:pagehouse@localhost:55432/pagehouse_test npm run dev
```

| 경로 | |
|---|---|
| `server/` | HTTP API (Hono), 마이그레이션, 내보내기, 관리 통계 |
| `web/` | React 앱과 Tiptap 에디터, 화면 문구는 `web/i18n.ts` |
| `scripts/` | 설치, 업그레이드, 백업, 복원, 릴리스 패키징 |
| `charts/pagehouse/` | Helm 차트 |
| `docker/postgres/` | 보안 강화한 PostgreSQL 이미지 |

기여를 환영합니다. 먼저 [CONTRIBUTING.md](CONTRIBUTING.md)를 읽어 주세요.

## 라이선스

[Apache-2.0](LICENSE)
