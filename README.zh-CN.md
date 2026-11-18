# HumanDock 中文说明

HumanDock 面向需要审核美国英语广告短文本的团队：品牌提供事实表和初稿，受邀审核员交付一份不可变报告，品牌分别验收服务、批准精确内容版本，随后导出文件。

**当前实现了隔离的 DEMO 流程，以及本地 EVM 上的钱包登录到提款流程。HumanDock 尚未部署到远端 ME Network，没有 HumanDock 真实 MEC 付款或真实用户 ME ID 核验的完成声明。** 已有测试脚本不代表 CI 已通过，也不代表完成了 ME 远端端到端实测。

[英文 README](README.md) · [通用与 DEMO API](docs/api-contract.md) · [钱包及链上 API](docs/live-api.md) · [网络实测证据](docs/network-verification.md) · [安全边界](docs/security-model.md) · [路线图](docs/roadmap.md)

## 安装

使用 Node.js **22 或 24**：

```bash
git clone https://github.com/RSXLX/humandock.git
cd humandock
npm ci
cp .env.example .env
```

下面两种模式共用默认 Web/API 端口，一次运行一种。

### 1. 不需要钱包的本地 DEMO

```bash
npm run dev
```

打开 **http://localhost:3000**。API 位于 **http://127.0.0.1:4000**，通过前端 `/api/v1` 转发。默认 PGlite 将数据保存到 `.data/pglite`；设置 `DATABASE_URL` 可使用 PostgreSQL。无需钱包、代币、模型 API key 或 Docker。

在 Brand studio 创建任务、冻结报价并投入 DEMO 积分；切换 Invited reviewer 接单并交付；再回到品牌分别验收服务、批准具体版本和导出。创建改稿可验证旧批准不能用于新稿，撤销可验证旧下载链接也受当前权限约束。审核员提取的是本地账本积分，没有链上交易。

角色选择器是开发 fixture，必须保留在可信本地环境。切换角色会替换会话并清理浏览器中的私有工作区状态。

### 2. 本地真实合约与钱包流程

```bash
npm run dev:me-local
```

此命令启动 Ganache、部署实际 Solidity 合约、启动链模式 API 和 Next.js。身份为显式注入的本地 fixture，不查询 ME，也不通过生产环境变量绕过 ME 身份验证。

| 项目 | 默认值 |
|---|---|
| 页面 | `http://127.0.0.1:3000` |
| API | `http://127.0.0.1:4000` |
| 钱包 RPC | `http://127.0.0.1:18545` |
| Chain ID | `31337` |
| 货币 | `LOCAL`，无价值 |
| 身份 | `local_test`，不标为 ME 已认证 |
| 数据库 | 内存数据库，随链每次重置 |

启动输出包含买方和审核员地址。`.data/local-me-runner/fixture.json` 包含账户清单及**公开的开发助记词**，可在独立测试钱包配置中使用这些账户。不要向这些公开账户转入真实资产。运行器主动忽略 `DATABASE_URL`，避免将重置的测试链连接到旧的持久化账本。

把 EIP-1193 钱包连接到本地链，用买方账户签名登录、刷新本地身份、选审核员并建单；按照交易面板出资。使用审核员账户接单和签署交付，再由买方验收服务、批准精确版本；最后审核员提款。每个签名和交易都需要钱包操作。广播后先保留交易哈希，再向 API 登记；登记失败应重试登记或对账，不自动再次发送交易。

自动浏览器测试注入 EIP-1193 测试 provider；它不能证明所有钱包扩展或 ME Pass 均兼容。

## 当前实现边界

代码包含钱包 challenge 登录、身份准入适配、冻结签名报价、合约托管、双签交付、分账与退款、提款、确认数检查、规范链事件投影、持久化游标和重放恢复。API 将交易确认、事件已入账和提款余额对账分别呈现。

`APP_MODE=demo` 使用本地积分账本；`APP_MODE=me` 使用钱包与合约路径，`ME_NETWORK` 再区分 `local`、`me-testnet` 和 `me-mainnet`。仅设置模式不会使资金路径就绪：链 ID、部署代码与角色、同步状态以及对应的金额单位和身份准入条件都必须成立。已有任务的交付、退款、结算与提款不依赖重新通过身份准入。

生产 PostgreSQL RLS、外部不可变对象存储、独立事务 outbox、托管密钥管理及完整安全审查仍有待完成。请阅读[安全边界](docs/security-model.md)，不要将本地链流程称为生产上线。

## 资金、审核与导出

总服务费 `F = W + P`：W 为审核员报酬，P 为平台费。正常验收分配 W/P；未接单取消或未按时交付退款 F；争议只分配 W，并退 P；仲裁 72 小时未决使用约定的 W 对半兜底并按金额量子取整。该兜底不是审核质量公平性的保证。

**已结算可提余额、提款交易已确认、余额对账已验证是三个不同状态。** API 现有 `*Atoms` 字段以十进制整数字符串承载 EVM wei，不是 Cosmos bank 原子单位，资金写入不能使用浮点数。

同一高度的只读测试网观察已支持该部署的 bank 精度为 8，以及 **1 umec = 10^10 EVM wei**。证据见[网络核验](docs/network-verification.md)和[机器记录](packages/me/observations/testnet-units-verified.json)。这不证明 HumanDock 已在 ME 完成入金、分账或提款，也不外推到主网；Ganache 不具有真实 ME Cosmos bank。

BLOCK 或 CHANGES_REQUIRED 可以是一份已完成、应付费的审核服务。导出必须另有 PASS 报告和精确版本的有效批准；服务是否已经结算不是批准的前置条件。每次 TXT 下载和私有 JSON receipt 请求都重查权限、固定内容、到期与撤销。新稿不能复用旧批准；同一获批文件可以重复下载，不再收取服务费。这里的“批准”是批准交付/导出，不是已经发布到广告平台，也不是法律认证。

## 验证命令

```bash
npm run typecheck
npm test
npm run contracts:compile
npm run test:contracts
npm run test:me
npm run test:wallet
npm run test:live
npm run test:browser:live
npm run build
```

`test:contracts` 执行实际合约字节码；`test:me` 覆盖 ME 适配器；`test:wallet` 覆盖前端钱包边界；`test:live` 覆盖本地链 API；`test:browser:live` 使用测试钱包 provider 贯通浏览器、API 和本地链。原有 `test:browser` 覆盖独立 DEMO 流程。浏览器测试需要安装 Playwright Chromium。

实际通过情况以当前 checkout 的命令输出和对应 Actions 运行结果为准；本文不宣称 CI 已绿，也不将本地测试称为远端 ME 证明。

## ME 远端接入与剩余门槛

完整配置以 [`.env.example`](.env.example) 为准。入口读取 `.env`，显式进程环境变量优先。配置包括网络/RPC、部署 manifest 和代码哈希、金额单位证据、受邀审核员、身份策略与稳定 HMAC 密钥、三种用途的服务端证明签名密钥等。用户的支出私钥保留在钱包中；服务端密钥与私有 RPC 凭据不要提交。

```bash
npm run me:preflight
```

此命令只读，不部署、不读取用户钱包支出私钥、不转账。调研已实测测试网 EVM chain ID 为 **400**，并核实官方 HTTPS Cosmos REST/Tendermint 服务；官方公布的 EVM RPC 仍为 HTTP，本次有限核查未找到可用的官方 HTTPS EVM 配置。REST/Tendermint 不是 EVM RPC，应用的非本地 HTTPS 要求保持不变。官方 faucet 已找到，本次未申请测试币。

远端完成声明前还需要：

1. 通过授权方式核对 ME Pass 应用墙和完整能力，关闭 **G0 生态重合门槛**。公开搜索未证明不存在完整同类。
2. 获取目标网络可用的安全 EVM 入口和获准使用的测试币。
3. 确认官方身份策略及 HARBOR 高级认证的数值等级对应，用获授权钱包验证主子账户。
4. 部署锁定版本合约并保留角色、代码、交易及规范区块证据。
5. 完成远端全流程、故障恢复和 EVM/bank 对账的小额实测。
6. 在接纳真实客户或资金前完成租户隔离、密钥、存储与运维恢复措施。

具体官方来源、commit 和已知/未知边界见 [ME 接入依据](docs/me-integration.md)、[网络核验](docs/network-verification.md)、[生态缺口](docs/ecosystem-gap.md)。

### 规范链重放

停止其他 API/indexer 并备份数据库后，对匹配的部署及数据库配置执行：

```bash
npm run me:reindex -- --execute
```

要求 `APP_MODE=me`。它归档旧事件证据并从规范确认日志重建派生状态，不发送交易，不退款，也不恢复缺失的私有文案、报告或 salt。重放成功前保持服务受限；详见[链 API](docs/live-api.md)。

AI 辅助为可选功能；未配置 provider 时明确显示本地规则。AI 输出不能批准内容或授权资金。公开演示使用合成内容，私有 receipt 含 manifest/salt，应保留在授权范围内；仓库未存入第三方 DID 记录。当前仓库许可状态为 **UNLICENSED**。
