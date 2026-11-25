# SSO 연결 가이드

[English](sso.md)

Pagehouse는 OpenID Connect를 지원하는 SSO라면 어떤 것과도 연결할 수 있습니다. Keycloak, Microsoft Entra ID, Google Workspace, Okta, Authentik 등이 해당됩니다. 이 문서는 SSO 서버 쪽과 위키 쪽 설정, 그리고 자주 생기는 문제를 다룹니다.

## 동작 방식

1. 로그인 화면의 SSO 버튼을 누르면 브라우저가 SSO 서버의 로그인 화면으로 이동합니다.
2. 거기서 로그인하면 SSO 서버가 일회용 코드를 붙여 위키의 **리디렉션 URI**로 브라우저를 돌려보냅니다.
3. 위키 서버는 이 코드를 SSO 서버에 직접 보내 사용자 정보로 바꾼 다음 로그인시킵니다.
4. 계정은 **이메일로** 연결합니다. 같은 이메일 계정이 없으면 멤버 계정을 새로 만듭니다(끌 수 있음).
5. 위키에서 로그아웃하면 SSO 서버에서도 로그아웃되고 다시 위키로 돌아옵니다.

그래서 위키 서버와 사용자 브라우저 둘 다 SSO 서버에 접속할 수 있어야 합니다. 1~2단계는 브라우저가, 3단계는 위키 서버가 SSO 서버에 접속합니다.

## 준비물

- 사용자가 위키에 접속하는 주소. 예: `https://wiki.example.com`. 프록시 뒤에 있거나 서버가 보는 주소와 사용자가 쓰는 주소가 다르면 `.env`에 `PUBLIC_URL`을 넣으세요.
- 위키 관리자 계정, 그리고 SSO 서버에 애플리케이션을 등록할 권한.

## 1. SSO 서버에 위키 등록

위키의 **관리 → SSO** 화면에서 **리디렉션 URI**(`https://wiki.example.com/api/auth/oidc/callback`)를 복사합니다. 그리고 SSO 서버에 애플리케이션(클라이언트)을 만듭니다.

| 항목 | 값 |
|---|---|
| 유형 | 웹 애플리케이션, confidential(클라이언트 시크릿 사용), authorization code 방식 |
| 리디렉션 URI | 복사한 리디렉션 URI |
| 로그아웃 후 리디렉션 URI | `/`로 끝나는 위키 주소(`https://wiki.example.com/`) |
| Scope | `openid email profile` |

만든 뒤 **Issuer URL**, **Client ID**, **Client secret**을 적어 둡니다.

### Keycloak

1. 사용할 realm에서 **Clients → Create client**. Client type은 *OpenID Connect*, Client ID는 `pagehouse`처럼 정합니다.
2. **Client authentication** 켜기, **Standard flow** 켜기(나머지는 꺼도 됨).
3. **Valid redirect URIs**에 리디렉션 URI, **Valid post logout redirect URIs**에 `/`로 끝나는 위키 주소, **Web origins**에 `+`.
4. 시크릿은 **Credentials** 탭에 있습니다.
5. Issuer는 `https://<keycloak 주소>/realms/<realm>`.
6. 사용자에게 이메일이 있어야 하고 **Email verified**가 켜져 있어야 합니다.

### Microsoft Entra ID

1. **앱 등록 → 새 등록**. 리디렉션 URI 플랫폼은 *웹*, 값은 리디렉션 URI.
2. **인증서 및 비밀 → 새 클라이언트 암호**. 표시되는 *값*이 시크릿입니다.
3. **인증 → 웹 → 리디렉션 URI**에 `/`로 끝나는 위키 주소도 추가합니다. 로그아웃 뒤 위키로 돌아오려면 필요합니다.
4. Client ID는 *애플리케이션(클라이언트) ID*, Issuer는 `https://login.microsoftonline.com/<테넌트 ID>/v2.0`.
5. Entra ID는 `email_verified`를 보내지 않는 경우가 많습니다. 로그인할 때 "SSO 서버가 확인된 이메일을 주지 않았습니다"가 나오면 **확인 표시 없는 이메일도 믿기**를 켜세요. 단, 사용자가 디렉터리에서 자기 이메일을 직접 바꿀 수 없을 때만 켜야 합니다.

### Google Workspace

1. Google Cloud 콘솔 → **API 및 서비스 → 사용자 인증 정보 → OAuth 클라이언트 ID 만들기**, 유형은 *웹 애플리케이션*.
2. **승인된 리디렉션 URI**에 리디렉션 URI.
3. Issuer는 `https://accounts.google.com`.
4. 개인 Google 계정을 막으려면 OAuth 동의 화면을 *내부*로 설정합니다.

Google은 로그아웃 엔드포인트가 없어서 위키에서 로그아웃해도 Google 로그인은 유지됩니다.

### Okta

1. **Applications → Create App Integration**에서 *OIDC*, *Web Application*.
2. **Sign-in redirect URIs**에 리디렉션 URI, **Sign-out redirect URIs**에 `/`로 끝나는 위키 주소.
3. 사용할 사람이나 그룹을 할당합니다.
4. Issuer는 `https://<조직>.okta.com`. 커스텀 authorization server를 쓰면 `https://<조직>.okta.com/oauth2/default` 같은 형태입니다.

## 2. 위키에서 켜기

**관리 → SSO**에서:

1. **Issuer URL**을 넣고 **연결 확인**을 누릅니다. *연결됨*이 나와야 합니다.
2. **Client ID**와 **Client secret**을 넣습니다. 원하면 **버튼 문구**(예: *회사 계정으로 로그인*)도 정합니다.
3. 옵션을 고릅니다.
   - **처음 로그인할 때 계정 만들기**: 끄면 같은 이메일 계정이 이미 있는 사람만 들어올 수 있습니다.
   - **비밀번호 로그인 허용**: 끄면 관리자를 뺀 모두가 SSO로만 로그인합니다. 관리자는 SSO 서버가 멈췄을 때를 대비해 비밀번호 로그인이 남습니다.
   - **확인 표시 없는 이메일도 믿기**: `email_verified`를 보내지 않는 SSO 서버에서만 켭니다.
4. **SSO 켜기**를 누릅니다. 재시작 없이 바로 적용됩니다.

그다음 로그아웃하고 로그인 화면의 버튼으로 시험해 보세요. 시크릿 창에서 해 보면 편합니다.

Client secret은 서버에만 저장됩니다. 화면에 다시 보여 주지 않고, 칸을 비워 두고 저장하면 기존 값이 유지됩니다. 설정을 바꾸면 감사 로그에 남는데, 시크릿은 기록하지 않습니다.

### 비밀번호와 SSO 계정

위키의 **비밀번호 재설정 링크**와 **임시 비밀번호**는 위키 안의 비밀번호만 바꿉니다. SSO 서버의 비밀번호는 건드리지 않으니, 그쪽 비밀번호는 SSO 서버에서 바꿔야 합니다. SSO로 만들어진 계정에 쓰면 위키 비밀번호가 하나 생깁니다. *비밀번호 로그인 허용*이 켜져 있으면 그 사람은 두 방법 중 아무거나로 로그인할 수 있고, 꺼져 있으면 관리자만 그 비밀번호를 쓸 수 있습니다.

### `.env`로 설정하기

자동 설치라면 환경 변수로도 같은 설정을 할 수 있습니다(`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_LABEL`, `OIDC_AUTO_CREATE`, `PASSWORD_LOGIN`, `OIDC_TRUST_EMAIL`, [설치 안내](install.ko.md) 참고). 환경 변수가 있으면 그쪽이 우선하고 화면은 읽기 전용이 됩니다. 값을 바꾼 뒤에는 재시작해야 합니다.

## 문제 해결

실패한 로그인은 **관리 → 감사 로그**에 *SSO 로그인*으로, 실패 이유와 함께 남습니다.

| 증상 | 원인과 해결 |
|---|---|
| SSO 서버가 리디렉션 URI가 잘못됐다고 함 | SSO 서버에 등록한 주소가 SSO 화면의 리디렉션 URI와 글자 하나까지 같지 않습니다(http/https, 호스트, 포트). 화면에 나온 주소부터 틀렸다면 `PUBLIC_URL`을 설정하세요. |
| "SSO 서버가 확인된 이메일을 주지 않았습니다" | SSO 서버에 그 사용자의 이메일이 없거나 확인(verified) 표시가 없습니다. SSO 서버에서 확인 처리하거나, 꼭 필요할 때만 *확인 표시 없는 이메일도 믿기*를 켭니다. |
| "아직 계정이 없습니다" | *처음 로그인할 때 계정 만들기*가 꺼져 있습니다. 먼저 초대하세요. |
| SSO 화면을 지나자마자 "SSO 로그인에 실패했습니다" | 위키 서버가 SSO 서버의 토큰 주소에 접속하지 못하거나 시크릿이 틀렸습니다. 위키 서버에서 `curl <issuer>/.well-known/openid-configuration`으로 확인하세요. |
| 연결 확인은 되는데 로그인이 실패함 (위키는 컨테이너, SSO 서버는 같은 PC) | 컨테이너 안의 `localhost`는 컨테이너 자신입니다. 컨테이너와 브라우저 모두 접속할 수 있는 주소를 쓰세요. 로컬 Keycloak이라면 `--hostname=<브라우저용 주소> --hostname-backchannel-dynamic=true`로 띄우고, Issuer에는 `http://host.containers.internal:8080/realms/<realm>`(Podman) 또는 `host.docker.internal`(Docker)을 넣습니다. |
| 로그아웃해도 SSO 서버 로그인이 남음 | SSO 서버에 위키 주소가 로그아웃 후 리디렉션 주소로 등록돼 있지 않거나, 이 기능이 생기기 전에 로그인한 세션입니다(한 번 다시 로그인하면 됨). |
| 비밀번호 로그인을 끈 뒤 못 들어감 | 관리자는 항상 비밀번호로 로그인할 수 있습니다. 그래도 안 되면 설정을 지웁니다: `podman compose exec db psql -U pagehouse -c "DELETE FROM settings WHERE key='sso'"` |
