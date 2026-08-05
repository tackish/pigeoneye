<p align="center">
  <img src="src/assets/svg/logo-horizontal.svg" width="360" alt="PigeonEye — Observe. Navigate. Control." />
</p>

<p align="center"><b>A bird's-eye view of your clusters. Faster than anything.</b></p>

<p align="center">
  <img src="src/assets/svg/pigeon-search.svg" width="150" alt="" />
</p>

<p align="center"><a href="README.md">English</a> | 한국어</p>

PigeonEye는 빠른 네이티브 Kubernetes GUI입니다. 클러스터가 서빙하는 모든
리소스 타입 — 모든 CRD 포함 — 이 자동으로 표시되고, `kubectl get`과
동일한 칼럼을 보여줍니다.

## 왜 빠른가

프로덕션 클러스터(**파드 23,770개 · 이벤트 171,267개**)에서 실측:

| | PigeonEye | 전체 오브젝트 LIST (informer 클라이언트가 연결 시 하는 일) |
|---|---|---|
| 파드 첫 화면 | **~0.35초 / 350 KB** | 60초+ 동안 136 MB 받고도 미완 |
| 연결 시 Discovery | **0.18초**, 단일 요청 | API 그룹마다 왕복 1회 |

테이블은 화면에 보이는 행만 렌더(가상 스크롤)하므로, 2만 4천 행 목록을
필터링해도 **키 입력당 ~0.5ms**입니다. 열린 목록은 watch로 **실시간**
갱신되고, 다시 방문하면 **캐시된 resourceVersion부터 watch를 재개**해 그
사이 변경분만 받습니다(전체 재조회 없음).

**속도의 비결:** 서버사이드 프린터 컬럼(Table API — 뷰당 요청 1회, 전체
오브젝트 동기화 없음), 스트리밍 페이징, 가상 스크롤, 지연 구축 전문 인덱스,
watch 증분 갱신(배치 병합), 재방문 시 watch 재개 캐시.

## 주요 기능

- **모든 리소스, 설정 0.** kind는 Discovery API에서 오므로 **모든 CRD가
  자동 표시**되고, `kubectl get`과 동일한 컬럼을 씁니다.
- **컬럼을 내 맘대로.** 숨김·드래그 재정렬, **아무 필드/라벨이나 커스텀
  컬럼으로 추가**(`kubectl -o custom-columns`을 타이핑 대신 클릭으로).
  자주 쓰는 kind는 **내 그룹으로 핀**.
- **제대로 찾는 검색.** 모든 필드 전문 검색 + 정규식·`!`제외, 컬럼별 값
  필터, 숫자 부등호 비교(`> 500`).
- **열린 클러스터 전체를 한 번에 검색.** `: pod api-server` 하나로 모든
  클러스터에 묻고, 각 결과가 **어느 클러스터에서 왔는지** 표시합니다.
  고르면 탭·kind·네임스페이스가 따라가고 커서가 그 행에 놓입니다. 묻기
  전까지는 비용이 0이고, 이미 둘러본 클러스터는 메모리에서 즉시 답합니다.
- **진짜 로그 뷰어.** follow, 크래시용 previous, since 윈도, 타임스탬프,
  인-뷰 검색·복사·다운로드, 워크로드 통합 로그.
- **셸·디버깅.** 파드 exec, 투명한 privileged **노드 셸**, 파드의
  securityContext를 따라가는 **ephemeral 디버그 컨테이너**(restricted
  PodSecurity / Kyverno 통과).
- **안전한 편집·운영.** YAML **서버사이드 apply**(dry-run), 템플릿 생성,
  스케일, 롤아웃 restart/history/undo, drain, CronJob trigger, Secret
  reveal, **포트포워드** 관리, **`top`** 메트릭, **`auth can-i`**.
- **물어볼 수 있는 로그인.** 토큰이 만료되면 **앱 안의 터미널에서**
  재로그인합니다(AWS SSO·gcloud·Teleport·Azure·OIDC). OTP나 비밀번호를
  묻는 CLI도 답할 곳이 생깁니다. kubeconfig의 `exec`는 명령이 하나뿐이고
  "이거 먼저" 훅이 없으므로, 컨텍스트마다 **사전 명령**을 따로 둘 수도
  있습니다 — `tsh login`, bastion 터널, VPN 같은 것들을 연결 전에
  실행하고, 공용 kubeconfig가 아니라 **내 머신에만** 저장됩니다.
- **키보드 우선**, 색으로 구분되는 멀티 클러스터 탭, 라이트/다크, 새 릴리즈를
  상단바에 알리고 **앱 안에서 바로 업데이트**(brew 불필요).

## k9s · Lens 비교

|  | PigeonEye | k9s | Lens/OpenLens |
|---|---|---|---|
| 네이티브 GUI | ✅ | 터미널 | Electron |
| 2.4만 파드 초기 로딩 | **~0.35초 첫 화면** | 빠름 | 느림(전체 동기화) |
| 모든 CRD/집계 API, 무설정 | ✅ | ✅ | ✅ |
| 정규식/제외/숫자/컬럼별 필터 | ✅ | 정규식/`!` | 기본 |
| 로그 previous·since·검색·다운로드 | ✅ | ✅ | ✅(Lens만) |
| 워크로드/Service 통합 로그 | ✅ | ✅ | 일부 |
| ephemeral **디버그** 컨테이너(정책 안전) | ✅ | — | — |
| **노드 셸**(nsenter) | ✅ | 옵션 | ✅ |
| Secret 디코드 | ✅ | ✅ | ✅ |
| 적용 전 서버 **dry-run** | ✅ | — | — |
| 템플릿 생성 | ✅ | 빈 YAML | ✅ |
| 롤아웃 history/undo | ✅ | ✅ | ✅ |
| CronJob trigger/suspend | ✅ | ✅ | — |
| 노드·파드 **메트릭 컬럼** | ✅ | ✅ | Prometheus 필요 |
| `auth can-i` / 권한 | ✅ | 역조회 | RBAC 뷰 |
| 열린 클러스터 전체 이름 검색 | ✅ | — | — |
| 인증 재로그인 — OTP 등을 묻는 CLI 포함 | ✅ | — | — |
| 컨텍스트별 사전 명령(터널 / `tsh login`) | ✅ | — | — |
| 시계열 메트릭 차트 | — | — | ✅(Prometheus) |
| Helm/확장/xray 트리/린터 | — | xray/popeye/plugins | Helm/확장 |

메트릭 그래프, Helm, owner **xray 트리**, 클러스터 린터가 아직 없는 주요
항목입니다. owner↔children 탐색은 관련 리소스 점프로 한 번에 됩니다.

## 지원 플랫폼
| 플랫폼 | 상태 |
|---|---|
| macOS (Apple Silicon / Intel) | ✅ 지원 |
| Linux (x86_64) | ✅ 지원 |
| Windows | ❌ 미지원 |

## 설치

**macOS — Homebrew**

```sh
brew tap tackish/pigeoneye
brew trust tackish/pigeoneye   # 서드파티 tap은 최초 1회 신뢰 등록 필요
brew install --cask peye
```

설치 후에는 Spotlight로 실행하거나, 터미널에서 `peye`만 치면 앱이 열립니다:

```sh
peye
```

**Linux** — [Releases](https://github.com/tackish/pigeoneye/releases)에서
`.deb` / `.rpm` / `.AppImage`를 받아 설치합니다.

**소스 빌드** (Rust stable + Node 20+):

```sh
npm install
npm run tauri build   # 설치 파일: src-tauri/target/release/bundle/
npm run tauri dev     # 바로 실행
```

## 시작하기

1. **실행하면 끝.** 기본 kubeconfig 체인(`$KUBECONFIG`, 없으면
   `~/.kube/config`)을 자동으로 읽습니다. 별도 설정이 필요 없습니다.
2. 상단의 **“+ add context”** 드롭다운으로 클러스터에 연결합니다. 각
   클러스터는 **탭**으로 열리며 원하는 만큼 여러 개를 열 수 있고, 서로 다른
   클러스터 요청은 병렬로 처리됩니다. 탭 구성과 마지막 활성 클러스터는
   재시작 시 자동 복원됩니다.
3. **kubeconfig 파일이 더 있다면** **⚙ 설정**에서 경로를 추가하세요
   (예: `~/.kube/staging-config`). 모든 파일의 컨텍스트가 병합되어
   나열되고, 각 컨텍스트는 자신의 소스 파일을 기억합니다.
4. **먼저 뭔가 해야 붙는 클러스터라면?** 로그인이나 터널이 선행돼야
   닿는 클러스터가 있는데, kubeconfig로는 표현할 수 없습니다. 컨텍스트
   목록에서 **⋯** 를 눌러 명령을 넣어두면 연결 **전에** 터미널에서
   실행되므로, 무엇을 묻든 그 자리에서 답할 수 있습니다:

   ```
   tsh status >/dev/null 2>&1 || tsh login --proxy=teleport.example.com:443
   ```

## 라이선스

[PolyForm Noncommercial 1.0.0](LICENSE) — 개인 및 비영리 목적 사용은
자유입니다. **상업적 사용은 허용되지 않습니다.**
