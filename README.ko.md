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

- **모든 리소스, 설정 0.** kind는 Discovery API에서 오므로 **모든 CRD·집계
  API가 자동 표시**되고, `kubectl get`과 동일한 컬럼을 씁니다. 하드코딩 없음.
- **제대로 찾는 검색.** 모든 필드(라벨·어노·env·이미지·IP…) 전문 검색 +
  **정규식**·**`!`제외** 토큰, **컬럼별 값 필터**, 숫자 컬럼 **부등호 비교**
  (`> 500`). 고카디널리티 컬럼은 정렬로 폴백.
- **진짜 로그 뷰어.** follow, 크래시용 **previous(이전 컨테이너)**,
  **since** 윈도, 타임스탬프, **인-뷰 검색·복사·다운로드**, 그리고 워크로드/
  Service의 **전 파드 통합 로그**.
- **정책에 맞는 셸·디버깅.** 파드 exec(컨테이너 선택), **노드 셸**(privileged
  `nsenter`, 설정에서 완전 투명), **ephemeral 디버그 컨테이너**(distroless/
  크래시 파드용) — 디버그 컨테이너가 파드의 securityContext를 따라가 restricted
  PodSecurity / Kyverno에서도 통과.
- **안전한 편집.** 인앱 YAML → **서버사이드 apply**(충돌 처리), 적용 전
  **서버 dry-run** 검증, **템플릿 생성**(`+ New`, Argo Rollout 포함).
- **운영.** 스케일, 롤아웃 **restart / history / undo**, cordon/drain,
  CronJob **trigger/suspend**, Job suspend, Secret **디코드/reveal**,
  **포트포워드** 관리, **파드·노드 메트릭**(`top`), **`auth can-i`**(내 권한).
- **키보드 우선**, 멀티 클러스터 탭, 라이트/다크, 토큰 만료 시 **원클릭
  SSO/gcloud 재로그인**.

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
| 인증 자동 로그인(AWS SSO/gcloud) | ✅ | — | — |
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
brew tap tackish/pigeoneye https://github.com/tackish/pigeoneye
brew install --cask pigeoneye
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

## 리소스 탐색

- 사이드바에는 운영 필수 리소스가 고정되어 있습니다 — **Cluster**(Node,
  Namespace, Event, CRD), **Workloads**, **Network**, **Config**,
  **Storage**, **Access Control** — 그리고 클러스터의 **모든 CRD 그룹**이
  *Custom Resources* 아래 자동 표시됩니다(`*.k8s.io` 그룹은 빌트인과 함께
  *More*에 있습니다). 나머지도 *More*에 있으며 필터
  입력창으로 전체를 검색할 수 있습니다.
- 테이블은 **서버사이드 프린터 칼럼**을 그대로 보여줍니다 — kubectl이
  출력하는 READY / STATUS / RESTARTS / IP / NODE와 CRD의
  `additionalPrinterColumns`까지. Node 뷰에는 **AZ** 칼럼이 추가됩니다.
  상태값은 색으로 구분됩니다 (`Running` 초록, `Pending` 노랑,
  `CrashLoopBackOff` 빨강). `kubectl -o wide`에서만 나오는 부가 칼럼은 기본
  적으로 숨겨지며, **columns** 버튼으로 리소스별로 직접 고를 수 있습니다
  (선택은 저장됩니다).
- **검색창은 오브젝트의 모든 필드를 대상으로 매칭됩니다** — 이름, 레이블,
  어노테이션, 이미지, nodeName, IP 등 무엇이든. 여러 단어는 AND 조건:
  `nginx 10.210`은 해당 대역의 nginx 파드를 찾습니다.
- 네임스페이스 셀렉터로 모든 네임스페이스 뷰를 좁힐 수 있습니다.
- 큰 클러스터는 스트리밍으로 불러옵니다 — 첫 페이지가 즉시 그려지고 나머지는
  백그라운드로 도착해, 파드 15,000개짜리 목록도 기다림 없이 전량 검색됩니다.
- 열려 있는 목록은 **실시간**입니다 — watch로 변경분만 받아 해당 행만 갱신
  합니다(재조회 없음). 항목 수 옆의 초록 점이 실시간 상태를 뜻합니다.

## 상세 보기 & 편집

행을 클릭하면 상세 패널이 열립니다 (패널 밖을 클릭하면 닫힘):

- 요약: 네임스페이스, age, 레이블. 어노테이션·라이브 **status**·해당
  오브젝트의 **Events**(`kubectl describe` 하단과 동일, 경고가 있으면 자동
  으로 펼쳐짐)는 접힌 섹션에 있습니다.
- **Manifest**는 *desired state*를 보여줍니다 — 서버 관리 필드(`status`,
  `uid`, `resourceVersion`, `managedFields`, last-applied)가 제거되어
  그대로 `kubectl apply` 가능한 형태입니다.
- 그 자리에서 편집(YAML 하이라이팅, 자동 들여쓰기)하고 **Apply**를 누르면
  확인 다이얼로그를 거쳐 server-side apply로 반영됩니다. 변경한 필드를 다른
  관리자(HPA의 `replicas`, 오퍼레이터 템플릿 등)가 소유하고 있으면 충돌을
  보여주고 소유권을 가져올지 직접 결정하게 합니다. 편집기를 열어둔 사이
  바뀐 내용을 모르고 덮어쓰는 일도 막습니다.

## 액션

상세 패널에는 리소스에 맞는 액션이 표시됩니다:
| 리소스 | 액션 |
|---|---|
| Node | **shell**, **cordon / uncordon**, **drain**, delete, force delete |
| Pod | **shell**, **logs**(follow), **port-forward**, delete, **force delete** (grace 0) |
| Deployment / StatefulSet | **logs**(소속 파드 통합), **scale**, **rollout restart**, delete |
| ReplicaSet / Job / Service | logs(소속 파드 통합), delete — ReplicaSet은 scale도 |
| ReplicaSet | scale, delete |
| DaemonSet | rollout restart, delete |
| 그 외 전체 | delete |

액션은 API 서버가 알려주는 verb를 따릅니다 — 삭제·편집은 그것을 허용하는
리소스에만 나타나고, Event는 항상 읽기 전용입니다. 연관 리소스는 **양방향**
으로 한 번에 이동할 수 있습니다. 정방향: 파드 → 노드·소유자·
ServiceAccount·PVC, PVC → PV, Ingress → Service, HPA → 대상 워크로드,
Event → 해당 오브젝트. 역방향: ServiceAccount·Node → 이를 쓰는 파드
(서버사이드 정확 조회), ConfigMap·Secret·PVC → 마운트한 파드,
StorageClass → PVC·PV, IngressClass → Ingress, Role → 바인딩,
CRD → 해당 커스텀 리소스 목록.

파괴적인 액션은 항상 확인을 거칩니다. drain은 kubectl 규칙을 따릅니다:
cordon 후 DaemonSet·mirror 파드를 제외한 모든 파드를 eviction하며
PodDisruptionBudget을 존중합니다.

**셸과 로그**는 하단 터미널 패널의 탭으로 열립니다 — 여러 개를 동시에
띄울 수 있습니다. 컨테이너가 둘 이상인 파드는 어느 컨테이너에 붙을지
고르는 창이 뜨고(방향키·Enter), 탭에 `파드:컨테이너`로 표시됩니다. Pod 셸은 파드에 exec로 진입합니다(bash, 없으면 sh).
**Node 셸**은 해당 노드에 임시 privileged 헬퍼 파드(기본 `busybox:1.36`,
`kube-system`)를 띄우고 `nsenter`로 호스트에 진입하며, 탭을 닫으면 헬퍼
파드는 자동 삭제됩니다. 헬퍼 **이미지·네임스페이스·리소스 limits·Pod 셸
커맨드는 ⚙ 설정에서 변경**할 수 있습니다 — 사내 전용 셸 이미지를 그대로
쓸 수 있습니다.

**포트포워드**는 Pod 상세 패널에 있습니다: 포트를 고르면(컨테이너 포트가
미리 채워짐) 로컬 리스너가 열리고 브라우저가 자동으로 뜹니다. 활성 포워드는
사이드바 최상단 **Port forwards** 섹션에 계속 표시되며, 클릭하면 브라우저를
다시 열고 ✕로 개별 중지, "stop all"로 일괄 중지할 수 있습니다.

## 키보드

키보드만으로 전부 조작할 수 있습니다:
| 키 | 동작 |
|---|---|
| `:` | 커맨드 팔레트 — `pods`, `deploy`, 모든 CRD kind, `ns <이름>`, `ctx <이름>` |
| `/` | 검색 — 목록에서는 행 검색, 상세 패널이 열려 있으면 리소스 내 찾기 |
| `↑↓` / `j` `k` | 커서 이동 — 사이드바에서는 kind, 목록에서는 행 |
| `Enter` / `→` | 사이드바에서 해당 kind 열기 |
| `←` `→` | 가로로 잘린 테이블 좌우 이동 (`Home`/`End` 첫/마지막 칼럼) |
| `Enter` | 커서 행의 상세 패널 열기 — **Namespace** 행에서는 해당 네임스페이스로 전환 후 파드 목록으로 진입 |
| `Space` | 커서 행 선택 · `⌘A` 전체 선택 · `Esc` 해제 |
| `s` | 커서 행에 셸 접속 (Pod·Node) |
| `⌘D` / `Ctrl+D` | 선택된 행들(없으면 커서 행) 삭제 — `Shift`는 강제 삭제, 둘 다 확인창 |
| `⌘R` / `Ctrl+R` | 커서 행 rollout restart |
| `c` / `Shift+D` | 커서 노드 cordon / drain |
| `l` | 로그 — Pod 로그, 워크로드(Deploy/STS/DS/RS/Job/Svc)에선 소속 파드 통합 로그 |
| `e` / `y` | 커서 행의 매니페스트(YAML) 편집기로 바로 이동 |
| `d` | 상세 열림 상태에서 삭제 |
| `Shift+A/N/S/R/T/C/M/I/O` | Age · Name · Status · Ready · Restarts · CPU · MEM · IP · Node 정렬 |
| `?` | 단축키 도움말 |
| `Esc` | 터미널에서 빠져나오기 — vim 등 ESC가 필요한 프로그램에는 `Ctrl+[`로 전달 |
| `⌘T` | 터미널로 이동 — 터미널에 있을 때 다시 누르면 도크 접기 (세션은 유지) |
| **상세 패널 안에서** | |
| `↑` `↓` / `j` `k` | 패널 섹션 간 이동(레이블·어노테이션·status·매니페스트) |
| `Enter` | 포커스된 섹션 열기 — 접기 토글, YAML 편집기 진입, 포커스된 버튼 실행 |
| `←` `→` | 액션 버튼 줄 이동 (shell · logs · scale · delete · Apply / Reset) |
| `h` | 목록으로 돌아가기 |
| `Shift+J` / `Shift+K` | 이전 / 다음 리소스로 이동(패널 유지) |
| `a` / `t` / `v` | 어노테이션 / status / 이벤트 접기·펼치기 |
| `c` / `Shift+D` | cordon·uncordon / drain (노드) |
| `r` / `n` | rollout restart / scale 입력 포커스 |
| `p` | 노드 ↔ 해당 노드의 파드, Event → 대상 오브젝트 |
| `Shift+F` / `Shift+X` | 포트포워드 입력 / 강제 삭제 |
| **앱 전역** | |
| `⌘B` / `⌘K` | 사이드바 접기 / kind 필터 포커스 |
| `⌘,` | 설정(kubeconfig, 셸) |
| `Tab` / `Shift+Tab` | 다음 / 이전 클러스터 탭 |
| `Ctrl+1-9` / `Alt+1-9` | 클러스터 탭 바로 이동 / 터미널 탭 전환 |
| `Shift+Tab` (셸 안에서) | 다음 셸 세션으로 이동 |
| `⌘W` | 앞에 있는 것 닫기 — 포커스된 셸 → 상세 패널 → 클러스터 탭 (창은 닫히지 않음) |
| `Shift+⌘W` | 현재 셸 세션 닫기 (`Ctrl+D`는 셸 자체를 종료) |
| `Esc` | 계층을 한 단계씩 올라감: 상세 → 목록 → 사이드바 → 이전 뷰 |

metrics-server가 있으면 Pod 뷰에 실시간 메트릭 칼럼(CPU,
%CPU/R, %CPU/L, MEM, %MEM/R, %MEM/L)이 표시되고, 모든 칼럼 헤더는
클릭으로 정렬됩니다.

## 로드맵

시계열 메트릭 차트 → owner **xray** 트리 뷰 → Helm 릴리스.

## 라이선스

[PolyForm Noncommercial 1.0.0](LICENSE) — 개인 및 비영리 목적 사용은
자유입니다. **상업적 사용은 허용되지 않습니다.**
