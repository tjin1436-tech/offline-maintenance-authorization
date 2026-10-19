# 第六阶段：统一持久化原型验证

这一包把第二阶段的恢复语义和第五阶段的HTTP/签名/EVM路径接到同一份网关实现。用于回答：**加入真实持久化预留、独立回执恢复后，所测故障边界是否保持约束，以及同环境的命令开销是多少？**

## 在 Windows / VS Code 中运行

使用 Node.js 24（建议沿用24.15或更新的24.x）。无需Python、实体机器人或手动启动开发链。先打开本文件所在的 `offline_stage6` 文件夹，再依次执行：

也可以使用一条总控命令，按顺序运行、遇到任何失败立即停止：`node run_all.cjs --output stage6_results`（首次仍需先执行`npm ci`）。

```powershell
npm ci
node run_validation.cjs --repeats 3 --soak-seconds 120 --output stage6_results
node audit.cjs --input stage6_results
node test_audit.cjs --input stage6_results
node replay_chain.cjs --input stage6_results
node summarize.cjs --input stage6_results
```

`npm ci`需要下载依赖。若第三/第五阶段已安装依赖，可复制它们完整的node_modules目录，版本仍是ethers 6.13.5、Ganache 7.9.2、solc 0.8.28。本阶段新增使用Node 24内置的node:sqlite。

先确认输出目录不存在或为空。失败结果不要删除或修改；重跑改为新的目录名，例如stage6_results_rerun。原有第一至第五阶段无需重跑。

正式协议为36个故障用例、39次强制终止、9项功能检查、108组性能运行（648次计划命令），再加至少120秒的持续运行观察。总耗时取决于机器；程序会逐用例打印进度。只有运行器、独立审计、5项负对照及新链重放均通过，才可作为本轮完整验证结果。

完成后打包新生成的结果：

```powershell
Compress-Archive -Path .\stage6_results -DestinationPath .\stage6_results.zip
```

上传自己电脑生成的stage6_results.zip。若包内有reference_results，它是提供者环境的参考记录，不能当作Windows本机结果上传。

## 实现与对照

- 网关与机器人模拟器运行在两个独立进程，各有SQLite数据库；授权服务、可信适配器和断网中继运行在控制进程；Ganache另起进程。
- 网关以同一事务增加授权已用次数并插入PENDING，提交后才调用机器人。
- 机器人模拟器用一次事务保存模拟执行计数与带完整命令摘要的签名回执，支持按操作标识查回执和重复请求去重。
- 网关校验回执后签署DONE，补传后收到ACCEPTED或DUPLICATE才保存同步确认。
- 未知回执不自动返还配额，也不自动重发。没有可靠回执时PENDING可永久阻塞同一授权后续请求。
- 所有实验用同一worker.cjs。内存对照只把网关SQLite改为`:memory:`，其他协议及机器人持久化保持一致，因此衡量的是该配置下网关持久化的增量开销，不是第五阶段原实现的直接重跑。
- 正式持久化模式使用DELETE回滚日志及synchronous=FULL。`working_*.sqlite`是实际运行与重启所用文件；`gateway.sqlite`与`robot.sqlite`是关闭后核对状态并逐字节导出的归档副本，未根据JSON重建。

## 固定故障边界

12类场景覆盖预留前、预留事务中、预留后、机器人完成后、DONE事务中、DONE后、链上接受后、本地同步标记后、丢失适配器响应、两条记录的补传续传、机器人持久化回执重启，以及显式时间不可信。

强制终止由父进程实施：Linux为SIGKILL，Windows为TerminateProcess。运行器等待退出后启动新进程重新读取同一工作数据库和测试密钥。U11终止机器人与网关两个进程，其余每个用例终止网关一次。没有把重新创建内存对象称为进程重启。

## 指标口径

命令耗时包括HTTP传输、验签、预留、机器人持久化回执、网关完成签名与落盘；不包括签名前授权准备或恢复后的链上登记。成功与拒绝请求分开保存。先计算每组接受命令中位数，再跨重复汇总。同重复编号中持久化减内存得到配对差；少量重复只作描述性分析。

固定授权4000毫秒；Q90初始授权2000毫秒、上限6000毫秒。断网1500或4500毫秒，五项离线请求计划位于断网0%、20%、40%、60%、80%处；恢复后另发一项。严格在线每项新操作经远端验证，固定/Q90在本地检查原授权期限。所有条件保持机器人本地链路可用。

与第五阶段相比，这里由远端中继直接阻断授权与适配器HTTP路径，合约RPC在适配器之后；未保留原心跳检测性能指标，也不声称复现第五阶段全部调度逻辑。没有实现第四阶段的半寿命主动续签或撤销实验。

## 结果与审计

- protocol.json：运行前固定的协议、软件/硬件环境、关键源文件SHA-256。
- faults.json、faults/*/case.json：预期与观测、故障后快照、恢复操作和最终数据库。
- functional/functional.json：9项功能与竞争检查。
- benchmark.json、benchmark/*/run.json：逐条件签名请求、回复、授权历史、时间及最终状态。
- process_events.json：PID、强制终止、退出、关闭状态摘要及原始数据库导出摘要。
- transactions.json、live_check.json：完整的真实EVM回执与原节点关闭前重查；transactions.jsonl为运行中的追加诊断日志，正式审计使用结束时原子保存的完整transactions.json。
- audit.json：独立签名、哈希链接、请求/回执、数据库与交易交叉核对。
- negative_controls.json：修改统计、签名、配额、回执列表和PENDING状态的5项负对照。
- chain_replay.json：在新开发链重放同一注册与提交调用的结果，不能称为原链重启持久化。
- summary.json、run_metrics.csv、统一原型验证报告.md：审计通过后按统一口径汇总。

运行器只生成一次性测试私钥，正常清理时删除，不写入结果包。若控制进程被外部强杀，临时目录可能残留；这不是生产密钥托管方案。公钥映射属于受信的实验输入。

## 结论边界

本包验证软件模拟器、回环HTTP、可信适配器和本地开发链。不能证明真实动作恰好一次、机械安全、断电/磁盘故障、恶意时间回拨、生产网络最终性、多网关共享配额或长期可靠性。单次120秒观察不能解释或修复此前Windows长运行异常。集中式登记对照仍是另一项待完成实验。

如需快速检查安装，可先运行 `node run_validation.cjs --mode smoke --repeats 1 --soak-seconds 0 --output smoke_results`；smoke包含12个故障用例及6组联网性能运行，不能冒充108组正式矩阵。
