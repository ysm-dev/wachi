# 알림 URL 자동 아카이빙 (구현 플랜)

## 1. 목표

wachi가 apprise 채널(Discord, Slack, Telegram 등)로 알림을 성공적으로 전송할
때마다, **알림에 포함된 링크**를 Internet Archive의 Wayback Machine에 자동
제출하여 영구 보관한다.

이 기능은 다음 조건을 충족해야 한다:

- **기본값 ON** — 일반적인 사용 시 별도 설정 불필요
- **환경변수로 토글 가능** — `WACHI_NO_ARCHIVE=1` 로 완전 비활성화
- **성능 영향 없음** — 기존 `wachi check` 흐름을 절대 블로킹/지연시키지 않음
- **Stateless** — 신규 DB 테이블 또는 마이그레이션 없음
- **장애 격리** — 아카이브 실패가 알림 성공이나 exit code에 절대 영향을
  주지 않음

## 2. 설계 원칙

1. **알림 경로는 신성하다.** `sendNotification()` 이 반환되는 순간 알림은
   성공으로 간주된다. 아카이브 제출은 그 *이후*에 별도 트랙에서 일어난다.
2. **Fire-and-forget 제출.** SPN2의 POST 엔드포인트는 1~3초 안에 `job_id`
   를 반환하고 실제 캡처는 archive.org 서버 측에서 비동기로 진행된다.
   wachi는 제출만 하고 잊는다 — `/save/status/<job_id>` 폴링은 **하지 않는다**.
3. **Stateless 중복 방지.** 로컬 `archives` 테이블 대신 SPN2의
   `if_not_archived_within=<window>` 파라미터에 의존한다. 최근 캡처가
   이미 있으면 Wayback이 기존 스냅샷을 반환하므로 리소스 낭비가 없다.
4. **제한된 동시성, 제한된 수명.** 작은 인메모리 풀로 진행 중인 제출을
   추적해 프로세스 종료 전 짧게 대기할 수 있게 하되, 다음 알림을 절대
   블로킹하지 않는다.
5. **기본은 조용히, verbose 모드에서만 관찰.** 기존
   `[verbose]` / `printStderr` 컨벤션 사용. `console.*` 절대 금지.

## 3. 환경변수 설정

`src/utils/env.ts` 에 환경변수 3개 추가:

| 변수 | 타입 | 기본값 | 용도 |
|---|---|---|---|
| `WACHI_NO_ARCHIVE` | `"1"` 이면 비활성화 | unset (= 활성화) | 마스터 킬 스위치 |
| `WACHI_ARCHIVE_ACCESS_KEY` | string | unset | Internet Archive S3 access key |
| `WACHI_ARCHIVE_SECRET_KEY` | string | unset | Internet Archive S3 secret key |

### 동작 매트릭스

| `NO_ARCHIVE` | 키 존재? | 결과 |
|---|---|---|
| unset | 둘 다 있음 | **인증 POST** (동시 12개, 일 100k) |
| unset | 일부 또는 없음 | **익명 GET fallback** (동시 6개, 일 4k) + 1회성 stderr 힌트 |
| `=1` | 무관 | **비활성화**, HTTP 호출 없음 |

> 근거: 키는 더 높은 quota 와 POST 전용 옵션을 위해 *권장*되지만, 키 없이도
> zero-config 로 동작해 사용자가 즉시 가치를 얻을 수 있다. 사용자가 향후
> 키를 발급할 예정이라고 명시함.

### 명명 일관성

기존 `WACHI_NO_AUTO_UPDATE` 패턴을 따름:
- `WACHI_*` 대문자 prefix
- 비활성화는 negative flag (`NO_*`)
- 문자열 `"1"` 리터럴 비교 (`=== "1"`)

### `src/utils/env.ts` 수정안

```ts
export const getEnv = () => {
  return {
    appriseUrlOverride: readEnv("WACHI_APPRISE_URL"),
    configPath: readEnv("WACHI_CONFIG_PATH"),
    dbPath: readEnv("WACHI_DB_PATH"),
    pathsRoot: readEnv("WACHI_PATHS_ROOT"),
    wrapperPath: readEnv("WACHI_WRAPPER_PATH"),
    noAutoUpdate: readEnv("WACHI_NO_AUTO_UPDATE") === "1",
    // 신규
    noArchive: readEnv("WACHI_NO_ARCHIVE") === "1",
    archiveAccessKey: readEnv("WACHI_ARCHIVE_ACCESS_KEY"),
    archiveSecretKey: readEnv("WACHI_ARCHIVE_SECRET_KEY"),
  };
};
```

## 4. 아키텍처

### 신규 모듈: `src/lib/archive/`

```
src/lib/archive/
├── client.ts        # Wayback SPN2 HTTP 클라이언트 (POST / GET fallback)
├── submit.ts        # 공개 진입점: submitArchive(link, options)
├── pool.ts          # 진행 중 제출 추적 + flush()
└── url-policy.ts    # URL을 아카이브해야 하는지 판단
```

#### `url-policy.ts` — `shouldArchive(url): boolean`

아카이브할 의미가 없는 URL 은 스킵:

- non-`http(s)` 스킴 (`mailto:`, `magnet:`, `ftp:` 등)
- 로컬/사설 IP, `.local` 호스트
- 이미 아카이브된 URL (`web.archive.org/*`, `archive.ph/*`, `archive.today/*`)

그 외에는 `true`. 순수 함수라 단위 테스트가 쉽다.

#### `client.ts` — Wayback SPN2 래퍼

함수 2개:

```ts
// 인증 경로 — 우선 사용
export const submitWaybackPost = async (
  url: string,
  opts: { accessKey: string; secretKey: string; signal?: AbortSignal },
): Promise<{ jobId: string }> => {
  const res = await http("https://web.archive.org/save", {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `LOW ${opts.accessKey}:${opts.secretKey}`,
    },
    body: new URLSearchParams({
      url,
      // SPN2 속도/비용 최적화 옵션 (Wayback SPN2 문서 참조):
      skip_first_archive: "1",        // "최초 캡처인지" 체크 생략
      if_not_archived_within: "30d",  // 서버측 dedup, 기존 스냅샷 반환
      delay_wb_availability: "1",     // 12h 지연 인덱싱 → IA 서버 부하 감소
    }),
    timeout: 10_000,
    retry: 0, // 재시도 정책은 자체 관리 (설계상 재시도 없음)
    signal: opts.signal,
  });
  return { jobId: res.job_id };
};

// 익명 fallback — 키 미설정 시
export const submitWaybackGet = async (
  url: string,
  opts: { signal?: AbortSignal },
): Promise<void> => {
  // GET 엔드포인트만 호출. 응답은 스냅샷 URL로의 redirect.
  // body는 버림. 익명 모드는 job_id 를 반환하지 않음.
  await http(`https://web.archive.org/save/${url}`, {
    method: "GET",
    redirect: "manual",
    timeout: 10_000,
    retry: 0,
    signal: opts.signal,
  });
};
```

기존 `src/lib/http/client.ts` 의 `http` 클라이언트 재사용
(`User-Agent: wachi/<VERSION>` 이미 설정됨).

#### `pool.ts` — 백그라운드 추적 (제한된 동시성)

```ts
const MAX_CONCURRENT = 6;        // 익명 SPN2 동시 한도와 일치
const FLUSH_TIMEOUT_MS = 15_000; // 프로세스 종료 전 grace period

const inflight = new Set<Promise<void>>();
let acquired = 0;

export const trackArchive = (task: () => Promise<void>): void => {
  if (acquired >= MAX_CONCURRENT) {
    // 포화 시 제출 드롭. Wayback은 어차피 분당 15회 rate-limit 이 있고
    // 알림 경로를 절대 블로킹해서는 안 되므로.
    return;
  }
  acquired += 1;
  const p = task().finally(() => {
    acquired -= 1;
    inflight.delete(p);
  });
  inflight.add(p);
};

export const flushArchivePool = async (
  timeoutMs = FLUSH_TIMEOUT_MS,
): Promise<void> => {
  if (inflight.size === 0) return;
  const all = Promise.allSettled(inflight);
  const timer = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([all, timer]);
};

export const resetArchivePoolForTest = (): void => {
  inflight.clear();
  acquired = 0;
};
```

#### `submit.ts` — 공개 진입점

```ts
import { getEnv } from "../../utils/env.ts";
import { printStderr } from "../cli/io.ts";
import { submitWaybackGet, submitWaybackPost } from "./client.ts";
import { trackArchive } from "./pool.ts";
import { shouldArchive } from "./url-policy.ts";

let hintShown = false;

export const submitArchive = (
  link: string,
  opts: { isVerbose?: boolean } = {},
): void => {
  const env = getEnv();
  if (env.noArchive) return;
  if (!shouldArchive(link)) return;

  const hasKeys = Boolean(env.archiveAccessKey && env.archiveSecretKey);

  if (!hasKeys && !hintShown) {
    hintShown = true;
    printStderr(
      "[verbose] archive: 익명 Wayback API 사용 중 (더 높은 한도를 원하면 WACHI_ARCHIVE_ACCESS_KEY / _SECRET_KEY 설정)",
    );
  }

  trackArchive(async () => {
    try {
      if (hasKeys) {
        await submitWaybackPost(link, {
          accessKey: env.archiveAccessKey!,
          secretKey: env.archiveSecretKey!,
        });
      } else {
        await submitWaybackGet(link, {});
      }
      if (opts.isVerbose) {
        printStderr(`[verbose] archive: submitted ${link}`);
      }
    } catch (error) {
      if (opts.isVerbose) {
        const reason = error instanceof Error ? error.message : "unknown error";
        printStderr(`[verbose] archive: failed for ${link} (${reason})`);
      }
      // 무시 — 아카이브 실패가 메인 흐름에 절대 영향을 주면 안 됨
    }
  });
};

export const resetArchiveSubmitStateForTest = (): void => {
  hintShown = false;
};
```

### `handle-items.ts` 연결

알림 성공 직후 한 줄만 추가. 보기에는 동기 호출이지만 `trackArchive` 가
즉시 반환하므로 실제 작업은 백그라운드에서 진행됨.

```diff
// src/lib/check/handle-items.ts (대략 116~126번째 줄)
       try {
         await enqueueForChannel(effectiveChannelUrl, async () => {
           await sendNotification({
             appriseUrl: effectiveChannelUrl,
             body,
             sourceIdentity: itemSourceIdentity,
           });
         });
+        // Fire-and-forget: 알림 발송된 링크 아카이빙. 절대 블로킹 안 함.
+        submitArchive(item.link, { isVerbose });
         pushSent(stats, item, channelName);
         if (!isJson) {
           printStdout(`sent: ${item.title} -> ${channelName}`);
         }
```

**중요 디테일:**

- `x.com` / `twitter.com` 항목은 `notificationLink` (transform된 링크)를
  사용. Wayback이 원본 X URL에 대해 `error:blocked-url` 로 거절하기 때문.
- 그 외 URL은 `item.link` (**원본** RSS 링크) 사용. 이렇게 해야 무관한
  `link_transforms` 설정 변경과 상관없이 아카이브 동작이 안정적으로 유지됨.
- `dryRun` 분기에서는 호출 안 함 — 위 diff는 non-dry-run 분기 안에 있음.
- `sendNotification` 실패 시 호출 안 함 — `try {}` 블록 안의 `enqueueForChannel`
  resolve 이후 위치.
- `wachi test` 에서는 호출 안 함 — 그 경로는 합성된 `TEST_BODY` 를 쓰며
  실제 링크가 없음 (`commands/test.ts` 에서 `submitArchive` 미호출).
- failure-alert (`handle-failure.ts`) 에서도 호출 안 함 — 피드 실패에 대한
  메타 알림에는 아카이브할 가치 있는 URL 이 없음.

### `run-check.ts` 연결

`runCheck()` 의 마지막, return 직전에 `flushArchivePool()` 한 줄 추가.
진행 중 POST 들에게 Wayback으로 핸드오프할 시간을 최대 15초까지 주되,
그 이상은 절대 기다리지 않음.

```diff
// src/lib/check/run-check.ts (runCheck 의 끝)
   // ... 기존 로직 ...
+  await flushArchivePool();
   return result;
```

## 5. 데이터 흐름

```
wachi check
  ↓
runCheck()  ──── 각 subscription 마다 ────┐
                                           ↓
                              checkRssSubscription()
                                           ↓
                              handleSubscriptionItems()
                                           ↓
                       per item: insertDedupRecord()
                                           ↓
                              sendNotification()  ◄── 기존 경로, 수정 없음
                                           ↓                        │
                       ┌───────────────────┴──────────────────┐    │
                       │ (성공)                                │    │
                       ↓                                       ↓    │
              pushSent() / printStdout()         submitArchive(item.link)
                                                              │
                                                              ↓
                                                    trackArchive(task)
                                                              │
                                                  (즉시 반환)
                                                              ↓
                                            [백그라운드] POST web.archive.org/save
                                                              │
                                                              ↓
                                              결과 무시 / verbose 시 로그
  ↓
flushArchivePool(15s timeout)  ◄── 진행 중 제출 대기
  ↓
프로세스 종료
```

## 6. 엣지 케이스 및 에러 처리

| 케이스 | 동작 |
|---|---|
| `WACHI_NO_ARCHIVE=1` | `submitArchive()` 즉시 반환, HTTP 호출 없음 |
| 키 미설정 | 익명 GET 사용; 1회성 `[verbose]` 힌트 출력 |
| `item.link` 가 `mailto:` / non-http URL | `shouldArchive()` false 반환, 스킵 |
| `item.link` 가 이미 `web.archive.org/*` URL | 스킵 (재귀 방지) |
| Wayback 이 429 (rate limit) 반환 | 조용히 catch; 재시도 없음 |
| Wayback 이 5xx 반환 | 조용히 catch; 재시도 없음 |
| 네트워크 unreachable | 조용히 catch; 재시도 없음 |
| 사용자 Ctrl+C | `flushArchivePool` 이 최대 15초 타이머에서 resolve |
| 풀 포화 (>6 in-flight) | 신규 제출은 조용히 드롭 |
| `dry-run` 모드 | 호출 안 됨 (`handle-items.ts` 분기로 가드) |
| `wachi test` | 호출 안 됨 (다른 코드 경로) |
| 아카이브 enqueue 후 send 실패 | 아카이브는 그대로 진행됨 — Wayback 입장에서는 이미 발송 성공한 알림. 허용 가능. |

## 7. 성능 고려사항

| 우려 | 완화책 |
|---|---|
| 채널별 큐 블로킹 | `submitArchive` 는 `trackArchive` 후 동기 반환; 채널 큐의 await 작업은 이미 종료됨. |
| `wachi check` 종료 지연 | `flushArchivePool` 에 hard 15초 상한. 일반 케이스: POST당 1~3초 × 동시 ≤ 6. |
| 대량 피드에서 메모리 증가 | 풀이 `MAX_CONCURRENT = 6` 으로 제한됨. 초과 제출은 큐잉 없이 **드롭** — 의도된 설계. |
| Wayback 분당 15 IP 한도 | `MAX_CONCURRENT = 6` + `http/rate-limit.ts` 의 호스트별 직렬화 (이미 `http` 가 사용 중) 로 안전하게 하회. |
| 동일 URL 반복 아카이브 | `if_not_archived_within=30d` 로 Wayback 이 기존 스냅샷을 공짜로 반환. |
| 콜드 스타트 비용 | 첫 호출도 기존 `ofetch` 클라이언트를 통한 단순 POST — 셋업 없음. |

`wachi check` 에 추가되는 worst-case 지연: **종료 시 +15초** (느린 아카이브
배치가 진행 중일 때). 일반 케이스: **+0초** (대부분의 제출이 1~3초 내에
`job_id` 반환, 타임아웃 안에 충분).

알림 1건당 추가 지연: **0ms** (진정한 fire-and-forget).

## 8. 테스트 전략

### 단위 테스트 (Unit)

- `test/unit/lib/archive/url-policy.test.ts`
  - `shouldArchive("https://example.com")` → `true`
  - `shouldArchive("mailto:a@b")` → `false`
  - `shouldArchive("https://web.archive.org/web/.../https://x.com")` → `false`
  - `shouldArchive("http://192.168.0.1")` → `false`
  - `shouldArchive("https://archive.ph/abc")` → `false`

- `test/unit/lib/archive/client.test.ts`
  - `http` mock. `submitWaybackPost` 가 올바른 `Authorization` 헤더,
    body 파라미터 (`skip_first_archive=1`, `if_not_archived_within=30d`,
    `delay_wb_availability=1`) 를 보내고 `job_id` 를 파싱하는지 검증.
  - `submitWaybackGet` 이 올바른 URL 호출하고 auth 미설정인지 검증.
  - 둘 다 `signal` 을 통해 취소 가능해야 함.

- `test/unit/lib/archive/pool.test.ts`
  - `trackArchive` 가 `MAX_CONCURRENT` 까지만 enqueue, 나머지 드롭.
  - `flushArchivePool` 이 모두 완료 시 resolve.
  - `flushArchivePool` 이 작업이 hang 해도 timeout 에서 resolve.
  - 작업 reject 시에도 풀이 올바르게 비워짐.

- `test/unit/lib/archive/submit.test.ts`
  - `WACHI_NO_ARCHIVE=1` → 작업 미스케줄.
  - 키 있음 → POST 경로.
  - 키 없음 → GET 경로 + 힌트가 모든 호출 통틀어 정확히 1번만 출력.
  - 네트워크 에러 → 조용함 (throw 없음), verbose 모드에서 stderr 로그.

- `test/unit/utils/env.test.ts` (확장)
  - `noArchive`, `archiveAccessKey`, `archiveSecretKey` resolution.

### 통합 테스트 (Integration)

- `test/integration/handle-items-archive.test.ts`
  - `submitArchive` mock. 알림 성공 시 `item.link` (transform 안 된 원본)
    로 호출되는지 검증.
  - `dryRun: true` 모드에서 호출 **안 됨** 검증.
  - `sendNotification` throw 시 호출 **안 됨** 검증.

### E2E 테스트

- `test/e2e/archive-disabled.test.ts`
  - `WACHI_NO_ARCHIVE=1` 으로 `wachi check` spawn.
  - `web.archive.org` 로의 outbound 요청 0건 확인 (process 레벨 fetch
    인터셉터 또는 env 로 바인드된 로컬 mock 서버 사용).

- `test/e2e/archive-enabled.test.ts`
  - hits 를 기록하는 mock SPN2 서버 대상으로 `wachi check` spawn.
  - 발송된 알림당 POST 1건, body 에 원본 링크 포함 확인.

### 테스트 인프라 추가

- 임시 포트에서 listen 하며 요청 기록하는 작은 `mockWaybackServer.ts`
  테스트 헬퍼 (기존 fixture 패턴과 유사).
- mock URL 은 `client.ts` 가 읽는 숨겨진 `WACHI_ARCHIVE_ENDPOINT_OVERRIDE`
  env var 로 주입 (테스트 전용; 사용자 문서에는 미공개).

## 9. 구현 순서

1. **환경변수** — `src/utils/env.ts` 에 `noArchive`, `archiveAccessKey`,
   `archiveSecretKey` 추가. `test/unit/utils/env.test.ts` 업데이트.
2. **URL 정책** — `src/lib/archive/url-policy.ts` 작성 + 단위 테스트.
3. **HTTP 클라이언트** — `src/lib/archive/client.ts` (POST + GET) 작성 +
   `http` mock 으로 단위 테스트.
4. **풀** — `src/lib/archive/pool.ts` 작성 + timeout 케이스 포함 단위 테스트.
5. **공개 진입점** — `src/lib/archive/submit.ts` 작성 + 단위 테스트
   (env 분기, 힌트 동작, 에러 swallow).
6. **handle-items 연결** — 성공 `enqueueForChannel` await 직후 한 줄 추가.
   통합 테스트 추가.
7. **run-check 연결** — return 전 `await flushArchivePool()` 한 줄 추가.
   E2E 에서 종료 타이밍 검증.
8. **Mock SPN2 서버** — 테스트 헬퍼 추가. 두 env state 에 대한 E2E 추가.
9. **문서화** — 업데이트:
   - `README.md` env var 표 — 신규 3개 추가
   - `SPEC.md` — notifications 하위에 짧은 "Notification archiving" 섹션
     추가 (기본값 + stateless 설계 명시)
10. **수동 smoke test** — 실제 subscription 으로 `wachi check` 실행, 몇
    분 내 (또는 `delay_wb_availability=1` 유지 시 12h 내)
    `https://web.archive.org/web/*/<link>` 에 링크가 나타나는지 확인 —
    Open Questions 참조.

## 10. 미결 질문

1. **`delay_wb_availability=1` 을 유지할 것인가?**
   - Pro: Wayback 인프라 부하 감소; archive.org 가 자동 제출자에게 명시적
     권장.
   - Con: 스냅샷이 약 12시간 후에야 조회 가능. 보관 목적이라면 허용
     가능하지만 (즉시 replay 필요 없음) 확인 필요.
   - 권장: **기본 ON** 유지; 실시간 사용 케이스가 있는 사용자를 위해
     `WACHI_ARCHIVE_FAST=1` 로 비활성화 옵션 노출.

2. **익명 GET fallback 을 유지할 것인가, 키 없으면 비활성화할 것인가?**
   - 사용자가 "기본 ON" 이라고 명시. 키 발급 전에도 GET fallback 으로
     약속을 지킴. 권장: **fallback 유지**, 1회성 verbose 힌트로 키 발급
     유도.

3. **`flushArchivePool` 타임아웃을 설정 가능하게?**
   - 공개 env var 까지 둘 가치 없음. 코드에 `15s` 상수로 유지.
   - 사용자가 종료 지연을 호소하면 그때 노출.

4. **`if_not_archived_within` 윈도우?**
   - RSS 사용 케이스에 30일이 합리적 기본값 (뉴스는 보통 30일 후 잘 안
     변함). 7일 또는 90일도 가능. 30일로 정하고 피드백 봐서 조정.

5. **피드 URL 자체도 아카이브할 것인가?**
   - v1 범위 외. 명세상 *알림 URL* 대상이지 피드 소스 대상 아님. 향후
     별도 기능 가능 (`WACHI_ARCHIVE_FEEDS=1`).

## 11. 변경 파일 (요약)

### 신규 파일

- `src/lib/archive/client.ts`
- `src/lib/archive/pool.ts`
- `src/lib/archive/submit.ts`
- `src/lib/archive/url-policy.ts`
- `test/unit/lib/archive/client.test.ts`
- `test/unit/lib/archive/pool.test.ts`
- `test/unit/lib/archive/submit.test.ts`
- `test/unit/lib/archive/url-policy.test.ts`
- `test/integration/handle-items-archive.test.ts`
- `test/e2e/archive-disabled.test.ts`
- `test/e2e/archive-enabled.test.ts`
- `test/fixtures/mock-wayback-server.ts`

### 수정 파일

- `src/utils/env.ts` — env var 3개 추가
- `src/lib/check/handle-items.ts` — 한 줄 `submitArchive(item.link, ...)`
- `src/lib/check/run-check.ts` — 한 줄 `await flushArchivePool()`
- `test/unit/utils/env.test.ts` — 확장
- `README.md` — env var 표
- `SPEC.md` — notifications 하위 짧은 subsection

### 수정 안 함 (의도적)

- `src/lib/db/schema.ts` — 스키마 변경 없음 (stateless 설계)
- `drizzle/` — 마이그레이션 불필요
- `src/lib/notify/send.ts` — 신성한 경로, 손대지 않음
- `src/lib/notify/format.ts` — body 포맷 변경 없음
- `src/commands/test.ts` — test 명령은 아카이브하지 않음 (실제 링크 없음)
- `src/lib/check/handle-failure.ts` — 실패 알림은 아카이브하지 않음
