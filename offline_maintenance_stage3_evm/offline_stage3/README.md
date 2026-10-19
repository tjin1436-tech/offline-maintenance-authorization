# 第三阶段：本地 EVM 登记、真实交易回执与恢复补传

本阶段将 HTTP 登记模拟器替换为在 Ganache 本地开发链实际执行的 Solidity 合约。自动编译、启动链、部署合约、发送交易、保存回执，并把你上传的 results_with_keys.zip 中 17 条已完成日志导入链上登记。机器人仍是前两阶段的模拟器，不需要实体机器人或公开链钱包。

## 一、VS Code 运行步骤

1. 下载并解压此 ZIP 到新目录，在 VS Code 打开 offline_stage3 文件夹，保留前两阶段结果。
2. 本阶段使用 Node.js。终端先检查：

```bash
node --version
npm --version
```

本包要求 Node.js 22 或以上，提供者实际使用 Node.js 24.19.0 验证。若找不到 node，请从 https://nodejs.org/en/download 安装 Node.js 24 LTS 的 Windows 安装包；安装后关闭并重新打开 VS Code。Python 不需要升级。

3. 安装锁定依赖：

```bash
npm ci --no-audit --no-fund
```

依赖固定为 ethers 6.13.5、Ganache 7.9.2、solc 0.8.28，package-lock.json 保存依赖解析结果。Ganache 的嵌套 macOS 专用 fsevents 条目补上 optional=true，与其上游可选依赖角色一致，避免 Windows/Linux 的 EBADPLATFORM；没有改库源码。提供者已验证干净目录安装。

4. 运行本阶段：

```bash
node run_evm_experiments.cjs --repeats 3 --output stage3_results
```

自动启动本机链，不需要另开终端运行节点。默认也导入 input/your_functional_evidence.json，这是你已上传的 Windows 功能实验签名日志；来源摘要见 input/provenance.json。私钥未包含在该文件中。

5. 重新打开保存的链数据库，独立核对交易：

```bash
node audit_results.cjs --input stage3_results
```

运行实验应看到 39/39 passed、transactions=122、imported records=17。审核应看到 audit_success 为 true、receipts_requeried=122。节点自动停止后可以上传整个 stage3_results 文件夹。

这些精确计数基于默认重复 3 次、使用附带的你的日志且全部用例通过；改变输入或重复次数，计数会相应变化。39 次故障/功能用例和 17 条导入日志是不同统计维度，不能写成 56 个独立安全用例。

若只有 PowerShell 提示 npm.ps1 禁止执行，可把 npm 命令改为 npm.cmd ci --no-audit --no-fund，不需要修改系统执行策略。Ganache 在某些 Node 版本上可能提示原生 uWS 模块不可用并回退 JavaScript；用最终 PASS/FAIL 和 audit_success 判断功能结果，不能把回退环境的耗时与原生环境混为性能结论。

重跑时使用新输出目录：

```bash
node run_evm_experiments.cjs --repeats 3 --output stage3_results_rerun
node audit_results.cjs --input stage3_results_rerun
```

指定另一个完整签名证据文件：

```bash
node run_evm_experiments.cjs --import "你的路径/evidence.json" --output stage3_results_new_input
```

只运行新合约用例、跳过历史日志导入：

```bash
node run_evm_experiments.cjs --no-import --output stage3_results_no_import
```

## 二、链上与链下的职责

| 层 | 执行内容 | 当前信任条件 |
|---|---|---|
| 链下 preflight | Ed25519 授权端、网关、维修终端签名；人员与范围绑定；操作允许列表；声明执行时间；序号配额；完成状态 | 导出的测试公钥映射可信；终端和网关密钥未泄漏 |
| owner 登记授权 | 将经过验证的授权摘要、提交账户、机器人、工单版本、有效区间、配额、操作范围登记到合约 | owner 正确建立 Ed25519 身份与 EVM 提交账户的映射 |
| 合约 submit | EVM 提交账户、机器人/工单版本、操作范围、声明执行时间、连续序号、配额、前哈希、请求 ID 去重、同序号冲突 | 提交账户经过可信适配器验签；recordHash 和结构化字段由该适配器正确生成 |
| 本地队列/恢复 | 离线保留日志、交易完成后本地未标记时重新提交 | 本地存储未被恶意回滚，网关串行处理 |

合约没有验证 Ed25519，也没有从 recordHash 重新推导结构化字段。它验证注册的结构化约束，并记录适配器提交的摘要；签名与字段/摘要对应关系由可信适配器保障。owner 也是受信角色。这一阶段属于“可信链下桥接＋EVM 登记”的参考实现，不能声称去除了全部可信中心或合约独立验证全部维修证据。

执行时间检查的是日志声明的 executed_at，允许有效期内完成的操作在期满后补传，不能证明真实发生时间。新用例时间采用 0..900 的逻辑秒，与当前块时间不同；合约故意不使用 block.timestamp 判断历史执行是否合法。

## 三、13 种用例，各重复 3 次

| 用例 | 操作 | 预期证据 |
|---|---|---|
| C1 正常登记 | 有效签名日志首次提交 | status=1，RecordAccepted，记录数 1 |
| C2 重复提交 | 同一日志提交两次 | 第二笔 DuplicateObserved，两笔真实成功回执，业务记录数仍 1 |
| C3 已观察到的双签 | 同序号、不同内容且签名都有效的日志 | ConflictObserved，原记录不覆盖，冲突摘要保留在事件 |
| C4 非授权账户 | 使用另一个 EVM 账户提交 | 实际发出的交易回执 status=0，状态未增加 |
| C5 错误前哈希 | 首条记录携带非 GENESIS 前哈希 | status=0，状态未增加 |
| C6 序号缺口 | 首次就提交序号 2 | status=0，状态未增加 |
| C7 超配额 | quota=1，提交第二项新操作；直接测试合约约束 | 第一笔成功，第二笔 status=0，记录数 1 |
| C8 到期边界 | executed_at 等于 expires_at | 适配器拒绝；绕过适配器的直接测试交易也 status=0 |
| C9 签名被修改 | 修改日志不重新签名，通过正常适配器提交 | preflight 拒绝，不发送 submit 交易 |
| C10 链节点恢复 | 保存记录后正常关闭节点，使用原数据库启动新进程 | 原回执及合约状态仍可查询 |
| C11 网关终止 | 交易已入块，但本地尚未写同步成功时，强制终止网关子进程 | 新进程重传为 DuplicateObserved，本地最终同步成功 |
| C12 远端连接故障 | RPC 故障代理关闭连接，日志保存到队列；恢复同一代理后上传 | 断网时合约记录数 0，恢复后两条都接受，数为 2 |
| C13 信任边界负对照 | 授权 EVM 账户绕过适配器，直接提交坏 Ed25519 签名日志摘要 | 合约接受，表明它无法独立识别坏签名 |

C13 是当前架构的能力边界，不是安全防御成功。它计入“预期行为符合”，不能把全部 39/39 转换为“攻击全部被阻止”。论文应单列 C13，报告恶意/失陷桥接账户这一未解决威胁。若要消除该信任条件，需要另外设计链上可验证签名或证明协议，不能仅修改论文表述。

C4..C8 的失败交易显式设置 gasLimit 后真实发送并挖块，status=0 来自实际交易回执，不是只做一次 eth_call 或把前端报错当作链上拒绝。C9 的拒绝发生在链下，不应给它编造 submit 交易哈希或 Gas。

队列和 JSON 结果采用临时文件写入、文件 fsync 后重命名的方式保存，并在实验结束及审计时核对同步标记。它用于避免部分文件写入影响进程恢复实验；没有完成目录持久性、断电或磁盘控制器故障验证。

C3 的链上事件保存原/新摘要与新元数据摘要，完整双签内容保存在链下 evidence.json；没有把完整日志或维修隐私数据写入合约。相同冲突内容重复上报不会重复增加全局冲突数。只能发现已经提交的冲突，不能发现隐藏分叉或没有检查点的尾删。

## 四、历史结果导入

默认输入来自你上传的 results_with_keys.zip。适配器逐条验签，跳过 PENDING，仅登记 DONE；每个原始用例建立独立 session，保留原序号和哈希链。14 个来源用例包含 17 条 DONE 日志，全部完成登记。

这是你先前软件参考实验日志的真实 EVM 登记，证明这些输入能被适配器和合约处理。它不是在这一阶段重新维修了 17 台实体机器人，也不是独立部署现场数据。导入来源、签名公钥和原始证据随结果保存。

## 五、输出与复核

| 文件/目录 | 用途 |
|---|---|
| results.csv / results.json | 13 种用例的三次结果；预期与实际并列 |
| transactions.json | 每笔部署、授权登记、submit 的交易、原始回执、状态、Gas、块号、解码事件 |
| evidence.json | 公钥、签名原文、授权映射、preflight 结果、session ID |
| operational_events.json | 节点重启、网关强制终止、RPC 恢复事件 |
| import_results.json / imported_evidence.json | 历史日志导入结果及其来源原文 |
| deployment.json / contract_artifact.json | 链 ID、地址、部署交易、运行字节码、ABI、编译器、优化设置、源码摘要 |
| scope.json | 运行环境、用例数、交易数、限制 |
| audit.json | 重启保存节点后重新查询的回执、块包含、事件、状态及签名核查结果 |
| chain-db/ | 本地链持久化数据库；保留便于重新查询 |
| *_queue.json / *_spool.json | 本地同步状态与离线队列 |

审核程序不发送新交易；重新打开链数据库，逐笔获取回执和交易，核对块包含、合约字节码、原始事件、最终映射与总数，并复验签名。导出的公钥仍是实验信任输入，未得到外部认证。摘要清单没有外部签名，不能单独证明这些文件没有被整体替换。

默认完整运行的实际记录：39/39 符合预期，122 笔已挖交易，15 笔预期回滚交易，44 条业务登记（含 17 条历史导入及 3 条 C13 边界负对照）、6 次重复事件、3 次冲突事件。44 条不是有效维修真实性的计数。

Gas 来自真实 receipt.gasUsed；这证明的是所给合约与编译配置的本地 EVM 执行成本。没有完成基线比较、吞吐量研究、公共网络费用预测或分布式确认时延测量。不要从这一轮直接报告生产部署延迟、费用或去中心化共识性能。

## 六、平台及论文边界

提供者在 Linux、Node.js 24.19.0 实际运行，依赖安装与结果复核通过。你本机 Windows 的实验以本次实际运行结果为准。链配置为 chainId=1337、Shanghai、自动出块；测试账户由 Ganache 的 deterministic 开发钱包生成，使用本地测试余额，不连接真实钱包或公共链。

Ganache 7.9.2 是锁定的归档开发工具，用于复现实验，不代表公共 Ethereum 的客户端、PoS 共识或最终性。C10 是正常关机后的数据库恢复；C11 强制终止的是网关，不是链节点断电。节点崩溃、数据库损坏、分布式重组、多网关并发与真实时间回拨仍需后续实验。

可用论文表述：“我们在本地 EVM 开发链部署登记合约，以真实交易回执核查连续序号、范围约束、配额、重复提交与已观察到的冲突，并测试节点正常重启及网关在交易提交后的故障恢复。Ed25519 验签在受信链下桥接端完成，合约依赖该端正确提交摘要和声明时间；绕过桥接验签的负对照明确展示了这一信任边界。”

## 参考文档

- Node.js 下载：https://nodejs.org/en/download
- ethers 交易与回执：https://docs.ethers.org/v6/single-page/
- Solidity ABI：https://docs.soliditylang.org/en/v0.8.28/abi-spec.html
- Ganache 开发节点与数据库参数：https://archive.trufflesuite.com/docs/ganache/reference/cli-options/

本包提供实际运行结果和可执行源码；不保证论文录用，也不替代生产安全审计。
