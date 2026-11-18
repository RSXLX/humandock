# HumanDock 中文快速说明

HumanDock 是面向出海团队的 AI 文案人工审核与版本批准工具。首个场景为美国英语广告短文本。

**当前完成范围：可运行的本地 MVP、持久化业务 API、两个真实 Solidity 合约与独立本地 EVM 测试。尚未部署到 ME Network，没有真实 MEC 转账或已验证 ME ID 用户。**

## 启动

使用 Node.js 22 或 24：

```bash
git clone https://github.com/RSXLX/humandock.git
cd humandock
npm ci
cp .env.example .env
npm run dev
```

浏览器打开 http://localhost:3000。API 在 127.0.0.1:4000，通过前端 `/api/v1` 转发。默认使用 PGlite，将数据保存在 `.data/pglite`；设置 `DATABASE_URL` 可连接 PostgreSQL。

本地演示身份和积分必须保持在本机。DEMO 资金操作不代表链上交易，`APP_MODE=me` 也不会自动开启真实转账。

## 验证主流程

1. 选择 Brand studio，创建文案任务和事实表，冻结报价并投入 DEMO 积分。
2. 切换 Invited reviewer，接受指派，完成五项检查，提交最终报告。
3. 切回品牌，分别验收审核服务、批准具体内容版本。
4. 导出已批准文件，再创建改稿，验证旧批准不能用于新稿。
5. 撤销批准，验证旧下载链接不能继续导出。
6. 审核员查看及提取已分配的本地积分。

BLOCK 报告可以是一份应付费的审核服务；内容能否导出取决于 PASS 结论和精确版本批准。

## 检查命令

```bash
npm run typecheck
npm test
npm run contracts:compile
npm run test:contracts
npm run build
```

GitHub Actions 还运行浏览器验收。实际通过情况以该次 CI 运行结果为准。

## 下一阶段

- 依据[生态缺口记录](docs/ecosystem-gap.md)核实完整同类，避免重复建设已有产品。
- 按[ME 接入依据](docs/me-integration.md)确认 HTTPS RPC、chainId、ME ID 等级、测试币和金额单位。
- 完成真实钱包、签名服务、合约部署、链事件索引和小额对账。
- 将本地 DEMO 身份与资金接口替换为已验证的真实交易路径。

完整设计与当前限制见[英文 README](README.md)、[API 约定](docs/api-contract.md)、[安全边界](docs/security-model.md)和[开发路线](docs/roadmap.md)。
