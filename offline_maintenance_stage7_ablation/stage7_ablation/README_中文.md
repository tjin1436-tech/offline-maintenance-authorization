# 关键恢复机制消融实验（Stage 7）

## Windows 运行

1. 解压整个 ZIP，进入 `stage7_ablation` 文件夹。不要直接在 ZIP 内运行。
2. 使用上一阶段的 Node.js 24.15.0（也支持更高的 24.x）。
3. 双击 `run_windows.bat`。它会安装锁定依赖、运行 36 组实验、独立审计、执行 5 项篡改负对照并打包结果。
4. 看到 `SUCCESS: Upload stage7_results.zip` 后上传同目录的 `stage7_results.zip`。

已经存在 `stage7_results` 时程序会停止，避免覆盖。再次运行前请将旧目录改名或移到别处。运行中不要关闭窗口。

也可以在本目录打开 CMD 或 PowerShell，依次运行：

```text
npm ci --ignore-scripts --no-audit --no-fund
node run_all.cjs
```

手动压缩命令（CMD 和 PowerShell 均可执行）：

```text
powershell -NoProfile -Command "Compress-Archive -LiteralPath 'stage7_results' -DestinationPath 'stage7_results.zip' -Force"
```

Linux/macOS：在本目录运行相同的 npm 和 node 命令，然后压缩结果目录。更换输出目录：`node run_all.cjs --output another_results`。
默认正式批次为 3 次重复；`--repeats 1` 仅用于调试，不能与 3 次正式批次合并计数。

参考结果见 `RESULTS_中文.md`，原始证据位于 `reference_results_linux`。该目录不作为 Windows 新运行的输出目录。

## 对照设计

| 版本 | 唯一机制差异 |
|---|---|
| full | 保持 Stage 6 完整恢复逻辑，增加三版本共有的观测事件 |
| late_reserve | 将“配额加一 + PENDING 插入”这个事务整体延后至机器人有效回执返回后；执行之前只有临时内存操作信息 |
| retry_pending | 保留执行前事务；恢复时对 PENDING 直接重发同一命令，替代查询回执 |

三个版本共用数据库、签名、串行化、机器人持久化去重、完成事务及登记合约。`late_reserve` 是对执行前持久化预留与意图记录这个组合的消融，不能据此分别归因于计数器或 PENDING 字段。

本包保留 `original_worker.cjs` 和 Stage 6 文件哈希，便于核对变更；原 Stage 6 文件未修改。

每版包含 4 个场景，每场景重复 3 次（共 36 组）；每次使用新数据库、新工单和配额为 1 的新授权。不同重复轮换三个版本顺序。

| 场景 | 实际切点 |
|---|---|
| no_fault | 无故障控制 |
| before_dispatch | 调用机器人之前；full/retry_pending 已持久化预留，late_reserve 尚未持久化 |
| after_effect | 机器人效果和回执已提交、有效响应已到达网关，但网关尚未完成 DONE；late_reserve 此时尚未保存预留 |
| during_done | 网关完成事务已经更新状态、尚未提交；三版此前的预留均已独立提交 |

流程统一为：请求 op1 → 在指定切点强制终止网关并重启 → 恢复一次 → 用同一授权请求不同的 op2 → 重放 op1 → 补传已完成记录。机器人进程不被终止。这里没有假设客户端会先重试丢失响应的 op1，后续不同操作是配额是否跨故障保持的检验。

## 指标与解释

- 配额超用：机器人累计效果数超过该授权配额的数量。
- 重复执行：同一操作标识对应的额外效果数。该模拟器在事务中绑定效果与持久化回执并去重，因此这些实验没有移除执行器端保护；不能用零重复宣称保护没有必要。
- 缺失网关意图的效果：机器人保存了回执，但网关归档中没有对应操作行。与“网关有 PENDING 但尚无完成证据”分别统计。
- 恢复后的 PENDING、原始 op1 完成数、新 op2 准入结果及机器人 execute/receipt 请求数。
- 不把重复 HTTP 请求计作重复执行，也不把后续 op2 成功计作原 op1 已恢复。

`audit_passed` 仅表示归档与结果一致，不表示所有消融版都满足安全约束。程序不会因为消融版出现配额超用就把实测结果排除。

`audit_ablation.cjs` 从关闭后导出的 SQLite 重新计算结果，核对文件哈希、签名、授权与请求绑定、执行回执、进程终止证据和 EVM 交易事件。独立指独立于运行器状态判定，并非外部第三方认证。5 项篡改负对照核验审计能拒绝损坏输入。

## 输出

- `protocol.json`：设计、环境、源文件哈希和适用边界。
- `cases/*/case.json` 与 `gateway.sqlite`、`robot.sqlite`：逐组原始证据。
- `audit.json`、`outcomes.csv`、`summary.md`：复算结果和汇总。
- `process_events.json`、`transactions.json`、`live_check.json`：进程与链上证据。
- `audit_negative_controls.json`：审计负对照。

请上传完整结果 ZIP，而不仅是终端截图。公开密钥用于验证，运行时私钥在临时目录中生成并在结束时清除。

## 结论边界

这是同一主机上的软件故障反例与机制对照，不是实体机器人安全测试、长期稳定性测试或外部系统性能排名。固定切点的 3 次重复用于检验可重复性，不能当成随机故障概率估计或统计显著性证据。

保守 PENDING 可能阻塞未实际执行的请求；在执行器提供可靠持久化去重且授权仍有效时，原标识重试可能改善恢复进度。本实验不注入授权过期、撤销、不可查询的物理动作或执行器丢失去重状态，不能外推到这些条件。

本次提供的 Linux 参考批次与用户 Windows 正式批次必须分别报告，不能合并成更多重复。Stage 7 也不能与 Stage 6 合并称为同一个实验矩阵。
