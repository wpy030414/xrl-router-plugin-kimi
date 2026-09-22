# Kimi 桌面客户端逆向笔记

> 调研日期：2026-09-22　客户端版本：Kimi Desktop 3.2.12（win32-x64，Electron 43.7.3）
> 目标：脱离客户端，把 Kimi 的模型额度反代为 xrl-router 可路由的供应商。
> 所有结论均经 curl / Python 实测验证；凭证一律脱敏，真实值只存在于客户端本地文件中。

## 0. 一句话结论

Kimi Desktop 的「Kimi Code / Work」额度走一个独立的 OpenAI 兼容网关 `agent-gw.kimi.com/coding/v1`，
鉴权只认一把 `sk-kimi-*` 长期 key；这把 key 由用户的 `accessToken` 经 `www.kimi.com/apiv2` 的
`APIKeyService/CreateAPIKey(scope=WORK)` 铸造。`accessToken`（TTL≈10min）由 `refresh_token`（TTL=90天）
经 `auth.kimi.com/api/auth/token/refresh` 滚动续期。三者全部可由插件独立持有 → **可完全脱离客户端运行**。

---

## 1. 三层凭证体系（逆向核心）

```
refresh_token (JWT, 90天)
    │  GET auth.kimi.com/api/auth/token/refresh   (滚动：返回新 access + 新 refresh)
    ▼
access_token (JWT, ~600s/10min)
    │  POST www.kimi.com/apiv2/kimi.gateway.credentials.v1.APIKeyService/CreateAPIKey
    │       body {"apiKey":{"name":"kimi-desktop","scope":[9]}}   (9 = WORK)
    ▼
sk-kimi-* (长期 key, 实测长期有效；客户端 probe 到 401 才重铸)
    │  POST agent-gw.kimi.com/coding/v1/chat/completions
    ▼
模型推理 (k3-agent / k2d8-preview / k3-agent-swarm)
```

**关键实测**：`access_token` 直连 agent-gw → `401 invalid_authentication_error`；
`sk-kimi` 连 agent-gw → 鉴权通过（偶发 `429 engine_overloaded_error`，重试即过）。
∴ agent-gw **只认 sk-kimi**，不能拿 JWT 直接打。

---

## 2. 端点清单

### 2.1 agent-gw —— 模型推理（OpenAI 兼容）

- base：`https://agent-gw.kimi.com/coding/v1`（dev：`https://agent-gw-dev.dev.kimi.team/coding/v1`）
- `POST /chat/completions` —— stream / 非 stream 均验证通过，返回标准 `chatcmpl-*` SSE
- `GET /models` —— 返回模型清单（见 §5）
- 鉴权：`Authorization: Bearer sk-kimi-...`
- **最小头**：`Authorization` + `Content-Type: application/json` 即可（实测足够）
- 客户端附带的业务头（非必需）：
  - `User-Agent: Desktop Kimi Work`
  - `R-Timezone: Asia/Shanghai`
  - `X-Msh-Version: 3.2.12`
- `429 engine_overloaded_error`：上游过载，需指数退避重试（实测 1–2 次内成功）

### 2.2 apiv2 —— 凭证 / 会员（Connect-RPC over HTTP）

- base：`https://www.kimi.com/apiv2`（后缀解析：`kimi→/apiv2`、`claw→/api-claw`、`file→/apiv2-files`、`code→/apiv2-coding`、`oauth→/api-oauth`）
- 公共头：`Content-Type: application/json`、`Connect-Protocol-Version: 1`、`Authorization: Bearer <accessToken>`
- 可选风控头：`X-Msh-Shield-Data: <blackbox>`（来自 `getBlackBox()`，实测 CreateAPIKey/GetSubscription 不带也能过；带上更稳）
- 方法：
  - `POST /kimi.gateway.credentials.v1.APIKeyService/CreateAPIKey`
    - body：`{"apiKey":{"name":"kimi-desktop","scope":[9]}}`（scope 枚举见 §4）
    - resp：`{"apiKey":{"id":"<keyId>","key":"sk-kimi-..."}}`
  - `POST /kimi.gateway.credentials.v1.APIKeyService/DeleteAPIKey` body `{"id":"<keyId>"}`
  - `POST /kimi.gateway.membership.v2.MembershipService/GetSubscription`（只读，验证用）
  - `POST /kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats`（只读）
  - `createModelAPIKey`（ClawService，另一条线，scope=DEEP_RESEARCH/OK_COMPUTER 等，本反代不用）
- 实测：`accessToken → GetSubscription` 返回 200（Adagio / LEVEL_FREE），链路通。

### 2.3 auth —— token 刷新

- base：`https://auth.kimi.com/api`（china 默认；dev：`auth.dev.kimi.team/api`；overseas：`auth.kimi.ai/api`）
- `GET /auth/token/refresh`
  - 头：`Authorization: Bearer <refreshToken>`、`X-Language: zh-CN`
  - resp：`{"access_token":"...","refresh_token":"..."}` —— **refresh_token 滚动**（旧的作废）
  - `skipAuth` 调用；401/403 → refresh_token 失效，需重新登录
- TTL：accessToken ≈ 600s；refreshToken = 90 天

### 2.4 扫码登录 —— 完全脱离客户端的取 token 入口【B 方案核心，已选定】

base：`https://auth.kimi.com/api`，Connect-RPC（`Connect-Protocol-Version: 1`），无需鉴权头（policy=none）。

**完整链路（代码 + 日志双重实证，token 无需独立兑换 RPC）：**

```
1. POST /account.gateway.v1.AuthService/CreateLoginQRCode      body {} （实测 200）
      → resp {"code":"<qrCode>"}                                ← createLoginQRCode({}) → {code}
2. 把 qrCode 渲染成二维码（终端 ASCII / 图片），用户用 Kimi App 扫
3. POST /account.gateway.v1.AuthService/GetLoginQRCodeStatus   body {"code":"<qrCode>"}  轮询(客户端约1.3s一轮)
      → resp {"status":<int>, "accessToken":"...", "refreshToken":"...", "userId":"..."}
      ← getLoginQRCodeStatus({code}) → {status, accessToken, refreshToken, userId}
4. status==SUCCESS(4) 时，accessToken/refreshToken/userId 直接就在本响应里 → 落库，登录完成
```

**status 枚举**（`account.gateway.v1` QR 状态）：

```
0 UNSPECIFIED → "pending"   1 PENDING → "pending"   2 SCANNED → "scanned"
3 EXPIRED → "expired"（需重新 CreateLoginQRCode）   4 SUCCESS → "success"（带 token）
```

轮询逻辑：`pending`/`scanned` 继续轮；`success` 取 token 停止；`expired` 重新申请二维码。

**日志实证**（本次客户端登录正是扫码完成的）：`GetLoginQRCodeStatus` 轮询到 request#31 → 紧接 request#32 `GetCurrentUser`，**中间无任何兑换 RPC**，随后 `token hasValue=true`。∴ token 在 SUCCESS 响应内直接下发，确认无误。

**refresh（B 方案续命，独立于客户端）**：
`_0x49733e(refreshToken)` → `auth.kimi.com/api/auth/token/refresh`，policy=`refresh`，body `{refreshToken}` → `{accessToken, refreshToken}`（滚动）。与 §2.3 同端点。

**备选登录**：`loginWithThirdParty({credential:{thirdParty, code}})`（微信等第三方，同返回 accessToken/refreshToken/userId/newUser）；短信验证码登录亦在 `AuthService` 下。本插件用扫码即可。

appId：china=`1a05d2cd-2612-8531-8000-00000ab58fa2`，overseas=`1a06cf50-9242-8104-8000-0000a1f19631`（CreateLoginQRCode 实测空 body 也能签发 code，appId 可能用于风控/区域，实现时按需带上）。

**待实现期 5 分钟实测确认**：二维码内编码的字符串究竟是裸 `qrCode` 还是某个含 code 的深链 URL（`createLoginQRCode` 返回的 `code` 直接喂给二维码渲染，最可能就是裸 code；login 脚本首次跑时扫一次即可验证）。

---

## 3. 凭证落地位置（本地）

`%APPDATA% = C:\Users\xrl\AppData\Roaming`，客户端目录 `kimi-desktop`：

| 文件 | 内容 | 形态 |
|------|------|------|
| `daimon-share/daimon/config.json` | `credentials.kimiWeb.{accessToken,refreshToken,userId}` + `credentials.kimiCode.{apiKey,baseUrl}` | **明文**（首选来源） |
| `daimon-share/daimon/kimi-code-key.json` | `{userId, apiKey(sk-kimi), keyId}` | **明文** |
| `bridge-store/token-store.json` | `{origin, tokens:{access_token,refresh_token,msh_user_id,...}, accountRegion}` | safeStorage 加密（v10） |
| `Local State` | `os_crypt.encrypted_key`（DPAPI 包裹的 AES-GCM 主密钥） | DPAPI |

### token-store 解密（备用，config.json 明文已够）

`safeStorage.v1` = Windows DPAPI + AES-256-GCM，密文前缀 `v10`：

```
master = DPAPI_CryptUnprotectData( base64(LocalState.os_crypt.encrypted_key)[5:] )   # 去掉 "DPAPI" 头，得 32 字节
blob   = base64(token-store.json.data)                                                 # 前缀 b"v10"
nonce, ct, tag = blob[3:15], blob[15:-16], blob[-16:]
plaintext_json = AESGCM(master).decrypt(nonce, ct+tag, aad=None)
```

实测可解出完整 tokens（Python `cryptography` + `ctypes.windll.crypt32`）。

---

## 4. scope 枚举（APIKey.scope）

```
0 UNSPECIFIED   1 DEEP_RESEARCH  2 OK_COMPUTER  3 GEN_IMAGE   4 CODING
5 K2_THINKING   6 PROVIDES       7 AGENT        8 CLAW        9 WORK
10 PLUGIN       11 OFFICE_ADDIN  14 FEATURE_AUTOMATION  15 FEATURE_PLUGIN
16 FEATURE_DREAM 17 FEATURE_PROJECT 18 FEATURE_MY_KIMI 19 FEATURE_WIDGET_TASK
20 FEATURE_OFFICE_ADDIN 21 FEATURE_WEBBRIDGE 22 FEATURE_3D 23 FEATURE_K2D8_PREVIEW
24 FEATURE_KIMIX 25 FEATURE_KIMI_DESIGN 100 FEATURE_OMNI
```

桌面 Work/Coding 额度用 **scope = 9 (WORK)**。

---

## 5. 模型清单（GET /models 实测）

| model id | display | context | reasoning | 多模态 |
|----------|---------|---------|-----------|--------|
| `k3-agent` | K3 | 1,000,000 | low/high/max（默认 high） | image_in, video_in |
| `k2d8-preview` | K2.8 Preview | 1,000,000 | low/high/max | image_in, video_in |
| `k3-agent-swarm` | K3 集群 | 1,000,000 | low/high/max | image_in, video_in, dynamically_loaded_tools |

- `default_model_id = k3-agent`
- 1M 上下文（CONTEXT_LENGTH_XL）需 Allegro/Max 会员；免费档为 CONTEXT_LENGTH_L
- reasoning effort 经 OpenAI 兼容字段传入（具体字段名待抓客户端实包，疑似 `reasoning_effort` / `extra_body`，见 §8）

---

## 6. 客户端的 key 生命周期（决定是否要自己 mint）

逆向 `DaimonProvision`：
1. 读 `kimi-code-key.json` 里 persisted key
2. `probeKimiCodeApiKey` 探测 → `probe !== "invalid"` 就 **reuse**（不重铸）
3. 仅当 probe=invalid 或运行时 agent-gw 返回 401（`/401/i && /api[- ]?key|expired|credential/i`）→ rotate（DeleteAPIKey + CreateAPIKey）

∴ `sk-kimi` key 长期有效；插件应：**优先复用现成 sk-kimi**，只在 401 时才重新 mint。

---

## 7. 关键约束：refresh_token 滚动 + 客户端并发

- 实测客户端运行期持续刷新（`token-store.json` mtime 晚于进程启动），且 refresh 会**滚动 refresh_token**（旧的立即作废）。
- 若插件与客户端**共享同一 refresh_token** 并各自刷新 → 互相作废，两边都可能掉线。
- 三种规避策略：
  - **A 被动复用**：插件直接读 `config.json` 现成 `sk-kimi`，**不自行 refresh**；sk-kimi 401 时才重读 config.json（客户端会刷新它）。依赖客户端保持登录运行。零副作用。
  - **B 扫码独立** ✅【已选定】：插件走 §2.4 扫码登录，持有**独立** token 链与独立 sk-kimi，完全不碰客户端凭证。客户端可关。真正脱离。
  - **C 主动 refresh**：插件读 config.json 的 refresh_token 自行续命；需确保客户端不同时刷新（如关客户端）。有竞争滚动风险。

### ✅ 选定 B 后的独立凭证流（插件自洽，与客户端零耦合）

```
[pnpm login]  扫码 → 独立 {accessToken, refreshToken, userId}
                → CreateAPIKey(scope=9) 铸出插件专属 sk-kimi + keyId
                → 三者写入插件本地 .env（永不进 git）
[运行期]      agent-gw 用 sk-kimi（长期有效）
                accessToken 仅铸/换 key 时需要 → 由插件用独立 refreshToken 自管 refresh（滚动续期）
                sk-kimi 401 → 用当前 accessToken 重新 CreateAPIKey（删旧 keyId）
[客户端]      可完全关闭；插件的 token 链与客户端互不影响（不同 device_id / 独立 refresh_token）
```

要点：B 方案下插件持有一份**独立 refresh_token**，刷新滚动只影响插件自己，与客户端那条链井水不犯河水。这是 B 相对 C 的根本优势。

---

## 8. 待办 / 未决（实现前补抓）

- [x] ~~扫码登录后 `code → access_token/refresh_token` 的确切兑换 RPC~~ → **已解决**：token 直接在 `GetLoginQRCodeStatus` 的 SUCCESS 响应内返回，无独立兑换 RPC（§2.4，代码+日志双证）
- [ ] reasoning_effort / thinking 在 chat/completions 里的确切字段名（抓客户端实包或试 `reasoning_effort`、`extra_body.reasoning`）—— 影响「思考档位」透传，非阻塞 MVP
- [ ] `X-Msh-Shield-Data` blackbox 的生成（openskp / trustdecision 风控）—— 实测 CreateAPIKey 不带也过，暂列可选
- [ ] login 脚本首次跑时确认二维码编码内容（裸 qrCode vs 深链 URL，§2.4 末）
- [ ] refresh 端点实测：**留到 login 拿到插件独立 token 后再验**（现在用客户端 refresh_token 实测会滚动作废客户端凭证，故意不碰）

---

## 9. 反代交付形态（对齐 xrl-router 插件规范）

参照兄弟项目 `xrl-router-plugin-zcode`（kind=messages）/ `xrl-router-plugin-qwenwork`（kind=chat_completions）：

- 形态：xrl-router 委托供应商插件 —— 本地 Express HTTP + WS 注册到 router（`/ws/plugin`）
- 注册：`kind=chat_completions`、`api_path=/v1/chat/completions`（上游原生 OpenAI 兼容，**零协议转换**，router IR 层负责客户端协议↔chat_completions）
- 端口：兄弟插件占用 19065(zcode)/19066(wukong)/19067(qwenwork)/19068(router)；**本插件建议 19069**
- 职责边界（同 zcode AGENTS.md）：密钥轮换/重试/用量统计/协议转换交给 router；插件只做「装上游业务头 + 供 sk-kimi + 透传错误码 + 401 时重铸 key」
- PLUGIN_ID：`xrl-router-plugin-kimi`
